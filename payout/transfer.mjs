// Policy-gated Preprod ADA payout (Task 27, spec §12).
// The backend authorizes and confirms; this module only signs and submits for an `authorized` intent.
// Never resubmits: any doubt after `submitting` stops with manual inspection steps.
// Never logs the mnemonic, the Blockfrost project ID or the raw to_address.
import {openSync,writeFileSync,closeSync,readFileSync,mkdirSync,renameSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import * as evolution from '@evolution-sdk/evolution';

export const NETWORK='preprod';
export const BLOCKFROST_PREPROD_URL='https://cardano-preprod.blockfrost.io/api/v0';
export const STATES=['authorized','submitting','submitted','confirmed','failed','unknown'];
export const CONFIRM_FLAG='--confirm-live-payout';
export const DEFAULT_MAX_ADA_PER_INVOICE=50;
export const DEFAULT_TTL_MS=15*60_000;
export const DEFAULT_POLL_INTERVAL_MS=20_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS=10*60_000;
const FEE_MARGIN_LOVELACE=2_000_000n;
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SCRIPT='node --env-file=.env payout/transfer.mjs';
const ULID='[0-9A-HJKMNP-TV-Z]{26}';
const CHECK_ID_RE=new RegExp(`^chk_${ULID}$`);
const PAYOUT_ID_RE=new RegExp(`^pay_${ULID}$`);
const TX_HASH_RE=/^[0-9a-f]{64}$/;
const ADDRESS_RE=/\b(?:addr|addr_test|stake|stake_test)1[0-9a-z]{20,}\b/g;

export class PayoutError extends Error{
 constructor(message,{code='payout_error',payoutId=null,state=null,txHash=null,status=null,manual=false}={}){
  super(message);this.name='PayoutError';Object.assign(this,{code,payoutId,state,txHash,status,manual});
 }
}
export class BackendError extends Error{
 constructor(message,{status,code}){super(message);this.name='BackendError';this.status=status;this.code=code;}
}

// Removes the given secrets and every bech32 address from free text (SDK errors echo their input).
export function redact(text,secrets=[]){
 let out=String(text??'');
 for(const secret of secrets)if(typeof secret==='string'&&secret.length>=8)out=out.split(secret).join('[redacted]');
 return out.replace(ADDRESS_RE,'[address]');
}
export function normalizeMnemonic(mnemonic){return String(mnemonic??'').trim().replace(/\s+/g,' ').toLowerCase();}
export function assertCheckId(id){if(typeof id!=='string'||!CHECK_ID_RE.test(id))throw new PayoutError('check_id must be chk_ + ULID.',{code:'invalid_check_id'});return id;}
export function assertPayoutId(id){if(typeof id!=='string'||!PAYOUT_ID_RE.test(id))throw new PayoutError('payout_id must be pay_ + ULID.',{code:'invalid_payout_id'});return id;}
export function assertTxHash(hash){if(typeof hash!=='string'||!TX_HASH_RE.test(hash))throw new PayoutError('tx_hash must be 64 lowercase hex characters.',{code:'invalid_tx_hash'});return hash;}

// Fixed network guard: Preprod only. EXPECTED_NETWORK, when set, must agree.
export function assertPreprodEnv(env=process.env){
 const value=env.EXPECTED_NETWORK;
 if(value!==undefined&&value!==''&&value!==NETWORK)throw new PayoutError(`Payouts run on ${NETWORK} only (EXPECTED_NETWORK=${String(value).slice(0,16)}).`,{code:'network_not_allowed'});
}
// Never echoes the address: Evolution's parse errors quote their input.
export function assertPreprodAddress(address,sdk=evolution){
 let ok=false;
 if(typeof address==='string'&&address.startsWith('addr_test1')){try{ok=sdk.Address.getNetworkId(sdk.Address.fromBech32(address))===0}catch{ok=false}}
 if(!ok)throw new PayoutError('to_address is not a valid Preprod (network id 0) address.',{code:'network_not_allowed'});
 return address;
}

// Intent view per spec §12.4. Throws on anything unexpected; a missing state is never read as `authorized`.
export function parseIntent(body){
 if(!body||typeof body!=='object')throw new PayoutError('Backend returned no intent object.',{code:'invalid_response'});
 const payoutId=assertPayoutId(body.payout_id);
 if(!STATES.includes(body.state))throw new PayoutError(`Backend intent ${payoutId} has no known state.`,{code:'invalid_response',payoutId});
 if(!Number.isSafeInteger(body.lovelace)||body.lovelace<=0)throw new PayoutError(`Backend intent ${payoutId} has an invalid lovelace amount.`,{code:'invalid_response',payoutId});
 if(body.tx_hash!==null&&body.tx_hash!==undefined)assertTxHash(body.tx_hash);
 return {payoutId,state:body.state,lovelace:BigInt(body.lovelace),toAddress:typeof body.to_address==='string'?body.to_address:null,txHash:body.tx_hash??null};
}

// Bearer-authenticated client for §12.4/12.5. Error bodies are {error, message} (FR-09); only `error` is kept.
export function createBackendClient({baseUrl=process.env.SNIFFER_BASE_URL||'http://127.0.0.1:8080',token=process.env.SNIFFER_API_TOKEN,fetchImpl=fetch,timeoutMs=20_000}={}){
 if(!token)throw new PayoutError('SNIFFER_API_TOKEN is not set. Run with: node --env-file=.env ...',{code:'config_missing'});
 const base=String(baseUrl).replace(/\/+$/,'');
 async function call(label,path,body){
  let response;
  try{
   response=await fetchImpl(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body??{}),signal:AbortSignal.timeout(timeoutMs)});
  }catch(error){throw new BackendError(`Backend ${label} request failed (${error?.name||'Error'}).`,{status:0,code:'network_error'});}
  let parsed=null;
  try{parsed=JSON.parse(await response.text())}catch{parsed=null}
  if(response.ok){
   if(!parsed||typeof parsed!=='object')throw new BackendError(`Backend ${label} returned invalid JSON.`,{status:response.status,code:'invalid_response'});
   return parsed;
  }
  const code=typeof parsed?.error==='string'&&/^[a-z_]{1,64}$/.test(parsed.error)?parsed.error:'http_error';
  throw new BackendError(`Backend ${label} returned HTTP ${response.status} ${code}.`,{status:response.status,code});
 }
 const intentPath=(id,action)=>`/v1/payouts/${encodeURIComponent(assertPayoutId(id))}/${action}`;
 return {
  authorize:async checkId=>call('authorize','/v1/payouts/authorize',{check_id:assertCheckId(checkId)}),
  submitting:async id=>call('submitting',intentPath(id,'submitting')),
  submitted:async(id,txHash)=>call('submitted',intentPath(id,'submitted'),{tx_hash:assertTxHash(txHash)}),
  confirm:async id=>call('confirm',intentPath(id,'confirm')),
 };
}

// Reads PAYOUT_MNEMONIC (and optional PAYOUT_ACCOUNT_INDEX) from .local/payout.env. Errors never quote file content.
export function loadPayoutSecrets(path=process.env.PAYOUT_ENV_FILE||join(ROOT,'.local','payout.env')){
 let text;
 try{text=readFileSync(path,'utf8')}catch(error){throw new PayoutError(`Payout key file is not readable (${error.code||'error'}). Expected PAYOUT_MNEMONIC in .local/payout.env.`,{code:'config_missing'});}
 let parsed;
 try{parsed=parseEnv(text)}catch{throw new PayoutError('Payout key file could not be parsed. Inspect it manually.',{code:'config_invalid'});}
 const mnemonic=normalizeMnemonic(parsed.PAYOUT_MNEMONIC);
 if(!mnemonic)throw new PayoutError('Payout key file has no PAYOUT_MNEMONIC.',{code:'config_missing'});
 const index=parsed.PAYOUT_ACCOUNT_INDEX??'0';
 if(!/^[0-9]{1,3}$/.test(index))throw new PayoutError('PAYOUT_ACCOUNT_INDEX must be a small non-negative integer.',{code:'config_invalid'});
 return {mnemonic,accountIndex:Number(index)};
}

// Evolution SDK signer on Preprod/Blockfrost. buildAndSign returns the body hash before anything is broadcast,
// plus a submit() that can run at most once.
export function createEvolutionSigner({mnemonic,accountIndex=0,projectId=process.env.BLOCKFROST_API_KEY_PREPROD,now=()=>Date.now(),ttlMs=DEFAULT_TTL_MS,sdk=evolution}={}){
 const normalized=normalizeMnemonic(mnemonic);
 const secrets=[mnemonic,normalized,projectId];
 if(!normalized||!sdk.PrivateKey.validateMnemonic(normalized))throw new PayoutError('PAYOUT_MNEMONIC is not a valid BIP-39 mnemonic.',{code:'config_invalid'});
 if(!projectId)throw new PayoutError('BLOCKFROST_API_KEY_PREPROD is not set. Run with: node --env-file=.env ...',{code:'config_missing'});
 const chain=sdk.preprod;
 if(chain?.id!==0||chain?.networkMagic!==1)throw new PayoutError('Evolution preprod chain preset is not network id 0 / magic 1.',{code:'network_not_allowed'});
 const client=sdk.Client.make(chain).withBlockfrost({baseUrl:BLOCKFROST_PREPROD_URL,projectId}).withSeed({mnemonic:normalized,accountIndex});
 async function guarded(step,code,fn){
  try{return await fn()}catch(error){throw new PayoutError(`${step} failed: ${redact(error?.message,secrets)}`,{code});}
 }
 let addressCache;
 async function address(){
  if(addressCache)return addressCache;
  const bech32=await guarded('Payout wallet address','signer_error',async()=>sdk.Address.toBech32(await client.address()));
  if(!bech32.startsWith('addr_test1'))throw new PayoutError('Payout wallet address is not a testnet address.',{code:'network_not_allowed'});
  return addressCache=bech32;
 }
 return {
  network:NETWORK,
  address,
  async preflight({lovelace}){
   await address();
   const utxos=await guarded('Reading payout wallet UTxOs','signer_error',()=>client.getWalletUtxos());
   const total=utxos.reduce((sum,utxo)=>sum+sdk.Assets.lovelaceOf(utxo.assets),0n);
   if(total<BigInt(lovelace)+FEE_MARGIN_LOVELACE)throw new PayoutError('Payout wallet balance is below the payout amount plus a 2 tADA fee margin.',{code:'insufficient_funds'});
  },
  async buildAndSign({toAddress,lovelace}){
   await address();
   const signBuilder=await guarded('Building the payout transaction','build_failed',()=>client.newTx()
    .payToAddress({address:sdk.Address.fromBech32(toAddress),assets:sdk.Assets.fromLovelace(BigInt(lovelace))})
    .setValidity({to:BigInt(now()+ttlMs)})
    .build());
   const txHash=await guarded('Hashing the payout transaction','build_failed',async()=>signBuilder.chainResult().txHash);
   const submitBuilder=await guarded('Signing the payout transaction','sign_failed',()=>signBuilder.sign());
   let used=false;
   return {
    txHash,
    async submit(){
     if(used)throw new PayoutError('submit() was already called for this transaction. Refusing to resubmit.',{code:'resubmit_refused',txHash});
     used=true;
     const hash=await guarded('Submitting the payout transaction','submit_failed',()=>submitBuilder.submit());
     return typeof hash==='string'?hash.toLowerCase():sdk.TransactionHash.toHex(hash);
    },
   };
  },
 };
}

// Local per-payout journal under payout/state/ (git-ignored). claim() is exclusive, so two local runs never sign twice.
export function createFileJournal(dir=process.env.PAYOUT_STATE_DIR||join(ROOT,'payout','state')){
 const path=id=>join(dir,`${assertPayoutId(id)}.json`);
 const write=(id,data)=>{const tmp=`${path(id)}.tmp`;writeFileSync(tmp,JSON.stringify({payout_id:id,...data,at:new Date().toISOString()})+'\n',{mode:0o600});renameSync(tmp,path(id));};
 return {
  claim(id){
   mkdirSync(dir,{recursive:true,mode:0o700});
   let fd;
   try{fd=openSync(path(id),'wx',0o600)}catch(error){
    if(error.code==='EEXIST')throw new PayoutError(manualSteps(id,'unknown',null,`A local journal entry exists (${path(id)}). Another run is active, or an earlier run stopped after claiming this payout.`),{code:'journal_exists',payoutId:id,manual:true});
    throw error;
   }
   try{writeFileSync(fd,JSON.stringify({payout_id:id,phase:'claimed',at:new Date().toISOString()})+'\n')}finally{closeSync(fd)}
  },
  record:write,
  release(id){rmSync(path(id),{force:true})},
 };
}
export function createMemoryJournal(){
 const entries=new Map();
 return {
  entries,
  claim(id){if(entries.has(id))throw new PayoutError(manualSteps(id,'unknown',null,'A journal entry exists.'),{code:'journal_exists',payoutId:id,manual:true});entries.set(id,{phase:'claimed'});},
  record(id,data){entries.set(id,{...data});},
  release(id){entries.delete(id);},
 };
}

export function manualSteps(payoutId,state,txHash,reason){
 const lines=[
  `MANUAL INSPECTION REQUIRED for payout ${payoutId} (state ${state}). ${reason}`,
  'No automatic retry: do not rerun the payout for this intent until it is resolved.',
  txHash?`1. Look up tx ${txHash} on Blockfrost Preprod: GET ${BLOCKFROST_PREPROD_URL}/txs/${txHash} (or https://preprod.cardanoscan.io/transaction/${txHash}).`
   :`1. List recent transactions of the payout wallet (address: ${SCRIPT} address) on Blockfrost Preprod: GET ${BLOCKFROST_PREPROD_URL}/addresses/<payout address>/transactions.`,
  `2. If a matching transaction exists, record it: ${SCRIPT} record-submitted ${payoutId} <tx_hash>. Then rerun "pay" to confirm; it builds no new transaction.`,
  `3. If none exists, wait until the transaction TTL (${DEFAULT_TTL_MS/60_000} min after signing) has passed and check again. Only then treat the payout as not sent and resolve the intent manually in the backend.`,
 ];
 return lines.join('\n');
}

const defaultClock={now:()=>Date.now(),sleep:ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms))};
const defaultLog=line=>console.error(`[payout] ${line}`);
const isRetryableConfirm=error=>error instanceof BackendError&&(error.status===0||error.status===503||(error.status===409&&error.code==='tx_not_found'));

// Flow: authorize → (authorized) submitting → build+sign → submit → submitted → confirm polling.
// `submitted` resumes confirm only; `submitting` / `unknown` stop for manual inspection.
export async function runPayout({checkId,backend,signer,clock=defaultClock,journal=createFileJournal(),log=defaultLog,env=process.env,
 maxLovelace=BigInt(Number(env.PAYOUT_MAX_ADA_PER_INVOICE)||DEFAULT_MAX_ADA_PER_INVOICE)*1_000_000n,
 pollIntervalMs=DEFAULT_POLL_INTERVAL_MS,confirmTimeoutMs=DEFAULT_CONFIRM_TIMEOUT_MS,validateAddress=assertPreprodAddress}){
 assertCheckId(checkId);
 assertPreprodEnv(env);
 if(signer?.network!==NETWORK)throw new PayoutError(`Signer must be configured for ${NETWORK}.`,{code:'network_not_allowed'});
 let toAddress=null;
 const safe=text=>redact(text,[toAddress]);
 let intent;
 try{intent=parseIntent(await backend.authorize(checkId))}catch(error){
  if(error instanceof BackendError)throw new PayoutError(`Payout authorization refused: ${error.code} (HTTP ${error.status}).`,{code:error.code,status:error.status});
  throw error;
 }
 const {payoutId,lovelace}=intent;
 toAddress=intent.toAddress;
 log(`payout_id=${payoutId} state=${intent.state} event=authorize`);
 const fail=(message,code,extra={})=>new PayoutError(message,{code,payoutId,state:intent.state,...extra});
 const manual=(state,txHash,reason,code)=>{
  const error=new PayoutError(manualSteps(payoutId,state,txHash,safe(reason)),{code,payoutId,state,txHash,manual:true});
  log(`payout_id=${payoutId} state=${state} event=manual_inspection code=${code}${txHash?` tx_hash=${txHash}`:''}`);
  return error;
 };

 if(intent.state==='confirmed'){log(`payout_id=${payoutId} state=confirmed event=already_confirmed`);return {payoutId,state:'confirmed',txHash:intent.txHash,resumed:true};}
 if(intent.state==='failed')throw fail(`Payout intent ${payoutId} is failed; nothing is sent.`,'payout_failed');
 if(intent.state==='submitting')throw manual('submitting',intent.txHash,'The intent is already in submitting; an earlier run may have broadcast a transaction.','manual_inspection');
 if(intent.state==='unknown')throw manual('unknown',intent.txHash,'The intent outcome is unknown.','manual_inspection');
 if(intent.state==='submitted'){
  if(!intent.txHash)throw manual('submitted',null,'The submitted intent has no tx_hash.','invalid_response');
  log(`payout_id=${payoutId} state=submitted event=resume_confirm tx_hash=${intent.txHash}`);
  return confirmLoop(intent.txHash,true);
 }

 // state === 'authorized'
 validateAddress(toAddress);
 if(lovelace>maxLovelace)throw fail(`Payout ${payoutId} exceeds the local cap of ${maxLovelace/1_000_000n} ADA.`,'over_local_cap');
 journal.claim(payoutId);
 try{
  if(typeof signer.preflight==='function')await signer.preflight({lovelace});
  const marked=parseIntent(await backend.submitting(payoutId));
  if(marked.payoutId!==payoutId||marked.state!=='submitting')throw fail(`Backend did not move ${payoutId} to submitting.`,'invalid_response');
 }catch(error){
  journal.release(payoutId); // nothing has been signed yet
  if(error instanceof BackendError)throw fail(`Backend refused submitting for ${payoutId}: ${error.code} (HTTP ${error.status}).`,error.code,{status:error.status});
  throw error instanceof PayoutError?error:fail(safe(error?.message),'preflight_failed');
 }
 intent.state='submitting';
 journal.record(payoutId,{phase:'submitting'});
 log(`payout_id=${payoutId} state=submitting event=marked`);

 let built;
 try{built=await signer.buildAndSign({toAddress,lovelace})}catch(error){
  journal.record(payoutId,{phase:'build_or_sign_failed'});
  throw manual('submitting',null,`Building or signing failed before any broadcast: ${error?.message}`,'build_or_sign_failed');
 }
 const txHash=built?.txHash;
 if(typeof txHash!=='string'||!TX_HASH_RE.test(txHash)){
  journal.record(payoutId,{phase:'build_or_sign_failed'});
  throw manual('submitting',null,'The signer returned no valid tx hash; nothing was submitted.','build_or_sign_failed');
 }
 journal.record(payoutId,{phase:'signed',tx_hash:txHash});
 log(`payout_id=${payoutId} state=submitting event=signed tx_hash=${txHash}`);

 let broadcastHash;
 try{broadcastHash=await built.submit()}catch(error){
  journal.record(payoutId,{phase:'submit_failed',tx_hash:txHash});
  throw manual('submitting',txHash,`Submit failed; the transaction may still have reached the network: ${error?.message}`,'submit_failed');
 }
 if(broadcastHash!==txHash){
  journal.record(payoutId,{phase:'submit_hash_mismatch',tx_hash:txHash});
  throw manual('submitting',txHash,'The provider returned a different tx hash than the signed body.','submit_hash_mismatch');
 }
 journal.record(payoutId,{phase:'broadcast',tx_hash:txHash});
 log(`payout_id=${payoutId} state=submitting event=broadcast tx_hash=${txHash}`);

 try{
  const recorded=parseIntent(await backend.submitted(payoutId,txHash));
  if(recorded.state!=='submitted'||recorded.txHash!==txHash)throw new Error('Backend did not record the tx hash as submitted.');
 }catch(error){
  journal.record(payoutId,{phase:'record_submitted_failed',tx_hash:txHash});
  throw manual('submitting',txHash,`The transaction was broadcast but /submitted failed (${error?.message}).`,'record_submitted_failed');
 }
 intent.state='submitted';
 journal.record(payoutId,{phase:'submitted',tx_hash:txHash});
 log(`payout_id=${payoutId} state=submitted event=recorded tx_hash=${txHash}`);
 return confirmLoop(txHash,false);

 async function confirmLoop(hash,resumed){
  const deadline=clock.now()+confirmTimeoutMs;
  for(;;){
   try{
    const result=parseIntent(await backend.confirm(payoutId));
    if(result.state!=='confirmed')throw fail(`Backend confirm returned state ${result.state}.`,'invalid_response');
    if(result.txHash&&result.txHash!==hash)throw manual(result.state,hash,'Backend confirmed a different tx hash.','tx_hash_mismatch');
    journal.record(payoutId,{phase:'confirmed',tx_hash:hash});
    log(`payout_id=${payoutId} state=confirmed event=confirmed tx_hash=${hash}`);
    return {payoutId,state:'confirmed',txHash:hash,resumed};
   }catch(error){
    if(error instanceof BackendError&&error.status===409&&error.code==='tx_mismatch')throw manual('unknown',hash,'The on-chain transaction does not pay to_address at least lovelace.','tx_mismatch');
    if(!isRetryableConfirm(error)){
     if(error instanceof BackendError)throw fail(`Backend confirm failed: ${error.code} (HTTP ${error.status}).`,error.code,{status:error.status,txHash:hash});
     throw error;
    }
    log(`payout_id=${payoutId} state=submitted event=confirm_pending code=${error.code} tx_hash=${hash}`);
   }
   if(clock.now()+pollIntervalMs>deadline)throw fail(`Confirmation timed out for ${payoutId}. State stays submitted; rerun "pay" later to resume confirm (it builds no new transaction).`,'confirm_timeout',{state:'submitted',txHash:hash});
   await clock.sleep(pollIntervalMs);
  }
 }
}

// Manual recovery after inspection (spec §12.5: allowed from submitting and unknown). Sends no transaction.
export async function recordSubmitted({payoutId,txHash,backend,log=defaultLog}){
 assertPayoutId(payoutId);assertTxHash(txHash);
 let intent;
 try{intent=parseIntent(await backend.submitted(payoutId,txHash))}catch(error){
  if(error instanceof BackendError)throw new PayoutError(`Backend refused /submitted: ${error.code} (HTTP ${error.status}).`,{code:error.code,status:error.status,payoutId});
  throw error;
 }
 log(`payout_id=${payoutId} state=${intent.state} event=record_submitted tx_hash=${txHash}`);
 return {payoutId,state:intent.state,txHash:intent.txHash};
}

async function main(argv){
 const [command,...rest]=argv;
 if(command==='address'){
  const {mnemonic,accountIndex}=loadPayoutSecrets();
  const signer=createEvolutionSigner({mnemonic,accountIndex,projectId:process.env.BLOCKFROST_API_KEY_PREPROD||'unused-offline'});
  process.stdout.write(`${await signer.address()}\n`);return;
 }
 if(command==='pay'){
  const checkId=rest.find(arg=>!arg.startsWith('--'));
  if(!rest.includes(CONFIRM_FLAG))throw new PayoutError(`Refusing to run without ${CONFIRM_FLAG}. This sends real Preprod tADA.`,{code:'confirmation_required'});
  assertCheckId(checkId);assertPreprodEnv();
  const backend=createBackendClient();
  const {mnemonic,accountIndex}=loadPayoutSecrets();
  const signer=createEvolutionSigner({mnemonic,accountIndex});
  const result=await runPayout({checkId,backend,signer});
  process.stdout.write(JSON.stringify({payout_id:result.payoutId,state:result.state,tx_hash:result.txHash})+'\n');return;
 }
 if(command==='record-submitted'){
  const [payoutId,txHash]=rest;
  const result=await recordSubmitted({payoutId,txHash,backend:createBackendClient()});
  process.stdout.write(JSON.stringify({payout_id:result.payoutId,state:result.state,tx_hash:result.txHash})+'\n');return;
 }
 throw new PayoutError(`Usage: ${SCRIPT} pay <check_id> ${CONFIRM_FLAG} | record-submitted <payout_id> <tx_hash> | address`,{code:'usage'});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${redact(error?.message)}\n`);process.exitCode=1;});
}
