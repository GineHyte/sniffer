// Read-only preflight for one paid end-to-end Sniffer case on Cardano Preprod (T29).
// Prints a PASS/FAIL/WARN table and exits 1 if a required check fails. Writes nothing, pays nothing,
// creates no Sokosumi resources. Env values are never printed: only presence and comparisons.
//   npm run preflight [-- --fixture docs/fixtures/f1.xml --invoice-number RE-2026-0413 --recipient-wallet payee --new-supplier]
import {execFile} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {intakeIds} from '../main/case-store.mjs';
import {INVESTIGATOR_ROLES} from '../investigator/contract.mjs';
import {ROOT,parseArgs,prepareXml,duePayableCents,payoutLovelace,payKeyFor,PAYER_MARGIN_LOVELACE,
 resolveSupplier,supplierLines,supplierLookups,sellerVat,normalizeVat,readRepoJson,VIES_MOCK_FILE} from './demo-case.mjs';

const execFileAsync=promisify(execFile);
export const FEE_MARGIN_LOVELACE=2_000_000n; // fees + min-UTxO change per wallet (payOnce payer, payout/transfer.mjs preflight)
export const MIN_UTXO_LOVELACE=1_000_000n; // a plain ADA output to a base address needs about 0.97 tADA
const ZERO_CHECK_ID='chk_00000000000000000000000000';

/** Env names Main (main/api.mjs loadConfig + main()) needs at startup, plus the Eve model key. */
export const REQUIRED_ENV=Object.freeze([
 ...INVESTIGATOR_ROLES.flatMap(role=>[`COWORKER_ID_${role.toUpperCase()}`,`INVESTIGATOR_${role.toUpperCase()}_URL`,`INVESTIGATOR_${role.toUpperCase()}_PAY_TO`]),
 'INTAKE_PRICE_LOVELACE','INTAKE_PAY_TO','INVESTIGATOR_PRICE_LOVELACE','BLOCKFROST_API_KEY_PREPROD','SNIFFER_API_TOKEN','ADA_PER_EUR','ANTHROPIC_API_KEY',
]);
export const OPTIONAL_ENV=Object.freeze(['SNIFFER_BASE_URL','SOKOSUMI_ORGANIZATION_SLUG','SOKOSUMI_ORGANIZATION_ID','MAIN_PAYER_WALLET','MAIN_EVE_URL','MAIN_PORT',
 'INVESTIGATION_TIMEOUT_MS','PAYOUT_MAX_ADA_PER_INVOICE','PAYOUT_MAX_ADA_PER_DAY','EXPECTED_NETWORK','VIES_MODE']);

/** Minimum balances (lovelace) for one case. */
export function minimums({intakePrice,investigatorPrice,payout}){
 return {
  payer:BigInt(intakePrice)+PAYER_MARGIN_LOVELACE,
  mainPayer:3n*BigInt(investigatorPrice)+FEE_MARGIN_LOVELACE,
  payout:payout===null?null:payout+FEE_MARGIN_LOVELACE,
 };
}

export const formatAda=lovelace=>{const value=BigInt(lovelace);return `${value/1000000n}.${String(value%1000000n).padStart(6,'0')}`;};

/** Renders rows {status, required, name, detail} as a fixed-width table. */
export function formatTable(rows){
 const head=['STATUS','REQ','CHECK','DETAIL'];
 const cells=rows.map(row=>[row.status,row.required?'yes':'no',row.name,row.detail??'']);
 const width=[0,1,2].map(i=>Math.max(head[i].length,...cells.map(cell=>cell[i].length)));
 const line=cell=>cell.map((value,i)=>i<3?value.padEnd(width[i]):value).join('  ').trimEnd();
 return [line(head),line(width.map(n=>'-'.repeat(n)).concat('------')),...cells.map(line)].join('\n');
}

export const requiredFailed=rows=>rows.some(row=>row.required&&row.status==='FAIL');

/** Row for the submitted seller's history: a fresh supplier fires S-9 and keeps f1 at medium (investigators). */
export function supplierFreshRow(vat,history,{viesValid=true}={}){
 const name='fixture: supplier fresh (S-9)';
 if(!vat)return {name,ok:false,warn:true,detail:'no seller VAT ID (BT-31) in the fixture'};
 const vies=viesValid?'':`; ${vat} is not valid in ${VIES_MOCK_FILE}: S-2 (+35) fires with VIES_MODE=mock`;
 if(history?.status===404)return {name,ok:viesValid,warn:true,detail:`${vat} has no invoice in the backend: S-9 fires, expect medium (investigators)${vies}`};
 if(history?.status===200)return {name,ok:false,warn:true,detail:`${vat} already has invoices (approved_count ${history.body?.approved_count??'?'}): S-9 does not fire, f1 scores 15 -> low -> auto-approved without investigators. For a medium case add --new-supplier${vies}`};
 return {name,ok:false,warn:true,detail:`supplier history of ${vat} unknown (${history?.error??`HTTP ${history?.status||'none'}`})${vies}`};
}

/** Running investigator workers by role, from `ps -eo command` output. */
export function workersRunning(psOutput){
 const lines=String(psOutput).split('\n');
 return Object.fromEntries(INVESTIGATOR_ROLES.map(role=>[role,lines.filter(line=>new RegExp(`investigator/worker\\.mjs\\s+${role}(\\s|$)`).test(line)&&!/\bgrep\b/.test(line)).length]));
}

// Reads one non-secret env value of the container that publishes the backend port. Never prints anything.
async function containerEnv(name,{port='8080'}={}){
 try{
  const {stdout}=await execFileAsync('docker',['ps','--filter',`publish=${port}`,'--format','{{.Names}}'],{encoding:'utf8',timeout:10_000});
  const container=stdout.split('\n').map(line=>line.trim()).find(Boolean);
  if(!container)return {known:false};
  try{const {stdout:value}=await execFileAsync('docker',['exec',container,'printenv',name],{encoding:'utf8',timeout:10_000});return {known:true,container,value:value.trim()};}
  catch(error){return error.code===1?{known:true,container,value:''}:{known:false};}
 }catch{return {known:false};}
}

async function probe(url,{timeoutMs=5000}={}){
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});
  let body=null;try{body=await response.json();}catch{}
  return {status:response.status,body};
 }catch(error){return {status:0,error:error?.cause?.code??error?.name??'error'};}
}

export async function runChecks(argv,env=process.env){
 const rows=[];
 const add=(name,ok,detail,{required=true,warn=false}={})=>rows.push({name,required,status:ok?'PASS':warn?'WARN':'FAIL',detail});
 const options=parseArgs(argv,env);
 const url=(name,fallback)=>(env[name]?.trim()||fallback).replace(/\/+$/,'');

 // Env presence (booleans only) and Main's own validation (its messages name variables, never values).
 const missing=REQUIRED_ENV.filter(name=>!env[name]?.trim());
 add('env: required variables',!missing.length,missing.length?`missing: ${missing.join(', ')}`:`${REQUIRED_ENV.length}/${REQUIRED_ENV.length} set`);
 const unset=OPTIONAL_ENV.filter(name=>!env[name]?.trim());
 add('env: optional variables',true,unset.length?`unset (defaults apply): ${unset.join(', ')}`:'all set',{required:false});
 let config=null;
 try{const {loadConfig}=await import('../main/api.mjs');config=loadConfig(env);add('env: Main loadConfig()',true,`port ${config.port}, payer wallet ${config.payerWallet}, investigation timeout ${config.investigationTimeoutMs} ms`);}
 catch(error){add('env: Main loadConfig()',false,error.message);}
 if(env.EXPECTED_NETWORK?.trim())add('env: EXPECTED_NETWORK is preprod',env.EXPECTED_NETWORK.trim()==='preprod','payout/transfer.mjs refuses any other network');
 for(const role of INVESTIGATOR_ROLES){
  const key=role.toUpperCase();
  const price=env[`INVESTIGATOR_${key}_PRICE_LOVELACE`]?.trim()||env.INVESTIGATOR_PRICE_LOVELACE?.trim();
  const cap=env.INVESTIGATOR_PRICE_LOVELACE?.trim();
  const ok=/^[1-9][0-9]*$/.test(price??'')&&/^[1-9][0-9]*$/.test(cap??'')&&BigInt(price)<=BigInt(cap);
  add(`env: ${role} investigator price <= Main cap`,ok,ok?`${formatAda(price)} <= ${formatAda(cap)} tADA`:'price or INVESTIGATOR_PRICE_LOVELACE missing, or price above the cap');
 }

 // Fixture: case id, payout amount, VIES mode needed to reach the investigators.
 let xml=null;let payout=null;
 try{
  const {walletAddress}=await import('../x402/wallets.mjs');
  const raw=readFileSync(resolve(ROOT,options.fixture),'utf8');
  const base={invoiceNumber:options.invoiceNumber,recipientAddress:options.recipientWallet?walletAddress(options.recipientWallet):null};
  const xmlFor=rewrite=>prepareXml(raw,{...base,...rewrite});
  const lookups=supplierLookups(env,{mainUrl:options.mainUrl,journalDir:env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo')});
  let supplier=null;
  try{supplier=await resolveSupplier(options,{xmlFor,lookups});if(supplier)add('fixture: supplier rewrite',true,supplierLines(supplier).join('; '));}
  catch(error){add('fixture: supplier rewrite',false,error.message);}
  xml=xmlFor(supplier?.rewrite??{});
  payout=payoutLovelace(duePayableCents(xml),env.ADA_PER_EUR);
  const {caseId}=intakeIds(xml);
  add('fixture',true,`${options.fixture}${options.invoiceNumber?` as ${options.invoiceNumber}`:''}${supplier?.vat?` from ${supplier.vat}`:''} -> ${caseId}`,{required:false});
  if(!supplier?.vat){
   const vat=sellerVat(xml);
   let history=null;
   try{history=vat?await lookups.history(vat):null;}catch(error){history={status:0,error:error.message.split('.')[0]};}
   let viesValid=true;try{viesValid=readRepoJson(VIES_MOCK_FILE)[normalizeVat(vat??'')]===true;}catch{}
   const row=supplierFreshRow(vat,history,{viesValid});
   add(row.name,row.ok,row.detail,{required:false,warn:row.warn});
  }
  add('fixture: payout >= min UTxO',payout!==null&&payout>=MIN_UTXO_LOVELACE,payout===null?'DuePayableAmount or ADA_PER_EUR unreadable':`${formatAda(payout)} tADA at ADA_PER_EUR (approved cases only)`);
  const caseFile=join(env.MAIN_STATE_DIR?.trim()||join(ROOT,'.local','main'),'cases',caseId,'case.json');
  const payFile=join(env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo'),`pay-${payKeyFor(caseId)}.json`);
  const seen=[existsSync(caseFile)&&'Main case journal',existsSync(payFile)&&'demo payment journal'].filter(Boolean);
  add('fixture: fresh case',!seen.length,seen.length?`${seen.join(' and ')} exist: npm run demo resumes this case; pass --invoice-number for a new one`:'no earlier case for this XML',{required:false,warn:true});
 }catch(error){add('fixture',false,error.message);}
 // The running backend container is what counts; the env files only take effect after a restart.
 const fileVies=env.VIES_MODE?.trim()||'api';
 const runningVies=await containerEnv('VIES_MODE');
 const vies=runningVies.known?runningVies.value||'api':fileVies;
 const source=runningVies.known?`running backend container ${runningVies.container}`:'env files (docker not readable)';
 add('backend: VIES_MODE=mock',vies==='mock',vies==='mock'?`${source}: fixture VAT IDs count as valid`:`${source}: VIES_MODE=${vies}${runningVies.known&&fileVies!==vies?` (env files say ${fileVies}; restart the backend: npm run stack)`:''}. Live VIES rejects the fixture VAT IDs, S-2 adds 35 points, f1 scores 70 -> high -> DONT_PAY without investigators. Set VIES_MODE=mock in .local/live.env and restart the backend (npm run stack)`);

 // Services.
 const base=url('SNIFFER_BASE_URL','http://127.0.0.1:8080');
 const health=await probe(`${base}/health`);
 add('service: backend /health',health.status===200,`${base} HTTP ${health.status||health.error}`);
 if(env.SNIFFER_API_TOKEN?.trim()){
  let status=0;
  try{status=(await fetch(`${base}/v1/checks/${ZERO_CHECK_ID}`,{headers:{authorization:`Bearer ${env.SNIFFER_API_TOKEN.trim()}`},signal:AbortSignal.timeout(5000)})).status;}catch{}
  add('service: backend accepts SNIFFER_API_TOKEN',status===404,`GET /v1/checks/<unknown> HTTP ${status||'none'} (404 = token accepted)`);
 }
 for(const role of [...INVESTIGATOR_ROLES,'main']){
  // Main talks to MAIN_EVE_URL, else EVE_URL (main/api.mjs loadConfig).
  const eve=role==='main'?url('MAIN_EVE_URL',env.EVE_URL?.trim()||''):url(`EVE_URL_${role.toUpperCase()}`,'');
  if(!eve){add(`service: Eve ${role}`,false,`${role==='main'?'MAIN_EVE_URL / EVE_URL':`EVE_URL_${role.toUpperCase()}`} not set`);continue;}
  const result=await probe(`${eve}/`);
  add(`service: Eve ${role}`,result.status>0&&result.status<500,`${eve} HTTP ${result.status||result.error}`);
 }
 for(const role of INVESTIGATOR_ROLES){
  const api=url(`INVESTIGATOR_${role.toUpperCase()}_URL`,'');
  if(!api){add(`service: investigator ${role} API`,false,`INVESTIGATOR_${role.toUpperCase()}_URL not set`);continue;}
  const result=await probe(`${api}/health`);
  add(`service: investigator ${role} API`,result.status===200&&result.body?.role===role,`${api}/health HTTP ${result.status||result.error}${result.body?.role&&result.body.role!==role?` (role ${result.body.role})`:''}`);
 }
 const mainUrl=options.mainUrl;
 const mainHealth=await probe(`${mainUrl}/health`);
 add('service: Main API /health',mainHealth.status===200,mainHealth.status===200?mainUrl:`${mainUrl} not running (start: npm run main -- --confirm-live-payments)`,{required:false,warn:true});
 try{
  const {stdout}=await execFileAsync('ps',['-eo','command'],{encoding:'utf8',maxBuffer:8*1024*1024});
  const running=workersRunning(stdout);
  for(const role of INVESTIGATOR_ROLES)add(`service: investigator ${role} worker`,running[role]>=1,running[role]>=1?`running (${running[role]} process${running[role]>1?'es':''})`:`not running: npm run investigator:worker -- ${role}`);
 }catch(error){add('service: investigator workers',false,`ps failed: ${error.code??error.message}`);}

 // Sokosumi (read-only).
 try{
  const {sokosumi}=await import('../sokosumi-cli.mjs');
  const status=await sokosumi(['auth','status']);
  const expires=Date.parse(status?.expiresAt??'');
  const minutes=Number.isFinite(expires)?Math.round((expires-Date.now())/60_000):null;
  add('sokosumi: auth status (preprod)',status?.authenticated===true,status?.authenticated===true?`authenticated${status.apiKeyAvailable?' (API key)':''}`:'not authenticated: sokosumi --preprod auth login');
  if(status?.authenticated===true&&minutes!==null)add('sokosumi: session lifetime',minutes>45,`expires in ${minutes} min${minutes<=45?'; one case can take ~35 min, log in again if the CLI does not refresh':''}`,{required:false,warn:true});
 }catch(error){add('sokosumi: auth status (preprod)',false,String(error?.message).slice(0,160));}

 // Wallets.
 const intakePrice=env.INTAKE_PRICE_LOVELACE?.trim();
 const investigatorPrice=env.INVESTIGATOR_PRICE_LOVELACE?.trim();
 const priceOk=/^[1-9][0-9]*$/.test(intakePrice??'')&&/^[1-9][0-9]*$/.test(investigatorPrice??'');
 const need=priceOk?minimums({intakePrice,investigatorPrice,payout}):null;
 let wallets=null;
 try{wallets=await import('../x402/wallets.mjs');}catch(error){add('wallets',false,error.message);}
 const balanceRow=async(name,address,min,{required=true,label=name}={})=>{
  try{
   const balance=await wallets.fetchBalance(address);
   const ok=min===null?true:balance.lovelace>=min;
   const shortBy=min!==null&&!ok?`, fund at least ${formatAda(min-balance.lovelace)} tADA more`:'';
   add(`wallet: ${label}`,ok,`${formatAda(balance.lovelace)} tADA${min!==null?` (need >= ${formatAda(min)})`:''}${shortBy} ${address}`,{required});
  }catch(error){add(`wallet: ${label}`,false,error.message,{required});}
 };
 if(wallets&&need){
  const addressOf=name=>{try{return wallets.walletAddress(name);}catch(error){add(`wallet: ${name}`,false,error.message);return null;}};
  const payer=addressOf(options.wallet);
  if(payer)await balanceRow(options.wallet,payer,need.payer,{label:`${options.wallet} (customer, intake)`});
  const mainPayerName=config?.payerWallet??env.MAIN_PAYER_WALLET?.trim()??'main-payer';
  const mainPayer=addressOf(mainPayerName);
  if(mainPayer)await balanceRow(mainPayerName,mainPayer,need.mainPayer,{label:`${mainPayerName} (Main pays 3 investigators)`});
  try{
   const payoutModule=await import('../payout/transfer.mjs');
   const {mnemonic,accountIndex}=payoutModule.loadPayoutSecrets();
   const address=await payoutModule.createEvolutionSigner({mnemonic,accountIndex,projectId:env.BLOCKFROST_API_KEY_PREPROD||'unused-offline'}).address();
   await balanceRow('payout',address,need.payout,{label:'payout (supplier payout if approved)'});
  }catch(error){add('wallet: payout (supplier payout if approved)',false,String(error?.message).slice(0,200));}
  const intake=env.INTAKE_PAY_TO?.trim();
  if(intake)await balanceRow('intake',intake,null,{required:false,label:'intake (receives only)'});
 }else if(!need)add('wallets: minimums',false,'INTAKE_PRICE_LOVELACE or INVESTIGATOR_PRICE_LOVELACE missing');
 return rows;
}

export async function main(argv){
 const rows=await runChecks(argv);
 process.stdout.write(`${formatTable(rows)}\n`);
 const failed=requiredFailed(rows);
 process.stdout.write(failed?`\nPreflight FAILED: fix the required FAIL rows before npm run demo.\n`:`\nPreflight passed.\n`);
 if(failed)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
