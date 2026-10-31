// In-process x402 facilitator for Cardano Preprod (docs/x402-notes.md §2 option A).
// Provider-only: Blockfrost Preprod project ID, no mnemonic, no funds. It verifies and broadcasts the client's signed tx.
import {x402Facilitator} from '@x402/core/facilitator';
import {toFacilitatorCardanoSigner} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoFacilitator} from '@x402/cardano/exact/facilitator';
import {BLOCKFROST_PREPROD_URL,NETWORK} from './wallets.mjs';

export function blockfrostProvider(projectId,{requestTimeoutMs=20000}={}){
 if(!projectId)throw new Error('BLOCKFROST_API_KEY_PREPROD is not set. Run with: node --env-file=.env ...');
 return {blockfrost:{baseUrl:BLOCKFROST_PREPROD_URL,projectId},requestTimeoutMs};
}

// x402Facilitator.getSupported() is synchronous; FacilitatorClient expects a Promise.
// The optional gate hooks onSubmitted / transactionEvidence (x402/gate.mjs acceptOn:'submitted') are passed through when present.
export function asFacilitatorClient(facilitator){
 return {
  verify:(payload,requirements)=>facilitator.verify(payload,requirements),
  settle:(payload,requirements)=>facilitator.settle(payload,requirements),
  getSupported:async()=>facilitator.getSupported(),
  ...typeof facilitator.onSubmitted==='function'?{onSubmitted:listener=>facilitator.onSubmitted(listener)}:{},
  ...typeof facilitator.transactionEvidence==='function'?{transactionEvidence:txHash=>facilitator.transactionEvidence(txHash)}:{},
 };
}

// confirmationTimeoutMs stays below core's 90 s facilitator-client default (README "Settlement").
// onSubmitted(listener) -> unsubscribe: listener(txHash) runs right after the provider accepted this tx (before confirmation is awaited).
// transactionEvidence(txHash): the signer's Blockfrost evidence ({status:'unknown'|'confirmed', confirmations}) that settle itself polls.
export function createInProcessFacilitator({projectId=process.env.BLOCKFROST_API_KEY_PREPROD,network=NETWORK,confirmationTimeoutMs=75000}={}){
 const signer=toFacilitatorCardanoSigner({network,provider:blockfrostProvider(projectId),awaitConfirmation:false});
 const listeners=new Set();
 const submit=signer.submitTransaction.bind(signer);
 signer.submitTransaction=async(...args)=>{
  const submission=await submit(...args);
  const txHash=String(submission?.txHash??'').toLowerCase();
  for(const listener of [...listeners]){try{listener(txHash);}catch{}}
  return submission;
 };
 const facilitator=new x402Facilitator().register(network,new ExactCardanoFacilitator(signer,{confirmationTimeoutMs}));
 return {
  ...asFacilitatorClient(facilitator),
  onSubmitted(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  ...typeof signer.getTransactionEvidence==='function'?{transactionEvidence:txHash=>signer.getTransactionEvidence(txHash,network)}:{},
 };
}
