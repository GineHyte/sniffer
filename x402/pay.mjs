// Idempotent x402 payer for Cardano Preprod (Task 22). One journal file per idempotency key.
// Journal phases: pending (written BEFORE anything is signed) -> paid | no_payment_required | unknown | failed_before_signing.
// An existing paid journal is returned without paying again. unknown or pending is never retried automatically.
// Payments from one wallet run one at a time in this process: the reference signer spends the wallet's first UTXO as nonce.
// The journal never holds the signed transaction, the payment header, or key material.
import {readFileSync,writeFileSync,renameSync,mkdirSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {wrapFetchWithPayment,x402Client,decodePaymentResponseHeader} from '@x402/fetch';
import {decodeCardanoPayload,decodeCardanoTransaction} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoClient} from '@x402/cardano/exact/client';
import {NETWORK,BLOCKFROST_PREPROD_URL} from './wallets.mjs';

export const PAY_KEY_REGEX=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const STALE_PENDING_MS=15*60*1000;
const TX_HASH_REGEX=/^[0-9a-f]{64}$/;
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
export function txHashOfPayload(paymentPayload){
 const {transaction}=decodeCardanoPayload(paymentPayload?.payload??{});
 const txHash=decodeCardanoTransaction(transaction).txHash.toLowerCase();
 if(!TX_HASH_REGEX.test(txHash))throw new Error('Decoded Cardano tx hash is malformed.');
 return txHash;
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
 * @returns {Promise<object>} The journal: phase 'paid' (txHash) or 'no_payment_required'.
 */
export async function payOnce({url,key,journalDir,signer,payTo,maxLovelace,network=NETWORK,init,fetchImpl=fetch,staleAfterMs=STALE_PENDING_MS,now=()=>new Date()}={}){
 const path=payJournalPath(journalDir,key);
 if(typeof url!=='string'||!/^https?:\/\//.test(url))throw new Error('url must be an http(s) URL.');
 if(typeof signer?.getAddress!=='function'||typeof signer.buildAndSignPaymentTransaction!=='function')throw new Error('signer must be a ClientCardanoSigner.');
 if(typeof payTo!=='string'||!payTo)throw new Error('payTo is required.');
 const max=lovelaceString(maxLovelace,'maxLovelace');
 const wallet=signer.getAddress();
 return walletQueue(wallet,()=>payLocked({url,key,path,signer,wallet,payTo,max,network,init,fetchImpl,staleAfterMs,now}));
}

async function payLocked({url,key,path,signer,wallet,payTo,max,network,init,fetchImpl,staleAfterMs,now}){
 const existing=readPayJournal(path);
 if(existing){
  if(existing.phase==='paid'||existing.phase==='no_payment_required')return existing;
  if(existing.phase==='pending'){
   const age=now().getTime()-Date.parse(existing.updatedAt??existing.createdAt);
   throw new Error(inspectMessage(path,existing,age<staleAfterMs?'a payment still in progress':'a stale pending payment'));
  }
  if(existing.phase!=='failed_before_signing')throw new Error(inspectMessage(path,existing,`phase "${existing.phase}"`));
 }

 const state={key,phase:'pending',url,wallet,payTo,maxLovelace:max,network,attempt:(existing?.attempt??0)+1,createdAt:now().toISOString()};
 const save=patch=>{Object.assign(state,patch,{updatedAt:now().toISOString()});writeJsonAtomic(path,state);};
 save({});

 let created=0;
 const client=new x402Client()
  .register(network,new ExactCardanoClient(signer))
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
  const {nonce}=decodeCardanoPayload(paymentPayload.payload);
  save({txHash:txHashOfPayload(paymentPayload),nonce,signedAt:now().toISOString()});
 });

 let response;
 try{response=await wrapFetchWithPayment(fetchImpl,client)(url,init);}
 catch(error){
  if(!state.txHash){save({phase:'failed_before_signing',error:error.message});throw error;}
  save({phase:'unknown',error:error.message});
  throw new Error(`${error.message}\n${inspectMessage(path,state,'phase "unknown"')}`);
 }

 let receipt;
 const header=response.headers.get('PAYMENT-RESPONSE');
 if(header){try{receipt=receiptOf(decodePaymentResponseHeader(header));}catch{receipt={decodeError:true};}}
 let body='';
 try{body=(await response.text()).slice(0,BODY_EXCERPT_CHARS);}catch{}
 const responseInfo={status:response.status,body};

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
 save({phase:'unknown',settlement:receipt,response:responseInfo,error:receipt?.errorReason??`HTTP ${response.status} without a confirmed receipt`});
 throw new Error(inspectMessage(path,state,'phase "unknown"'));
}
