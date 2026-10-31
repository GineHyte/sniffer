// Read-only Blockfrost Preprod lookups for payOnce's "can never land" proof (x402/pay.mjs proveUnlandable) and the gate's
// confirmation check (x402/gate.mjs waitConfirmed). No writes, no keys.
import {BLOCKFROST_PREPROD_URL} from './wallets.mjs';

const TX_HASH_REGEX=/^[0-9a-f]{64}$/;
const OUT_REF_REGEX=/^([0-9a-f]{64})#([0-9]+)$/;

/**
 * spentBy(outRef): null while the output is unspent, else {txHash, confirmations} of the on-chain tx that consumed it.
 * Throws when the answer is not clear (unknown output, HTTP error): the caller then keeps the payment unknown.
 */
export function blockfrostChain({projectId=process.env.BLOCKFROST_API_KEY_PREPROD,baseUrl=BLOCKFROST_PREPROD_URL,fetchImpl=fetch,timeoutMs=20000}={}){
 if(!projectId)throw new Error('BLOCKFROST_API_KEY_PREPROD is not set. Run with: node --env-file=.env ...');
 const get=async path=>{
  const response=await fetchImpl(`${baseUrl}${path}`,{headers:{project_id:projectId},signal:AbortSignal.timeout(timeoutMs)});
  if(response.status===404)return null;
  if(!response.ok)throw new Error(`Blockfrost ${path} returned HTTP ${response.status}.`);
  return response.json();
 };
 return {
  async spentBy(outRef){
   const match=OUT_REF_REGEX.exec(String(outRef));
   if(!match)throw new Error('outRef must be txHash#index.');
   const output=(await get(`/txs/${match[1]}/utxos`))?.outputs?.find(item=>item?.output_index===Number(match[2]));
   if(!output)throw new Error(`Blockfrost does not know output ${outRef}.`);
   const consumer=output.consumed_by_tx;
   if(consumer===null)return null;
   if(typeof consumer!=='string'||!TX_HASH_REGEX.test(consumer))throw new Error(`Blockfrost gave no consumed_by_tx for ${outRef}.`);
   const [tx,tip]=await Promise.all([get(`/txs/${consumer}`),get('/blocks/latest')]);
   if(!Number.isInteger(tx?.block_height)||!Number.isInteger(tip?.height))throw new Error(`Blockfrost has no block height for ${consumer}.`);
   return {txHash:consumer,confirmations:Math.max(0,tip.height-tx.block_height)};
  },
  /**
   * transactionEvidence(txHash): {status:'unknown',confirmations:-2} while Blockfrost has no (valid) tx, else {status:'confirmed',
   * confirmations} — the same shape as @x402/cardano's signer evidence, for x402/gate.mjs waitConfirmed. Throws on HTTP errors.
   */
  async transactionEvidence(txHash){
   if(!TX_HASH_REGEX.test(String(txHash)))throw new Error('txHash must be 64 lowercase hex characters.');
   const tx=await get(`/txs/${txHash}`);
   if(!tx||tx.valid_contract===false)return {status:'unknown',confirmations:-2};
   const tip=await get('/blocks/latest');
   if(!Number.isInteger(tx.block_height)||!Number.isInteger(tip?.height))throw new Error(`Blockfrost has no block height for ${txHash}.`);
   return {status:'confirmed',confirmations:Math.max(0,tip.height-tx.block_height)};
  },
 };
}
