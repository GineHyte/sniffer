import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {verifySettlement} from './settlement.mjs';
import {loadSokosumiRuntime} from './sokosumi-runtime.mjs';
const MINUTE=60*1000;
export const USDM='16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export function taskHash(text){return createHash('sha256').update(text,'utf8').digest('hex')}
export function confirmedState(payment,expected){
 return (payment.CurrentTransaction?.status==='Confirmed'&&payment.CurrentTransaction?.newOnChainState===expected)||payment.TransactionHistory?.some(tx=>tx.status==='Confirmed'&&tx.newOnChainState===expected)||false;
}
// Running MPS dist/app-DCTS_JYs.js:249079 signs no forceLayer field.
// Source differs from the loaded build. An absent field is valid for that build.
export function purchasePayload(payment,nonce,registration){
 if(payment.sellerReturnAddress!==null||(payment.forceLayer!==undefined&&payment.forceLayer!==null))throw new Error('Core Task events cannot preserve non-null signed sellerReturnAddress or forceLayer');
 if(payment.PaymentSource?.network!=='Preprod'||payment.PaymentSource?.paymentSourceType!=='Web3CardanoV2')throw new Error('Payment source is not Preprod Web3CardanoV2');
 if(payment.SmartContractWallet?.id!==registration.walletId)throw new Error('Payment wallet differs from dedicated seller wallet');
 if(payment.RequestedFunds.length!==1||payment.RequestedFunds[0].unit!==USDM||payment.RequestedFunds[0].amount!=='1000000')throw new Error('Signed quote differs from 1 test USDM');
 return {blockchainIdentifier:payment.blockchainIdentifier,agentIdentifier:payment.agentIdentifier,
 sellerVkey:payment.SmartContractWallet.walletVkey,submitResultTime:payment.submitResultTime,
 payByTime:payment.payByTime,unlockTime:payment.unlockTime,externalDisputeUnlockTime:payment.externalDisputeUnlockTime,
 inputHash:payment.inputHash,identifierFromPurchaser:nonce,paymentSourceType:'Web3CardanoV2',
 supportedPaymentSourceIndex:registration.supportedPaymentSourceIndex,
 Amounts:payment.RequestedFunds.map(({amount,unit})=>({amount,unit})),
 PaymentSource:{network:'Preprod',smartContractAddress:payment.PaymentSource.smartContractAddress,policyId:payment.PaymentSource.policyId}};
}
export function isPaidReady(){
 if(!existsSync('docs/registration-state.json')||!existsSync('.local/mps-runtime.env'))return false;
 const r=JSON.parse(readFileSync('docs/registration-state.json','utf8'));
 return r.status==='RegistrationConfirmed'||r.registrationState==='RegistrationConfirmed'||r.registration?.state==='RegistrationConfirmed';
}
export async function createPaidAdapter({save,answer,core:providedCore,mps:providedMps,registration:providedRegistration}){
 const registration=()=>providedRegistration??JSON.parse(readFileSync('docs/registration-state.json','utf8'));
 let core=providedCore;
 async function getCore(){
  if(!core){const {readRuntimeCredential,createCoworkerHttpClient}=await loadSokosumiRuntime();
   core=createCoworkerHttpClient({apiKey:readRuntimeCredential(process.env.COWORKER_ID)});}
  return core;
 }
 async function mps(path,body){
  if(providedMps)return providedMps(path,body);
  const env=parseEnv(readFileSync('.local/mps-runtime.env','utf8'));
  const response=await fetch(`${process.env.MPS_URL}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{'Content-Type':'application/json',token:env.MPS_RUNTIME_TOKEN},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok||data.status!=='success')throw new Error(`MPS ${path} failed HTTP ${response.status}. Inspect saved state before retry.`);
  return data.data;
 }
 async function persist(task,state,paid){const next={...state,paid};await save(task.id,next);return next;}
 return {async advance(task,state){
  let p=state.paid??{};const r=registration();
  if(!p.stage){
   if(!state.input?.trim())throw new Error('Paid Task requires authoritative started input');
   const nonce=randomBytes(10).toString('hex');const now=Date.now();
   const body={network:'Preprod',agentIdentifier:r.agentIdentifier,paymentSourceType:'Web3CardanoV2',supportedPaymentSourceIndex:r.supportedPaymentSourceIndex,
    inputHash:taskHash(state.input),identifierFromPurchaser:nonce,RequestedFunds:[{amount:'1000000',unit:USDM}],
    payByTime:new Date(now+5*MINUTE).toISOString(),submitResultTime:new Date(now+20*MINUTE).toISOString(),unlockTime:new Date(now+36*MINUTE).toISOString(),externalDisputeUnlockTime:new Date(now+52*MINUTE).toISOString(),metadata:JSON.stringify({taskId:task.id})};
   if(!body.agentIdentifier||!Number.isInteger(body.supportedPaymentSourceIndex))throw new Error('Registration identifier and source index are required');
   state=await persist(task,state,{stage:'terms-pending',nonce,request:body});
   const payment=await mps('/api/v1/payment',body);
   return persist(task,state,{...state.paid,stage:'terms-saved',payment});
  }
  if(p.stage==='terms-saved'){
   const payload=purchasePayload(p.payment,p.nonce,r);
   if(Date.now()>=Number(p.payment.payByTime))throw new Error('Signed payment deadline expired');
   state=await persist(task,state,{...p,payload,stage:'purchase-pending'});
   const response=await (await getCore()).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{comment:'Payment requested: 1 test USDM.',masumiPayment:payload});
   return persist(task,state,{...p,stage:'awaiting-escrow',eventId:response.data.id});
  }
  if(['awaiting-escrow','awaiting-result','awaiting-withdrawal'].includes(p.stage)){
   const observed=await mps('/api/v1/payment/resolve-blockchain-identifier',{network:'Preprod',blockchainIdentifier:p.payment.blockchainIdentifier,includeHistory:'true'});
   p={...p,observed};state=await persist(task,state,p);
   if(p.stage==='awaiting-escrow'){
    if(observed.onChainState!=='FundsLocked'||!confirmedState(observed,'FundsLocked'))return state;
    if(Date.now()>=Number(p.payment.submitResultTime))throw new Error('Result deadline expired before model');
    state=await persist(task,state,{...p,stage:'model-pending'});
    if(Date.now()>=Number(p.payment.submitResultTime))throw new Error('Result deadline expired before model send');
    const result=await answer(state.input,`.local/${task.id}-session.json`,Number(p.payment.submitResultTime));
    if(typeof result!=='string'||!result.trim())throw new Error('Model did not return a result');
    writeFileSync(`.local/${task.id}.txt`,result,{mode:0o600});
    return persist(task,state,{...p,stage:'result-saved',result,resultHash:taskHash(result)});
   }
   if(p.stage==='awaiting-result'&&observed.resultHash===p.resultHash&&confirmedState(observed,'ResultSubmitted')&&observed.onChainState==='ResultSubmitted')return persist(task,state,{...p,stage:'complete-ready'});
   if(p.stage==='awaiting-withdrawal'&&['Withdrawn','DisputedWithdrawn'].includes(observed.onChainState)){const evidence=await verifySettlement({core:await getCore(),taskId:task.id,payment:observed,sellerAddress:registration().registration?.SmartContractWallet?.walletAddress,unit:USDM});return persist(task,state,{...p,stage:evidence.verified?'settled':'awaiting-withdrawal',settlement:evidence});}
   return state;
  }
  if(p.stage==='result-saved'){
   if(Date.now()>=Number(p.payment.submitResultTime))throw new Error('Result deadline expired before submit');
   state=await persist(task,state,{...p,stage:'submit-pending'});
   await mps('/api/v1/payment/submit-result',{network:'Preprod',blockchainIdentifier:p.payment.blockchainIdentifier,submitResultHash:p.resultHash});
   return persist(task,state,{...p,stage:'awaiting-result'});
  }
  if(p.stage==='complete-ready'){
   state=await persist(task,state,{...p,stage:'complete-pending'});
   const response=await (await getCore()).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{status:'COMPLETED',comment:p.result});
   return persist(task,{...state,phase:'completed'},{...p,stage:'awaiting-withdrawal',completionEventId:response.data.id});
  }
  if(p.stage.endsWith('-pending'))throw new Error(`Uncertain ${p.stage}. Inspect prior operation before recovery; automatic retry disabled.`);
  return state;
 }};
}
