// Idempotent x402 payer for Cardano Preprod (Task 22). One journal file per idempotency key.
// Journal phases: pending (written BEFORE anything is signed) -> paid | no_payment_required | unknown | rejected | failed_before_signing.
// An existing paid journal is returned without paying again. unknown or pending is never retried automatically.
// rejected = signed, not confirmed, and proven unable to ever land (an input is spent on chain by another tx); safe to retry.
// failed_before_signing = no signed payload left this process: txHash is journaled by the afterPaymentCreation hook, which
// @x402/core awaits before @x402/fetch sends the payload (a throwing hook aborts the send). Safe to retry with the same key;
// each retry bumps attempt and keeps earlier failures in previousAttempts.
// Payments from one wallet run one at a time in this process: the reference signer spends the wallet's first UTXO as nonce.
// The signer reads UTxOs from Blockfrost /addresses/{addr}/utxos, which can still list an input our previous payment
// spent (measured 2026-10-31, case-7c525f29…: invoice tx 544864fc spent 5814fa9e#0, the wallet payment 1 ms later
// signed 5814fa9e#0 again). So every signature is checked against inputs our earlier payments spent; see avoidSpentInputs.
// The journal never holds the signed transaction, the payment header, or key material.
import {readFileSync,writeFileSync,renameSync,mkdirSync,unlinkSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {wrapFetchWithPayment,x402Client,decodePaymentResponseHeader} from '@x402/fetch';
import {decodePaymentRequiredHeader} from '@x402/core/http';
import {decodeCardanoPayload,decodeCardanoTransaction} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoClient} from '@x402/cardano/exact/client';
import {NETWORK,BLOCKFROST_PREPROD_URL} from './wallets.mjs';

export const PAY_KEY_REGEX=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const STALE_PENDING_MS=15*60*1000;
export const UTXO_WAIT_MS=60000;
export const UTXO_POLL_MS=3000;
export const MIN_CONFLICT_CONFIRMATIONS=2;
const TX_HASH_REGEX=/^[0-9a-f]{64}$/;
const OUT_REF_REGEX=/^[0-9a-f]{64}#[0-9]+$/;
// Journals whose tx is or may be on chain: their inputs must not be signed again.
const HOLDING_PHASES=new Set(['pending','paid','unknown']);
const LOVELACE_REGEX=/^[1-9][0-9]*$/;
const BODY_EXCERPT_CHARS=4000;

const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item,1);

// Temp file + rename, so a reader never sees a half-written journal.
export function writeJsonAtomic(path,value){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const tmp=`${path}.${process.pid}.${randomUUID()}.tmp`;
 try{writeFileSync(tmp,json(value)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,path);}
 catch(error){try{unlinkSync(tmp);}catch{}throw error;}
}

// Runs tasks with the same key one after another; a failed task does not block the next one.
export function createKeyedQueue(){
 const tails=new Map();
 return (key,task)=>{
  const run=(tails.get(key)??Promise.resolve()).then(()=>task());
  const tail=run.then(()=>{},()=>{});
  tails.set(key,tail);
  tail.then(()=>{if(tails.get(key)===tail)tails.delete(key);});
  return run;
 };
}

// The Cardano tx id is the hash of the signed body in the payload; the facilitator broadcasts exactly this tx.
export function decodeSignedTx(transaction){
 const {txHash,inputs}=decodeCardanoTransaction(transaction);
 const hash=txHash.toLowerCase();
 if(!TX_HASH_REGEX.test(hash))throw new Error('Decoded Cardano tx hash is malformed.');
 return {txHash:hash,inputs:inputs.map(ref=>ref.toLowerCase())};
}
export function txHashOfPayload(paymentPayload){
 return decodeSignedTx(decodeCardanoPayload(paymentPayload?.payload??{}).transaction).txHash;
}

// Inputs spent by payments this process signed, per wallet: outRef -> txHash. Spent outputs never come back.
const spentByUs=new Map();
function rememberSpent(wallet,inputs,txHash){
 const refs=spentByUs.get(wallet)??new Map();
 for(const ref of inputs)refs.set(ref,txHash);
 spentByUs.set(wallet,refs);
}
function forgetSpent(wallet,txHash){
 for(const [ref,owner] of spentByUs.get(wallet)??[])if(owner===txHash)spentByUs.get(wallet).delete(ref);
}

// Inputs (and nonce) of this wallet's journals in journalDir that are paid, unknown or pending. Unreadable journals are skipped here;
// payOnce refuses them for their own key.
export function journaledInputs(journalDir,wallet,skipPath){
 let names;
 try{names=readdirSync(journalDir);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const refs=[];
 for(const name of names){
  if(!/^pay-.+\.json$/.test(name))continue;
  const path=join(journalDir,name);
  if(path===skipPath)continue;
  let journal;
  try{journal=readPayJournal(path);}catch{continue;}
  if(journal?.wallet!==wallet||!HOLDING_PHASES.has(journal.phase))continue;
  for(const ref of [...(Array.isArray(journal.inputs)?journal.inputs:[]),journal.nonce])if(typeof ref==='string'&&OUT_REF_REGEX.test(ref))refs.push(ref);
 }
 return [...new Set(refs)];
}

// Wraps a ClientCardanoSigner: a signed tx that spends an input from avoid is discarded (it never left this process) and rebuilt
// after pollMs, until the provider's UTxO view has caught up or waitMs passes. Covers the nonce and coin-selected inputs alike.
export function avoidSpentInputs(signer,avoid,{waitMs=UTXO_WAIT_MS,pollMs=UTXO_POLL_MS,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 return {
  getAddress:()=>signer.getAddress(),
  async buildAndSignPaymentTransaction(input){
   const deadline=performance.now()+waitMs;
   for(;;){
    const signed=await signer.buildAndSignPaymentTransaction(input);
    const reused=[...new Set([...decodeSignedTx(signed.transaction).inputs,String(signed.nonce).toLowerCase()])].filter(ref=>avoid.has(ref));
    if(!reused.length)return signed;
    if(performance.now()>=deadline)throw new Error(`The wallet's UTxO view still lists ${reused.join(', ')}, already spent by an earlier payment from this wallet, after ${waitMs} ms. Nothing was sent.`);
    await sleep(pollMs);
   }
  },
 };
}

// Proof that a signed tx can never land: one of its inputs is consumed on chain by ANOTHER tx at least minConfirmations deep.
// null = no proof (input unspent, spent by this tx itself, too shallow after waitMs, or a lookup failed): stay unknown.
export async function proveUnlandable({chain,txHash,inputs,minConfirmations=MIN_CONFLICT_CONFIRMATIONS,waitMs=UTXO_WAIT_MS,pollMs=UTXO_POLL_MS,sleep}){
 if(typeof chain?.spentBy!=='function'||!Array.isArray(inputs)||!inputs.length)return null;
 const deadline=performance.now()+waitMs;
 for(;;){
  let shallow=false;
  for(const input of inputs){
   let spent;
   try{spent=await chain.spentBy(input);}catch{return null;}
   if(!spent)continue;
   if(spent.txHash===txHash)return null;
   if(!TX_HASH_REGEX.test(spent.txHash??'')||!Number.isInteger(spent.confirmations))return null;
   if(spent.confirmations>=minConfirmations)return {input,spentBy:spent.txHash,confirmations:spent.confirmations};
   shallow=true;
  }
  if(!shallow||performance.now()>=deadline)return null;
  await sleep(pollMs);
 }
}

export function lovelaceString(value,name){
 const text=typeof value==='bigint'||typeof value==='number'?String(value):value;
 if(typeof text!=='string'||!LOVELACE_REGEX.test(text))throw new Error(`${name} must be a positive integer amount of lovelace.`);
 return text;
}

// Defence in depth on top of spendControls: only exact/lovelace/network/payTo within the cap may be signed.
export function assertRequirementsAllowed(requirements,{payTo,maxLovelace,network=NETWORK}){
 if(requirements?.scheme!=='exact')throw new Error('Refusing payment: scheme is not "exact".');
 if(requirements.network!==network)throw new Error(`Refusing payment: network is not ${network}.`);
 if(requirements.asset!=='lovelace')throw new Error('Refusing payment: asset is not lovelace.');
 if(typeof requirements.amount!=='string'||!LOVELACE_REGEX.test(requirements.amount)||BigInt(requirements.amount)>BigInt(maxLovelace))throw new Error(`Refusing payment: amount exceeds ${maxLovelace} lovelace.`);
 if(requirements.payTo!==payTo)throw new Error('Refusing payment: payTo is not the expected address.');
}

export function payJournalPath(journalDir,key){
 if(typeof key!=='string'||!PAY_KEY_REGEX.test(key))throw new Error('Payment key must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.');
 if(typeof journalDir!=='string'||!journalDir)throw new Error('journalDir is required.');
 return join(journalDir,`pay-${key}.json`);
}

// null when no journal exists. Never surfaces parser messages (they quote file content).
export function readPayJournal(path){
 let text;
 try{text=readFileSync(path,'utf8');}
 catch(error){if(error.code==='ENOENT')return null;throw new Error(`Payment journal ${path} is unreadable (${error.code}). Inspect it before paying again.`);}
 try{
  const journal=JSON.parse(text);
  if(journal&&typeof journal==='object'&&typeof journal.phase==='string')return journal;
 }catch{}
 throw new Error(`Payment journal ${path} is not a valid journal. Inspect it before paying again.`);
}

export function inspectMessage(path,journal,what){
 const lines=[`Refusing to pay: ${path} shows ${what}${journal?.txHash?` (txHash ${journal.txHash})`:''}. A payment may have been submitted. No automatic retry.`,
  'Inspect the journal before deciding anything.'];
 if(journal?.txHash){
  lines.push(`  GET ${BLOCKFROST_PREPROD_URL}/txs/${journal.txHash} with header project_id (404 = not on chain)`);
  lines.push(`  Explorer: https://preprod.cardanoscan.io/transaction/${journal.txHash}`);
 }
 lines.push('Only after a human confirms the outcome may the journal be changed or moved.');
 return lines.join('\n');
}

function receiptOf(settlement){
 if(!settlement||typeof settlement!=='object')return undefined;
 const {success,transaction,network,payer,errorReason,extra}=settlement;
 return {success:success===true,transaction,network,payer,errorReason,extra};
}

const walletQueue=createKeyedQueue();

/**
 * Pays an x402-gated URL at most once per key.
 * @param {object} options
 * @param {string} options.url Gated URL.
 * @param {string} options.key Idempotency key, e.g. `${caseId}-${role}`.
 * @param {string} options.journalDir Directory for `pay-<key>.json`.
 * @param {object} options.signer ClientCardanoSigner (e.g. toClientCardanoSigner). payOnce never sees the mnemonic.
 * @param {string} options.payTo The only address this call may pay.
 * @param {string|bigint|number} options.maxLovelace Hard cap per payment.
 * @param {RequestInit} [options.init] fetch init, e.g. {method:'POST'}.
 * @param {object} [options.chain] {spentBy(outRef)=>Promise<{txHash,confirmations}|null>} (x402/chain.mjs). Without it an unconfirmed
 *   signed payment is always 'unknown'; with it, one proven unable to land becomes 'rejected'.
 * @param {number} [options.utxoWaitMs] Max wait for the wallet's UTxO view to drop inputs our earlier payments spent.
 * @returns {Promise<object>} The journal: phase 'paid' (txHash) or 'no_payment_required'.
 */
export async function payOnce({url,key,journalDir,signer,payTo,maxLovelace,network=NETWORK,init,fetchImpl=fetch,staleAfterMs=STALE_PENDING_MS,now=()=>new Date(),
 chain,minConflictConfirmations=MIN_CONFLICT_CONFIRMATIONS,utxoWaitMs=UTXO_WAIT_MS,utxoPollMs=UTXO_POLL_MS,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const path=payJournalPath(journalDir,key);
 if(typeof url!=='string'||!/^https?:\/\//.test(url))throw new Error('url must be an http(s) URL.');
 if(typeof signer?.getAddress!=='function'||typeof signer.buildAndSignPaymentTransaction!=='function')throw new Error('signer must be a ClientCardanoSigner.');
 if(typeof payTo!=='string'||!payTo)throw new Error('payTo is required.');
 const max=lovelaceString(maxLovelace,'maxLovelace');
 const wallet=signer.getAddress();
 return walletQueue(wallet,()=>payLocked({url,key,path,signer,wallet,payTo,max,network,init,fetchImpl,staleAfterMs,now,chain,minConflictConfirmations,utxoWaitMs,utxoPollMs,sleep}));
}

async function payLocked({url,key,path,signer,wallet,payTo,max,network,init,fetchImpl,staleAfterMs,now,chain,minConflictConfirmations,utxoWaitMs,utxoPollMs,sleep}){
 const existing=readPayJournal(path);
 if(existing){
  if(existing.phase==='paid'||existing.phase==='no_payment_required')return existing;
  if(existing.phase==='pending'){
   const age=now().getTime()-Date.parse(existing.updatedAt??existing.createdAt);
   throw new Error(inspectMessage(path,existing,age<staleAfterMs?'a payment still in progress':'a stale pending payment'));
  }
  if(existing.phase!=='failed_before_signing'&&existing.phase!=='rejected')throw new Error(inspectMessage(path,existing,`phase "${existing.phase}"`));
 }

 const state={key,phase:'pending',url,wallet,payTo,maxLovelace:max,network,attempt:(existing?.attempt??0)+1,createdAt:now().toISOString()};
 if(existing?.phase==='rejected')state.previousAttempts=[...(existing.previousAttempts??[]),{attempt:existing.attempt,phase:'rejected',txHash:existing.txHash,rejection:existing.rejection}];
 else if(existing?.phase==='failed_before_signing')state.previousAttempts=[...(existing.previousAttempts??[]),{attempt:existing.attempt,phase:'failed_before_signing',error:existing.error,failedAt:existing.updatedAt}];
 const save=patch=>{Object.assign(state,patch,{updatedAt:now().toISOString()});writeJsonAtomic(path,state);};
 save({});

 const avoid=new Set([...(spentByUs.get(wallet)?.keys()??[]),...journaledInputs(dirname(path),wallet,path)]);
 const timing={waitMs:utxoWaitMs,pollMs:utxoPollMs,sleep};
 let created=0;
 const client=new x402Client()
  .register(network,new ExactCardanoClient(avoidSpentInputs(signer,avoid,timing)))
  .setSpendControls({allowedAssets:[{network,asset:'lovelace',maxAmountPerPayment:max}]});
 client.onBeforePaymentCreation(async({selectedRequirements})=>{
  // Also blocks @x402/fetch's "recovered" path, which would sign a second payload.
  if(created>0)return {abort:true,reason:'Only one payment per payOnce call.'};
  try{assertRequirementsAllowed(selectedRequirements,{payTo,maxLovelace:max,network});}catch(error){return {abort:true,reason:error.message};}
  created+=1;
  const {scheme,network:reqNetwork,asset,amount,payTo:reqPayTo,maxTimeoutSeconds}=selectedRequirements;
  save({selectedRequirements:{scheme,network:reqNetwork,asset,amount,payTo:reqPayTo,maxTimeoutSeconds},signingAt:now().toISOString()});
 });
 client.onAfterPaymentCreation(async({paymentPayload})=>{
  // Persisted before the signed payload leaves this process; the server is the only party that broadcasts.
  const {nonce,transaction}=decodeCardanoPayload(paymentPayload.payload);
  const {txHash,inputs}=decodeSignedTx(transaction);
  rememberSpent(wallet,inputs,txHash);
  save({txHash,nonce,inputs,signedAt:now().toISOString()});
 });
 // Signed but not confirmed: unknown first (a crash during the proof stays fail closed), rejected only with chain proof that
 // this tx can never land.
 const unconfirmed=async patch=>{
  save({phase:'unknown',...patch});
  const rejection=await proveUnlandable({chain,txHash:state.txHash,inputs:state.inputs,minConfirmations:minConflictConfirmations,...timing});
  if(!rejection)return new Error(inspectMessage(path,state,'phase "unknown"'));
  forgetSpent(wallet,state.txHash);
  save({phase:'rejected',rejection:{...rejection,checkedAt:now().toISOString()}});
  return new Error(`Payment ${state.txHash} was not accepted and can never land: input ${rejection.input} is spent by ${rejection.spentBy} (${rejection.confirmations} confirmations). No funds moved; ${path} is rejected.`);
 };

 let response;
 try{response=await wrapFetchWithPayment(fetchImpl,client)(url,init);}
 catch(error){
  if(!state.txHash){save({phase:'failed_before_signing',error:error.message});throw error;}
  const outcome=await unconfirmed({error:error.message});
  throw new Error(`${error.message}\n${outcome.message}`);
 }

 let receipt;
 const header=response.headers.get('PAYMENT-RESPONSE');
 if(header){try{receipt=receiptOf(decodePaymentResponseHeader(header));}catch{receipt={decodeError:true};}}
 let body='';
 try{body=(await response.text()).slice(0,BODY_EXCERPT_CHARS);}catch{}
 const responseInfo={status:response.status,body};
 const required=response.headers.get('PAYMENT-REQUIRED');
 if(required){try{const reason=decodePaymentRequiredHeader(required).error;if(typeof reason==='string')responseInfo.paymentRequiredError=reason.slice(0,500);}catch{}}

 if(!state.txHash){
  if(response.ok){
   // The server needed no new payment, e.g. this resource was already paid by an earlier attempt.
   if(receipt?.success&&TX_HASH_REGEX.test(receipt.transaction??''))save({phase:'paid',paymentMade:false,txHash:receipt.transaction,settlement:receipt,response:responseInfo});
   else save({phase:'no_payment_required',paymentMade:false,response:responseInfo});
   return JSON.parse(json(state));
  }
  save({phase:'failed_before_signing',response:responseInfo,error:`HTTP ${response.status}`});
  throw new Error(`Payment request to ${url} failed with HTTP ${response.status}; no payment was signed.`);
 }
 if(response.ok&&receipt?.success&&receipt.transaction===state.txHash){
  save({phase:'paid',paymentMade:true,settlement:receipt,response:responseInfo,paidAt:now().toISOString()});
  return JSON.parse(json(state));
 }
 // A signed payload reached the server but no confirmed receipt came back: it may still be broadcast or confirm later.
 throw await unconfirmed({settlement:receipt,response:responseInfo,error:receipt?.errorReason??`HTTP ${response.status} without a confirmed receipt`});
}
