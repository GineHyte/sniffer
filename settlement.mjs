export function sellerTokenNet(utxos,address,unit){
 const sum=entries=>entries.filter(x=>x.address===address).reduce((total,x)=>total+x.amount.filter(a=>a.unit===unit).reduce((n,a)=>n+BigInt(a.quantity),0n),0n);
 return sum(utxos.outputs)-sum(utxos.inputs);
}
export async function verifySettlement({core,taskId,payment,sellerAddress,unit}){
 const raw=await core.get(`/v1/tasks/${encodeURIComponent(taskId)}/receipt`);
 const receipt=raw.data;
 if(!receipt?.settled||!receipt.txHash)return {verified:false,receipt};
 if(receipt.blockchainIdentifier!==payment.blockchainIdentifier)throw new Error('Core receipt payment identifier mismatch');
 const tx=[payment.CurrentTransaction,...(payment.TransactionHistory||[])].find(t=>t?.status==='Confirmed'&&['Withdrawn','DisputedWithdrawn'].includes(t.newOnChainState)&&t.txHash===receipt.txHash);
 if(!tx)return {verified:false,receipt,reason:'Matching MPS withdrawal transaction not confirmed'};
 const response=await fetch(`https://cardano-preprod.blockfrost.io/api/v0/txs/${receipt.txHash}/utxos`,{headers:{project_id:process.env.BLOCKFROST_API_KEY_PREPROD},signal:AbortSignal.timeout(30000)});
 if(!response.ok)return {verified:false,receipt,blockfrostStatus:response.status};
 const net=sellerTokenNet(await response.json(),sellerAddress,unit);
 return {verified:net>0n,receipt,txHash:receipt.txHash,netAtomicUnits:net.toString(),method:'Matched Core/MPS withdrawal hash and Blockfrost transaction inputs/outputs at dedicated seller address'};
}
