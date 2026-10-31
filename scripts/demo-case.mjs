// Test customer for one paid end-to-end Sniffer case on Cardano Preprod (T29).
// Pays the Main intake (POST /v1/invoices, x402 gate) from the `payer` wallet with payOnce, then polls
// GET /v1/cases/{id} until the case is completed, failed or needs inspection, and prints the decision.
// Run only with explicit user approval (Main must be running: npm run main -- --confirm-live-payments):
//   npm run demo -- --confirm-live-payment [--fixture docs/fixtures/f1.xml] [--invoice-number RE-2026-0413] [--recipient-wallet payee]
// Poll an existing case without paying: npm run demo -- --case case-<32 hex>
// One payment per submitted XML: the payOnce key is derived from the XML hash, so a rerun returns the earlier
// payment and only polls. Use --invoice-number for a new case (the backend rejects an exact duplicate with KO-3).
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {intakeIds,CASE_ID_RE,TERMINAL_STATUSES} from '../main/case-store.mjs';

export const CONFIRM_FLAG='--confirm-live-payment';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const DEFAULT_FIXTURE='docs/fixtures/f1.xml';
export const DEFAULT_WALLET='payer';
export const DEFAULT_TIMEOUT_MS=45*60_000; // investigation 15 min + Main LLM 5 min + payout confirm 10 min + payments
export const DEFAULT_POLL_MS=15_000;
export const PAYER_MARGIN_LOVELACE=2_000_000n; // fee + min-UTxO change above the intake price
const INVOICE_NUMBER_RE=/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
const ADDRESS_RE=/^addr_test1[0-9a-z]{20,}$/;
const EXPLORER='https://preprod.cardanoscan.io/transaction/';

export const USAGE=`Usage:
  npm run demo -- ${CONFIRM_FLAG} [options]   pay the intake once and follow the case
  npm run demo -- --case <case_id>             follow an existing case (no payment)
Options:
  --fixture <path>            invoice XML (default ${DEFAULT_FIXTURE})
  --invoice-number <id>       replace the invoice number (BT-1 and payment reference) for a fresh case
  --recipient-wallet <name>   replace the payment address (BT-84) with this x402 wallet's address
  --wallet <name>             paying x402 wallet (default ${DEFAULT_WALLET})
  --main-url <url>            Main API (default http://127.0.0.1:$MAIN_PORT or :21951)
  --timeout-ms <n>            polling timeout (default ${DEFAULT_TIMEOUT_MS})
  --poll-ms <n>               polling interval (default ${DEFAULT_POLL_MS})`;

const VALUE_FLAGS={'--fixture':'fixture','--invoice-number':'invoiceNumber','--recipient-wallet':'recipientWallet','--wallet':'wallet','--main-url':'mainUrl',
 '--timeout-ms':'timeoutMs','--poll-ms':'pollMs','--case':'caseId'};

/** Parses CLI arguments. Throws on unknown flags, missing values and invalid values. */
export function parseArgs(argv,env={}){
 const options={confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:DEFAULT_WALLET,
  mainUrl:`http://127.0.0.1:${env.MAIN_PORT?.trim()||21951}`,timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg===CONFIRM_FLAG){options.confirm=true;continue;}
  if(arg==='--help'||arg==='-h'){options.help=true;continue;}
  const key=VALUE_FLAGS[arg];
  if(!key)throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  const value=argv[++i];
  if(value===undefined||value.startsWith('--'))throw new Error(`${arg} needs a value.`);
  options[key]=value;
 }
 for(const key of ['timeoutMs','pollMs']){
  const value=String(options[key]);
  if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(`--${key==='timeoutMs'?'timeout-ms':'poll-ms'} must be a positive integer.`);
  options[key]=Number(value);
 }
 if(options.caseId!==null&&!CASE_ID_RE.test(options.caseId))throw new Error('--case must be case-<32 hex>.');
 if(options.invoiceNumber!==null&&!INVOICE_NUMBER_RE.test(options.invoiceNumber))throw new Error('--invoice-number must be 1-64 characters [A-Za-z0-9._/-].');
 for(const key of ['wallet','recipientWallet'])if(options[key]!==null&&!/^[a-z][a-z0-9-]{0,31}$/.test(options[key]))throw new Error(`--${key==='wallet'?'wallet':'recipient-wallet'} must be an x402 wallet name.`);
 if(!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(options.mainUrl))throw new Error('--main-url must be an http(s) URL.');
 options.mainUrl=options.mainUrl.replace(/\/+$/,'');
 return options;
}

/** The pay path needs the explicit flag; following an existing case does not pay and needs none. */
export function assertConfirmed(options){
 if(options.caseId||options.confirm)return;
 throw new Error(`Refusing to run: this pays the Sniffer intake with real Preprod tADA and starts a case that pays 3 investigators and possibly a supplier. Re-run with ${CONFIRM_FLAG} only after user approval.`);
}

/** Returns the XML to submit: the fixture, optionally with a new invoice number and/or payment address. Pure. */
export function prepareXml(xml,{invoiceNumber=null,recipientAddress=null}={}){
 if(typeof xml!=='string'||!xml.includes('<rsm:CrossIndustryInvoice'))throw new Error('Fixture is not a CII invoice.');
 let out=xml;
 if(invoiceNumber!==null){
  if(!INVOICE_NUMBER_RE.test(invoiceNumber))throw new Error('Invalid invoice number.');
  const match=/<rsm:ExchangedDocument>\s*<ram:ID>([^<]+)<\/ram:ID>/.exec(out);
  if(!match)throw new Error('Fixture has no invoice number (BT-1).');
  const old=match[1];
  out=out.split(`<ram:ID>${old}</ram:ID>`).join(`<ram:ID>${invoiceNumber}</ram:ID>`)
   .split(`<ram:PaymentReference>${old}</ram:PaymentReference>`).join(`<ram:PaymentReference>${invoiceNumber}</ram:PaymentReference>`);
 }
 if(recipientAddress!==null){
  if(!ADDRESS_RE.test(recipientAddress))throw new Error('Recipient must be a Preprod addr_test1… address.');
  const re=/(<ram:PayeePartyCreditorFinancialAccount>\s*<ram:ProprietaryID>)[^<]*(<\/ram:ProprietaryID>)/;
  if(!re.test(out))throw new Error('Fixture has no payment address (BT-84).');
  out=out.replace(re,`$1${recipientAddress}$2`);
 }
 return out;
}

/** Due amount in EUR cents from the fixture (BT-115), or null. */
export function duePayableCents(xml){
 const match=/<ram:DuePayableAmount[^>]*>\s*([0-9]+)(?:\.([0-9]{1,2}))?\s*</.exec(xml);
 return match?BigInt(match[1])*100n+BigInt((match[2]??'0').padEnd(2,'0')):null;
}

/** Supplier payout in lovelace as the backend computes it: floor(amount_eur * ADA_PER_EUR * 1e6). */
export function payoutLovelace(cents,adaPerEur){
 if(cents===null||typeof adaPerEur!=='string'||!/^[0-9]+(\.[0-9]{1,6})?$/.test(adaPerEur.trim()))return null;
 const [whole,frac='']=adaPerEur.trim().split('.');
 const micro=BigInt(whole)*1_000_000n+BigInt(frac.padEnd(6,'0')); // ADA per EUR in micro-ADA (= lovelace per EUR)
 return cents*micro/100n;
}

export const payKeyFor=caseId=>`intake-${caseId}`;

/** case_id from the 202 body payOnce keeps in its journal. */
export function caseIdFromJournal(journal){
 try{const body=JSON.parse(journal?.response?.body??'');return typeof body?.case_id==='string'&&CASE_ID_RE.test(body.case_id)?body.case_id:null;}catch{return null;}
}

/**
 * Polls fetchCase(caseId) until a terminal status or the deadline. Network errors and 5xx are retried until the deadline;
 * 404 stops at once (the case is created before the 202, so it should always exist).
 * @param {object} options {caseId, fetchCase:(id)=>Promise<{status:number,body:any}>, timeoutMs, pollMs, clock:{now,sleep}, onUpdate}
 * @returns {Promise<{done:boolean,view:object|null,timedOut:boolean}>}
 */
export async function pollCase({caseId,fetchCase,timeoutMs,pollMs,clock,onUpdate=()=>{}}){
 const deadline=clock.now()+timeoutMs;
 let view=null;
 for(;;){
  let result;
  try{result=await fetchCase(caseId);}catch(error){result={status:0,error};}
  if(result.status===200&&result.body&&typeof result.body==='object'){
   view=result.body;
   onUpdate({type:'view',view});
   if(TERMINAL_STATUSES.has(view.status))return {done:true,view,timedOut:false};
  }else if(result.status===404){
   throw new Error(`Case ${caseId} not found at the Main API. Check --main-url and MAIN_STATE_DIR.`);
  }else onUpdate({type:'error',status:result.status,error:result.error});
  const now=clock.now();
  if(now>=deadline)return {done:false,view,timedOut:true};
  await clock.sleep(Math.max(1,Math.min(pollMs,deadline-now)));
 }
}

/** One status line per change (status, investigators, decision, payout). */
export function progressLine(view){
 const inv=view.investigators?Object.entries(view.investigators).map(([role,entry])=>`${role}:${entry.payment??'-'}/${entry.report??'-'}${entry.verdict?`(${entry.verdict})`:''}`).join(' '):'';
 return [`status=${view.status}`,view.band?`band=${view.band}`:'',view.risk_score!==null&&view.risk_score!==undefined?`score=${view.risk_score}`:'',inv,
  view.decision?`decision=${view.decision.decision}/${view.decision.final_decision}`:'',view.payout?`payout=${view.payout.phase}${view.payout.state?`/${view.payout.state}`:''}`:'',
  view.inspection?`inspection=${view.inspection.code}`:''].filter(Boolean).join(' ');
}

const systemClock={now:()=>Date.now(),sleep:ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms))};
const out=line=>process.stdout.write(`${line}\n`);

async function getJson(url,{timeoutMs=20_000}={}){
 const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
 let body=null;try{body=await response.json();}catch{}
 return {status:response.status,body};
}

async function follow(options,caseId){
 out(`Case ${caseId}: ${options.mainUrl}/v1/cases/${caseId}`);
 let last='';
 const result=await pollCase({caseId,timeoutMs:options.timeoutMs,pollMs:options.pollMs,clock:systemClock,
  fetchCase:id=>getJson(`${options.mainUrl}/v1/cases/${id}`),
  onUpdate:event=>{
   if(event.type==='view'){const line=progressLine(event.view);if(line!==last){out(`[${new Date().toISOString()}] ${line}`);last=line;}}
   else out(`[${new Date().toISOString()}] Main API not answering (HTTP ${event.status||'none'}); retrying`);
  }});
 if(result.view){
  out(JSON.stringify(result.view,null,1));
  for(const [role,entry] of Object.entries(result.view.investigators??{}))if(entry.payment_tx_hash)out(`${role} payment: ${EXPLORER}${entry.payment_tx_hash}`);
  if(result.view.payout?.tx_hash)out(`Supplier payout: ${EXPLORER}${result.view.payout.tx_hash}`);
 }
 if(result.timedOut)throw new Error(`Case ${caseId} is not finished after ${options.timeoutMs} ms. Follow it later with: npm run demo -- --case ${caseId}`);
 if(result.view.status!=='completed')throw new Error(`Case ${caseId} ended with status ${result.view.status}${result.view.inspection?` (${result.view.inspection.code})`:''}. Inspect .local/main/cases/${caseId}/case.json.`);
 out(`Decision: ${result.view.decision?.decision??'none'} (${result.view.decision?.final_decision??'-'}, decided by ${result.view.decision?.decided_by??'-'})`);
}

async function payIntake(options){
 const env=process.env;
 const [{payOnce,lovelaceString,readPayJournal,payJournalPath},{readWallet,walletAddress,fetchBalance,formatAda,NETWORK},{blockfrostProvider},{toClientCardanoSigner}]=await Promise.all([
  import('../x402/pay.mjs'),import('../x402/wallets.mjs'),import('../x402/facilitator.mjs'),import('@x402/cardano')]);
 const price=lovelaceString(env.INTAKE_PRICE_LOVELACE?.trim(),'INTAKE_PRICE_LOVELACE');
 const payTo=env.INTAKE_PAY_TO?.trim();
 if(!payTo||!ADDRESS_RE.test(payTo))throw new Error('INTAKE_PAY_TO is not set to a Preprod address. Run with: npm run demo (loads .local/live.env).');
 const projectId=env.BLOCKFROST_API_KEY_PREPROD;
 const fixturePath=resolve(ROOT,options.fixture);
 const xml=prepareXml(readFileSync(fixturePath,'utf8'),{invoiceNumber:options.invoiceNumber,recipientAddress:options.recipientWallet?walletAddress(options.recipientWallet):null});
 const {caseId}=intakeIds(xml);
 const key=payKeyFor(caseId);
 const journalDir=env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo');
 out(`Fixture ${options.fixture}${options.invoiceNumber?` as ${options.invoiceNumber}`:''}${options.recipientWallet?` paying ${options.recipientWallet}`:''} -> ${caseId}`);

 const health=await getJson(`${options.mainUrl}/health`,{timeoutMs:5000}).catch(()=>({status:0}));
 if(health.status!==200)throw new Error(`Main API is not healthy at ${options.mainUrl} (HTTP ${health.status||'none'}). Start it with: npm run main -- --confirm-live-payments`);

 const earlier=readPayJournal(payJournalPath(journalDir,key));
 const wallet=readWallet(options.wallet);
 if(!earlier){
  const balance=await fetchBalance(wallet.address,{projectId});
  const need=BigInt(price)+PAYER_MARGIN_LOVELACE;
  if(!balance.used||balance.lovelace<need)throw new Error(`Wallet ${options.wallet} has ${formatAda(balance.lovelace)} tADA; the intake needs at least ${formatAda(need)} tADA.`);
  out(`Paying ${formatAda(price)} tADA from ${options.wallet} (balance ${formatAda(balance.lovelace)} tADA) to the intake ...`);
 }else out(`Payment journal exists (phase ${earlier.phase}); payOnce returns it or refuses for inspection.`);
 const signer=toClientCardanoSigner({mnemonic:wallet.mnemonic,network:NETWORK,provider:blockfrostProvider(projectId)});
 if(signer.getAddress()!==wallet.address)throw new Error(`Signer address does not match wallet ${options.wallet}.`);
 const journal=await payOnce({url:`${options.mainUrl}/v1/invoices`,key,journalDir,signer,payTo,maxLovelace:price,
  init:{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({xml})}});
 out(`Intake ${journal.phase}${journal.paymentMade===false?' (no new payment)':''}${journal.txHash?`: ${EXPLORER}${journal.txHash}`:''}`);
 const fromBody=caseIdFromJournal(journal);
 if(fromBody&&fromBody!==caseId)out(`Warning: Main answered case ${fromBody}, expected ${caseId}; following Main's case.`);
 return fromBody??caseId;
}

export async function main(argv){
 const options=parseArgs(argv,process.env);
 if(options.help){out(USAGE);return;}
 assertConfirmed(options);
 const caseId=options.caseId??await payIntake(options);
 await follow(options,caseId);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
