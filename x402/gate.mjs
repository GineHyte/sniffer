// x402 payment gate for plain node:http routes on Cardano Preprod (Task 22, docs/x402-notes.md §3.2 and §4).
// Cardano supports only the authorization flow: verify -> handler -> settle. The gate therefore settles itself and
// returns {paid:true} only after a CONFIRMED settle; a gated route (e.g. POST /pay/{taskId}) must only record payment.
// Replay protection: a persistent journal binds each txHash to exactly one resourceId, and a resource to at most one
// live payment. One process per journal file: the read-modify-write steps are synchronous, so they are atomic in-process.
// Opt-in acceptOn:'submitted' (latency): grant as soon as verify passed and the facilitator broadcast the tx; the txHash binding is
// journaled before settle, so replays are refused exactly as in the default mode. Confirmation then continues in the background
// (the same settle call, then Blockfrost evidence) and moves the entry to phase confirmed (state paid) or failed.
import {readFileSync} from 'node:fs';
import {x402ResourceServer,x402HTTPResourceServer,HTTPFacilitatorClient} from '@x402/core/server';
import {decodePaymentSignatureHeader,decodePaymentRequiredHeader,encodePaymentResponseHeader} from '@x402/core/http';
import {CARDANO_ADDRESS_REGEX,decodeCardanoPayload,decodeCardanoTransaction,slotToPosixMs} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoServer} from '@x402/cardano/exact/server';
import {NETWORK} from './wallets.mjs';
import {asFacilitatorClient} from './facilitator.mjs';
import {writeJsonAtomic,createKeyedQueue,txHashOfPayload,lovelaceString} from './pay.mjs';

export const RESOURCE_ID_REGEX=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DEFAULT_FACILITATOR_TIMEOUT_MS=120000;
export const DEFAULT_CONFIRM_POLL_MS=5000;
export const DEFAULT_WAIT_CONFIRMED_MS=120000;
// Same indexing grace as @x402/cardano's facilitator (validityWindowClosed): a tx unseen this long after its TTL never lands.
export const VALIDITY_CLOSE_GRACE_MS=120000;
const ACCEPT_ON=new Set(['confirmed','submitted']);
// States that bind a resource: no second tx may be settled for it while one of these exists.
const LIVE_STATES=new Set(['settling','pending','unknown','submitted','paid']);
const TERMINAL_STATES=new Set(['paid','failed']);

class GateError extends Error{
 constructor(status,code,message=code){super(message);this.status=status;this.code=code;}
}

export function emptyGateJournal(){return {version:1,payments:{}};}

// Never surfaces parser messages; fails closed on anything unexpected.
export function readGateJournal(path){
 let text;
 try{text=readFileSync(path,'utf8');}
 catch(error){if(error.code==='ENOENT')return emptyGateJournal();throw new Error(`Gate journal ${path} is unreadable (${error.code}). Inspect it manually.`);}
 let journal;
 try{journal=JSON.parse(text);}catch{throw new Error(`Gate journal ${path} is not valid JSON. Inspect it manually.`);}
 if(journal?.version!==1||!journal.payments||typeof journal.payments!=='object'||Array.isArray(journal.payments))throw new Error(`Gate journal ${path} has an unknown format. Inspect it manually.`);
 return journal;
}

function entryOf(journal,txHash){return Object.hasOwn(journal.payments,txHash)?journal.payments[txHash]:undefined;}

function paymentFor(journal,resourceId,state){
 for(const [txHash,entry] of Object.entries(journal.payments))if(entry?.resourceId===resourceId&&entry.state===state)return {txHash,entry};
 return undefined;
}
export function paidPaymentFor(journal,resourceId){return paymentFor(journal,resourceId,'paid');}

/**
 * Public phase of a journal entry. state is authoritative: paid -> confirmed, failed -> failed; submitted/pending/unknown -> submitted
 * (broadcast or possibly broadcast, not confirmed); settling -> undefined (settle not yet known to have broadcast).
 * @returns {'submitted'|'confirmed'|'failed'|undefined}
 */
export function paymentStatusOf(entry){
 if(!entry)return undefined;
 if(entry.state==='paid')return 'confirmed';
 if(entry.state==='failed')return 'failed';
 if(entry.state==='submitted'||entry.state==='pending'||entry.state==='unknown')return 'submitted';
 return entry.phase==='submitted'?'submitted':undefined;
}

// Validity upper bound of the signed tx as ISO time, or undefined (no TTL: it never expires by itself).
function validUntilOf(paymentPayload,network){
 try{
  const {ttlSlot}=decodeCardanoTransaction(decodeCardanoPayload(paymentPayload?.payload??{}).transaction);
  return ttlSlot===undefined?undefined:new Date(slotToPosixMs(network,ttlSlot)).toISOString();
 }catch{return undefined;}
}

const sleepUnref=ms=>new Promise(resolve=>setTimeout(resolve,ms).unref?.());

/**
 * Binds txHash to resourceId before settlement. Synchronous read-check-write.
 * @returns {{ok:true}|{conflict:string}|{paid:{txHash:string,entry:object}}}
 */
export function claimPayment(path,txHash,resourceId,now=new Date()){
 const journal=readGateJournal(path);
 const bound=entryOf(journal,txHash);
 if(bound&&bound.resourceId!==resourceId)return {conflict:'payment_already_used'};
 if(bound?.state==='paid')return {paid:{txHash,entry:bound}};
 for(const [otherTx,entry] of Object.entries(journal.payments)){
  if(otherTx===txHash||entry?.resourceId!==resourceId||!LIVE_STATES.has(entry.state))continue;
  return {conflict:entry.state==='paid'?'resource_already_paid':'resource_payment_in_progress'};
 }
 const at=now.toISOString();
 journal.payments[txHash]={...bound,resourceId,state:'settling',createdAt:bound?.createdAt??at,updatedAt:at};
 writeJsonAtomic(path,journal);
 return {ok:true};
}

export function updatePayment(path,txHash,patch,now=new Date()){
 const journal=readGateJournal(path);
 const entry=entryOf(journal,txHash);
 if(!entry)throw new Error(`Gate journal ${path} lost the claim for ${txHash}. Inspect it manually.`);
 journal.payments[txHash]={...entry,...patch,updatedAt:now.toISOString()};
 writeJsonAtomic(path,journal);
}

// Paid only on a successful settle of THIS tx with confirmed L1 evidence; mempool never counts (notes §4 rule 3).
export function isConfirmedSettlement(settle,txHash,l1Confirmations=0){
 const confirmations=settle?.extra?.confirmations;
 return settle?.success===true&&settle.transaction===txHash&&settle.extra?.status==='confirmed'
  &&Number.isInteger(confirmations)&&confirmations>=Math.max(0,l1Confirmations);
}

// A settle result proving the facilitator broadcast THIS tx (pending or below the policy), without confirmed evidence.
function isSubmittedSettlement(settle,txHash){
 return settle?.transaction===txHash&&(settle.success===true||settle.errorReason==='settlement_pending');
}

function settlementSummary(settle){
 const {transaction,network,payer,errorReason,extra}=settle??{};
 return {transaction,network,payer,errorReason,extra};
}

function headerValue(req,name){
 const value=req.headers?.[name];
 return Array.isArray(value)?value[0]:value;
}

// Best-effort decode of the offered tx id, used only to refuse replays before any facilitator call.
function offeredTxHash(req){
 const header=headerValue(req,'payment-signature');
 if(!header)return null;
 try{return txHashOfPayload(decodePaymentSignatureHeader(header));}catch{return null;}
}

function adapterFor(req,url){
 return {
  getHeader:name=>headerValue(req,name.toLowerCase()),
  getMethod:()=>req.method,
  getPath:()=>url.pathname,
  getUrl:()=>url.href,
  // API gate: always answer with the JSON 402, never the browser paywall.
  getAcceptHeader:()=>'application/json',
  getUserAgent:()=>headerValue(req,'user-agent')||'',
  getQueryParams:()=>Object.fromEntries(url.searchParams),
  getQueryParam:name=>url.searchParams.get(name)??undefined,
 };
}

function sendJson(res,status,body,headers={}){
 if(res.headersSent)return;
 res.statusCode=status;
 for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify(body));
}

function sendInstructions(res,response){
 if(res.headersSent)return;
 res.statusCode=response.status;
 for(const [key,value] of Object.entries(response.headers||{}))if(key.toLowerCase()!=='content-type')res.setHeader(key,value);
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify(response.isHtml?{}:response.body??{}));
}

// A payment offer refused before settlement (verify failed, no matching requirements, bad payload). The x402 402 carries the
// reason only inside the PAYMENT-REQUIRED header; repeat it in the body. submitted:false = this gate never ran settle for this tx.
function sendRejectedOffer(res,response,submitted){
 let reason='payment_rejected';
 const header=Object.entries(response.headers||{}).find(([key])=>key.toLowerCase()==='payment-required')?.[1];
 try{const error=header&&decodePaymentRequiredHeader(header).error;if(typeof error==='string'&&error)reason=error.slice(0,500);}catch{}
 sendInstructions(res,{...response,isHtml:false,body:{error:'verify_failed',reason,...submitted===false?{submitted:false}:{}}});
}

function setReceipt(res,settlement){
 if(settlement)res.setHeader('PAYMENT-RESPONSE',encodePaymentResponseHeader({success:true,...settlement,errorReason:undefined}));
}

function validatePayTo(payTo,network){
 if(typeof payTo!=='string'||!CARDANO_ADDRESS_REGEX.test(payTo))throw new Error('payTo must be a bech32 Cardano address.');
 if(network!=='cardano:mainnet'&&!payTo.startsWith('addr_test1'))throw new Error(`payTo must be a testnet address on ${network}.`);
}

/**
 * Creates an x402 gate for one priced resource kind.
 * @param {object} options
 * @param {string|bigint|number} options.priceLovelace Price per resource.
 * @param {string} options.payTo Receiver bech32 address.
 * @param {object} [options.facilitator] FacilitatorClient-like object ({verify, settle, getSupported}); a sync getSupported is wrapped.
 *   Optional hooks (createInProcessFacilitator has both): onSubmitted(listener(txHash)) -> unsubscribe, transactionEvidence(txHash).
 * @param {string} [options.facilitatorUrl] HTTP facilitator base URL (used when no facilitator object is given).
 * @param {string|((req)=>string|Promise<string>)} options.resourceId Resource the payment is bound to, e.g. the taskId from the path.
 * @param {string} options.journalPath JSON journal file (txHash -> resourceId).
 * @param {'confirmed'|'submitted'} [options.acceptOn='confirmed'] 'submitted' grants once the tx is verified and broadcast.
 * @param {object} [options.chain] Evidence source for confirmation after settle/restart: {transactionEvidence(txHash)} (x402/chain.mjs);
 *   defaults to facilitator.transactionEvidence. Without either, a submitted entry only resolves through the running settle.
 * @param {number} [options.confirmPollMs=5000] Evidence poll interval.
 * @param {number} [options.confirmWatchMs] How long the background watcher follows a submitted tx (default: TTL bound + grace + 60 s).
 * @returns {((req,res)=>Promise<{paid:true,txHash:string,resourceId:string,confirmed:boolean,alreadyPaid?:true}|null>)&
 *   {paymentStatus:(txHash:string)=>'submitted'|'confirmed'|'failed'|undefined,
 *    waitConfirmed:(txHash:string,options?:{timeoutMs?:number})=>Promise<'confirmed'|'failed'|'timeout'>}}
 *   null: the gate already wrote the full response (402, 409, 400, 500).
 *   paid: the gate set PAYMENT-RESPONSE but did not end the response; the caller writes the body. confirmed:false only in
 *   acceptOn:'submitted' mode, before on-chain confirmation (receipt extra.status 'submitted').
 */
export function x402Gate({priceLovelace,payTo,facilitator,facilitatorUrl,resourceId,journalPath,network=NETWORK,l1Confirmations=0,maxTimeoutSeconds=600,
 description='',facilitatorTimeoutMs=DEFAULT_FACILITATOR_TIMEOUT_MS,onError=()=>{},acceptOn='confirmed',chain,confirmPollMs=DEFAULT_CONFIRM_POLL_MS,
 confirmWatchMs=maxTimeoutSeconds*1000+VALIDITY_CLOSE_GRACE_MS+60000}={}){
 const amount=lovelaceString(priceLovelace,'priceLovelace');
 validatePayTo(payTo,network);
 if(typeof resourceId!=='function'&&(typeof resourceId!=='string'||!RESOURCE_ID_REGEX.test(resourceId)))throw new Error('resourceId must be a valid id string or a function of the request.');
 if(typeof journalPath!=='string'||!journalPath)throw new Error('journalPath is required.');
 if(!Number.isInteger(l1Confirmations)||l1Confirmations<0)throw new Error('l1Confirmations must be an integer >= 0 (mempool is never accepted).');
 if(!ACCEPT_ON.has(acceptOn))throw new Error("acceptOn must be 'confirmed' or 'submitted'.");
 if(!Number.isFinite(confirmPollMs)||confirmPollMs<=0)throw new Error('confirmPollMs must be a positive number.');
 let client;
 if(facilitator)client=asFacilitatorClient(facilitator);
 else if(typeof facilitatorUrl==='string'&&/^https?:\/\//.test(facilitatorUrl))client=new HTTPFacilitatorClient({url:facilitatorUrl,timeoutMs:facilitatorTimeoutMs});
 else throw new Error('Either facilitator or facilitatorUrl is required.');
 const evidenceOf=typeof chain?.transactionEvidence==='function'?txHash=>chain.transactionEvidence(txHash)
  :typeof client.transactionEvidence==='function'?txHash=>client.transactionEvidence(txHash):null;

 const route={
  accepts:{scheme:'exact',network,payTo,price:{amount,asset:'lovelace'},maxTimeoutSeconds,
   extra:{assetTransferMethod:'default',areFeesSponsored:false,confirmationPolicy:{l1Confirmations}}},
  description,mimeType:'application/json',
 };
 const httpServer=new x402HTTPResourceServer(new x402ResourceServer(client).register(network,new ExactCardanoServer()),route);
 let ready;
 const initialize=()=>(ready??=httpServer.initialize().catch(error=>{ready=undefined;throw error;}));
 // One request per resource at a time: two different payments can never both settle for one resource.
 const perResource=createKeyedQueue();
 // Submitted mode: settle calls still running in this process, and one confirmation watcher per txHash (shared by all waiters).
 const inflight=new Map();
 const watchers=new Map();
 const report=error=>{try{onError(error);}catch{}};
 const currentEntry=txHash=>entryOf(readGateJournal(journalPath),txHash);

 // Moves a not yet terminal entry to confirmed (state paid) or failed; never overwrites a terminal entry.
 function finish(txHash,outcome,patch={}){
  const entry=currentEntry(txHash);
  if(!entry||TERMINAL_STATES.has(entry.state))return;
  const at=new Date();
  updatePayment(journalPath,txHash,outcome==='confirmed'?{state:'paid',phase:'confirmed',...patch,paidAt:at.toISOString()}:{state:'failed',phase:'failed',...patch},at);
 }

 // Same classification as the synchronous path: confirmed settle -> paid; a terminal (non-pending) failure -> failed; else stays submitted.
 function applySettle(txHash,settle){
  if(isConfirmedSettlement(settle,txHash,l1Confirmations))return finish(txHash,'confirmed',{settlement:settlementSummary(settle)});
  if(!settle?.success&&settle?.errorReason!=='settlement_pending'&&settle?.errorReason!=='duplicate_settlement')
   finish(txHash,'failed',{errorReason:settle?.errorReason??'settlement_failed',settlement:settlementSummary(settle)});
 }

 // One Blockfrost evidence check: confirmed at the policy depth, or failed once the validity window closed (+grace) unseen.
 async function checkChain(txHash){
  if(!evidenceOf)return undefined;
  let evidence;
  try{evidence=await evidenceOf(txHash);}catch(error){report(error);return undefined;}
  const entry=currentEntry(txHash);
  if(!entry)return undefined;
  if(TERMINAL_STATES.has(entry.state))return paymentStatusOf(entry);
  const confirmations=evidence?.confirmations;
  if(evidence?.status==='confirmed'&&Number.isInteger(confirmations)&&confirmations>=l1Confirmations){
   finish(txHash,'confirmed',{settlement:{transaction:txHash,network,extra:{status:'confirmed',confirmations}}});
   return 'confirmed';
  }
  if((!evidence||evidence.status==='unknown')&&entry.validUntil&&Date.now()>Date.parse(entry.validUntil)+VALIDITY_CLOSE_GRACE_MS){
   finish(txHash,'failed',{errorReason:'validity_window_closed'});
   return 'failed';
  }
  return undefined;
 }

 // Shared watcher: waits for the running settle (if any), then polls the chain until terminal or until `until`.
 function watch(txHash,until){
  const existing=watchers.get(txHash);
  if(existing){existing.until=Math.max(existing.until,until);return existing.promise;}
  const watcher={until};
  watcher.promise=(async()=>{
   try{
    for(;;){
     const running=inflight.get(txHash);
     if(running)await running;
     const entry=currentEntry(txHash);
     if(!entry)return 'timeout';
     const status=paymentStatusOf(entry);
     if(status==='confirmed'||status==='failed')return status;
     const checked=await checkChain(txHash);
     if(checked)return checked;
     const left=watcher.until-Date.now();
     if(left<=0)return 'timeout';
     await sleepUnref(Math.min(confirmPollMs,left));
    }
   }catch(error){report(error);return 'timeout';}
   finally{watchers.delete(txHash);}
  })();
  watchers.set(txHash,watcher);
  return watcher.promise;
 }

 function markSubmitted(txHash,result,settling){
  const at=new Date();
  updatePayment(journalPath,txHash,{state:'submitted',phase:'submitted',submittedAt:at.toISOString(),validUntil:validUntilOf(result.paymentPayload,network),
   settlement:{transaction:txHash,network:result.paymentRequirements?.network??network,extra:{status:'submitted'}}},at);
  if(settling){
   const running=settling.then(({settle,error})=>{if(error)report(error);else applySettle(txHash,settle);}).catch(report)
    .finally(()=>{if(inflight.get(txHash)===running)inflight.delete(txHash);});
   inflight.set(txHash,running);
  }
  watch(txHash,Date.now()+confirmWatchMs).catch(()=>{});
 }

 async function handle(req,res,id){
  const url=new URL(req.url??'/',`http://${headerValue(req,'host')||'localhost'}`);
  const offered=offeredTxHash(req);
  const journal=readGateJournal(journalPath);
  const paid=paidPaymentFor(journal,id);
  if(paid){
   // One payment per resource: a paid resource answers paid again and never asks for a second payment.
   if(!offered||offered===paid.txHash){setReceipt(res,paid.entry.settlement);return {paid:true,txHash:paid.txHash,resourceId:id,confirmed:true,alreadyPaid:true};}
   throw new GateError(409,'resource_already_paid');
  }
  if(acceptOn==='submitted'){
   // Submitted mode: a broadcast, unconfirmed payment already granted this resource; repeats get the same answer, never a second settle.
   const live=paymentFor(journal,id,'submitted');
   if(live&&(!offered||offered===live.txHash)){setReceipt(res,live.entry.settlement);return {paid:true,txHash:live.txHash,resourceId:id,confirmed:false,alreadyPaid:true};}
  }
  if(offered){
   const bound=entryOf(journal,offered);
   if(bound&&bound.resourceId!==id)throw new GateError(409,'payment_already_used');
  }

  await initialize();
  const context={adapter:adapterFor(req,url),path:url.pathname,method:req.method};
  const result=await httpServer.processHTTPRequest(context);
  if(result.type==='payment-error'){
   if(!headerValue(req,'payment-signature')){sendInstructions(res,result.response);return null;}
   // Re-read: only a tx with no gate journal entry can be said to be unsubmitted by this gate.
   sendRejectedOffer(res,result.response,offered&&!entryOf(readGateJournal(journalPath),offered)?false:undefined);
   return null;
  }
  if(result.type!=='payment-verified')throw new GateError(500,'payment_gate_misconfigured');

  let txHash;
  try{txHash=txHashOfPayload(result.paymentPayload);}catch{throw new GateError(400,'invalid_payment_payload');}
  const claim=claimPayment(journalPath,txHash,id);
  if(claim.conflict)throw new GateError(409,claim.conflict);
  if(claim.paid){setReceipt(res,claim.paid.entry.settlement);return {paid:true,txHash,resourceId:id,confirmed:true,alreadyPaid:true};}

  const runSettle=()=>httpServer.processSettlement(result.paymentPayload,result.paymentRequirements,result.declaredExtensions,{request:context});
  let settle;
  if(acceptOn==='submitted'){
   // Race the facilitator's broadcast notification against the settle result; the settle keeps running in the background.
   let unsubscribe=()=>{};
   const submitted=new Promise(resolve=>{
    if(typeof client.onSubmitted!=='function')return;
    const off=client.onSubmitted(hash=>{if(String(hash).toLowerCase()===txHash)resolve({submitted:true});});
    if(typeof off==='function')unsubscribe=off;
   });
   const settling=Promise.resolve().then(runSettle).then(value=>({settle:value}),error=>({error}));
   const first=await Promise.race([submitted,settling]);
   unsubscribe();
   if(first.submitted){
    markSubmitted(txHash,result,settling);
    setReceipt(res,currentEntry(txHash)?.settlement);
    return {paid:true,txHash,resourceId:id,confirmed:false};
   }
   if(first.error){updatePayment(journalPath,txHash,{state:'unknown',errorReason:'settle_threw'});throw first.error;}
   settle=first.settle;
   if(!isConfirmedSettlement(settle,txHash,l1Confirmations)&&isSubmittedSettlement(settle,txHash)){
    // Broadcast proven by the settle answer itself (pending / below policy): grant now, follow the chain in the background.
    markSubmitted(txHash,result,null);
    setReceipt(res,currentEntry(txHash)?.settlement);
    return {paid:true,txHash,resourceId:id,confirmed:false};
   }
  }else{
   try{settle=await runSettle();}
   catch(error){updatePayment(journalPath,txHash,{state:'unknown',errorReason:'settle_threw'});throw error;}
  }

  if(isConfirmedSettlement(settle,txHash,l1Confirmations)){
   updatePayment(journalPath,txHash,{state:'paid',phase:'confirmed',settlement:settlementSummary(settle),paidAt:new Date().toISOString()});
   for(const [key,value] of Object.entries(settle.headers||{}))res.setHeader(key,value);
   return {paid:true,txHash,resourceId:id,confirmed:true};
  }
  // Not confirmed: keep the binding. pending/unknown block other payments for this resource; the same payload may retry.
  const state=!settle.success&&settle.errorReason!=='settlement_pending'?'failed':settle.transaction===txHash?'pending':'unknown';
  updatePayment(journalPath,txHash,{state,...state==='failed'?{phase:'failed'}:{},errorReason:settle.errorReason??'settlement_not_confirmed',settlement:settlementSummary(settle)});
  if(!settle.success&&settle.response)sendInstructions(res,settle.response);
  else sendJson(res,402,{error:'settlement_not_confirmed'},{'cache-control':'no-store'});
  return null;
 }

 async function gate(req,res){
  try{
   const id=typeof resourceId==='function'?await resourceId(req):resourceId;
   if(typeof id!=='string'||!RESOURCE_ID_REGEX.test(id))throw new GateError(400,'invalid_resource_id');
   return await perResource(id,()=>handle(req,res,id));
  }catch(error){
   report(error);
   if(error instanceof GateError)sendJson(res,error.status,{error:error.code});
   else sendJson(res,500,{error:'payment_gate_error'});
   return null;
  }
 }

 /** Sync journal lookup. @returns {'submitted'|'confirmed'|'failed'|undefined} */
 gate.paymentStatus=txHash=>paymentStatusOf(currentEntry(String(txHash??'').toLowerCase()));

 /**
  * Resolves when the payment is confirmed or failed, or 'timeout'. Works after a restart: with no running settle it polls the chain
  * evidence itself. Concurrent callers share one watcher per txHash. Rejects for a txHash this gate never journaled.
  * @returns {Promise<'confirmed'|'failed'|'timeout'>}
  */
 gate.waitConfirmed=async(txHash,{timeoutMs=DEFAULT_WAIT_CONFIRMED_MS}={})=>{
  const hash=String(txHash??'').toLowerCase();
  const entry=currentEntry(hash);
  if(!entry)throw new Error(`The gate journal has no payment ${hash}.`);
  const status=paymentStatusOf(entry);
  if(status==='confirmed'||status==='failed')return status;
  const wait=Math.max(0,Number(timeoutMs)||0);
  let timer;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),wait);});
  try{return await Promise.race([watch(hash,Date.now()+wait),timeout]);}
  finally{clearTimeout(timer);}
 };
 return gate;
}
