// x402 payment gate for plain node:http routes on Cardano Preprod (Task 22, docs/x402-notes.md §3.2 and §4).
// Cardano supports only the authorization flow: verify -> handler -> settle. The gate therefore settles itself and
// returns {paid:true} only after a CONFIRMED settle; a gated route (e.g. POST /pay/{taskId}) must only record payment.
// Replay protection: a persistent journal binds each txHash to exactly one resourceId, and a resource to at most one
// live payment. One process per journal file: the read-modify-write steps are synchronous, so they are atomic in-process.
import {readFileSync} from 'node:fs';
import {x402ResourceServer,x402HTTPResourceServer,HTTPFacilitatorClient} from '@x402/core/server';
import {decodePaymentSignatureHeader,decodePaymentRequiredHeader,encodePaymentResponseHeader} from '@x402/core/http';
import {CARDANO_ADDRESS_REGEX} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoServer} from '@x402/cardano/exact/server';
import {NETWORK} from './wallets.mjs';
import {asFacilitatorClient} from './facilitator.mjs';
import {writeJsonAtomic,createKeyedQueue,txHashOfPayload,lovelaceString} from './pay.mjs';

export const RESOURCE_ID_REGEX=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DEFAULT_FACILITATOR_TIMEOUT_MS=120000;
// States that bind a resource: no second tx may be settled for it while one of these exists.
const LIVE_STATES=new Set(['settling','pending','unknown','paid']);

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

export function paidPaymentFor(journal,resourceId){
 for(const [txHash,entry] of Object.entries(journal.payments))if(entry?.resourceId===resourceId&&entry.state==='paid')return {txHash,entry};
 return undefined;
}

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
 * @param {string} [options.facilitatorUrl] HTTP facilitator base URL (used when no facilitator object is given).
 * @param {string|((req)=>string|Promise<string>)} options.resourceId Resource the payment is bound to, e.g. the taskId from the path.
 * @param {string} options.journalPath JSON journal file (txHash -> resourceId).
 * @returns {(req,res)=>Promise<{paid:true,txHash:string,resourceId:string,alreadyPaid?:true}|null>}
 *   null: the gate already wrote the full response (402, 409, 400, 500).
 *   paid: the gate set PAYMENT-RESPONSE but did not end the response; the caller writes the body.
 */
export function x402Gate({priceLovelace,payTo,facilitator,facilitatorUrl,resourceId,journalPath,network=NETWORK,l1Confirmations=0,maxTimeoutSeconds=600,
 description='',facilitatorTimeoutMs=DEFAULT_FACILITATOR_TIMEOUT_MS,onError=()=>{}}={}){
 const amount=lovelaceString(priceLovelace,'priceLovelace');
 validatePayTo(payTo,network);
 if(typeof resourceId!=='function'&&(typeof resourceId!=='string'||!RESOURCE_ID_REGEX.test(resourceId)))throw new Error('resourceId must be a valid id string or a function of the request.');
 if(typeof journalPath!=='string'||!journalPath)throw new Error('journalPath is required.');
 if(!Number.isInteger(l1Confirmations)||l1Confirmations<0)throw new Error('l1Confirmations must be an integer >= 0 (mempool is never accepted).');
 let client;
 if(facilitator)client=asFacilitatorClient(facilitator);
 else if(typeof facilitatorUrl==='string'&&/^https?:\/\//.test(facilitatorUrl))client=new HTTPFacilitatorClient({url:facilitatorUrl,timeoutMs:facilitatorTimeoutMs});
 else throw new Error('Either facilitator or facilitatorUrl is required.');

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

 async function handle(req,res,id){
  const url=new URL(req.url??'/',`http://${headerValue(req,'host')||'localhost'}`);
  const offered=offeredTxHash(req);
  const journal=readGateJournal(journalPath);
  const paid=paidPaymentFor(journal,id);
  if(paid){
   // One payment per resource: a paid resource answers paid again and never asks for a second payment.
   if(!offered||offered===paid.txHash){setReceipt(res,paid.entry.settlement);return {paid:true,txHash:paid.txHash,resourceId:id,alreadyPaid:true};}
   throw new GateError(409,'resource_already_paid');
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
  if(claim.paid){setReceipt(res,claim.paid.entry.settlement);return {paid:true,txHash,resourceId:id,alreadyPaid:true};}

  let settle;
  try{settle=await httpServer.processSettlement(result.paymentPayload,result.paymentRequirements,result.declaredExtensions,{request:context});}
  catch(error){updatePayment(journalPath,txHash,{state:'unknown',errorReason:'settle_threw'});throw error;}

  if(isConfirmedSettlement(settle,txHash,l1Confirmations)){
   updatePayment(journalPath,txHash,{state:'paid',settlement:settlementSummary(settle),paidAt:new Date().toISOString()});
   for(const [key,value] of Object.entries(settle.headers||{}))res.setHeader(key,value);
   return {paid:true,txHash,resourceId:id};
  }
  // Not confirmed: keep the binding. pending/unknown block other payments for this resource; the same payload may retry.
  const state=!settle.success&&settle.errorReason!=='settlement_pending'?'failed':settle.transaction===txHash?'pending':'unknown';
  updatePayment(journalPath,txHash,{state,errorReason:settle.errorReason??'settlement_not_confirmed',settlement:settlementSummary(settle)});
  if(!settle.success&&settle.response)sendInstructions(res,settle.response);
  else sendJson(res,402,{error:'settlement_not_confirmed'},{'cache-control':'no-store'});
  return null;
 }

 return async function gate(req,res){
  try{
   const id=typeof resourceId==='function'?await resourceId(req):resourceId;
   if(typeof id!=='string'||!RESOURCE_ID_REGEX.test(id))throw new GateError(400,'invalid_resource_id');
   return await perResource(id,()=>handle(req,res,id));
  }catch(error){
   try{onError(error);}catch{}
   if(error instanceof GateError)sendJson(res,error.status,{error:error.code});
   else sendJson(res,500,{error:'payment_gate_error'});
   return null;
  }
 };
}
