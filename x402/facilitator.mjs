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
export function asFacilitatorClient(facilitator){
 return {
  verify:(payload,requirements)=>facilitator.verify(payload,requirements),
  settle:(payload,requirements)=>facilitator.settle(payload,requirements),
  getSupported:async()=>facilitator.getSupported(),
 };
}

// confirmationTimeoutMs stays below core's 90 s facilitator-client default (README "Settlement").
export function createInProcessFacilitator({projectId=process.env.BLOCKFROST_API_KEY_PREPROD,network=NETWORK,confirmationTimeoutMs=75000}={}){
 const signer=toFacilitatorCardanoSigner({network,provider:blockfrostProvider(projectId),awaitConfirmation:false});
 const facilitator=new x402Facilitator().register(network,new ExactCardanoFacilitator(signer,{confirmationTimeoutMs}));
 return asFacilitatorClient(facilitator);
}
