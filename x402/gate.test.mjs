import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodePaymentRequiredHeader,decodePaymentResponseHeader,encodePaymentSignatureHeader} from '@x402/core/http';
import {decodeCardanoTransaction} from '@x402/cardano';
import {x402Gate,readGateJournal,claimPayment,isConfirmedSettlement} from './gate.mjs';

const NETWORK='cardano:preprod';
const PAY_TO='addr_test1vqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpcjw59ta';
const PRICE='1000000';

// Minimal well-formed Cardano tx (1 input, 1 output, fee, no witnesses). The seed varies the input, hence the tx id.
function fakeTx(seed){
 const input=Buffer.alloc(32,seed).toString('hex');
 const address='60'+'07'.repeat(28);
 const hex='84a3'+'0081825820'+input+'00'+'0181'+'82581d'+address+'1a000f4240'+'021a00029810'+'a0f5f6';
 const transaction=Buffer.from(hex,'hex').toString('base64');
 return {transaction,nonce:`${input}#0`,txHash:decodeCardanoTransaction(transaction).txHash};
}

function mockFacilitator({settle,verify}={}){
 const calls={verify:0,settle:0,getSupported:0};
 return {calls,
  getSupported:async()=>{calls.getSupported+=1;return {kinds:[{x402Version:2,scheme:'exact',network:NETWORK}],extensions:[],signers:{}};},
  verify:async(payload,requirements)=>{calls.verify+=1;return verify?verify(payload,requirements):{isValid:true,payer:'addr_test1payer'};},
  settle:async(payload,requirements)=>{
   calls.settle+=1;
   const {transaction}=payload.payload;
   const txHash=decodeCardanoTransaction(transaction).txHash;
   return settle?settle(txHash,requirements):{success:true,transaction:txHash,network:NETWORK,payer:'addr_test1payer',extra:{status:'confirmed',confirmations:0}};
  }};
}

async function withGate(options,run){
 const dir=mkdtempSync(join(tmpdir(),'x402-gate-'));
 const journalPath=join(dir,'gate-journal.json');
 const facilitator=options.facilitator??mockFacilitator();
 const handled=[];
 const makeServer=()=>{
  const gate=x402Gate({priceLovelace:PRICE,payTo:PAY_TO,facilitator,journalPath,resourceId:req=>decodeURIComponent(new URL(req.url,'http://x').pathname.split('/')[2]??''),...options.gate});
  return createServer(async(req,res)=>{
   const result=await gate(req,res);
   if(!result)return;
   handled.push(result);
   res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
 };
 const servers=[];
 const start=async()=>{
  const server=makeServer();servers.push(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
 };
 try{await run({base:await start(),restart:start,facilitator,journalPath,handled,dir});}
 finally{
  for(const server of servers)await new Promise(resolve=>server.close(()=>resolve()));
  rmSync(dir,{recursive:true,force:true});
 }
}

async function requirementsFor(url){
 const response=await fetch(url,{method:'POST'});
 assert.equal(response.status,402);
 return decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
}

function paymentHeader(paymentRequired,tx){
 return encodePaymentSignatureHeader({x402Version:2,payload:{transaction:tx.transaction,nonce:tx.nonce},resource:paymentRequired.resource,accepted:paymentRequired.accepts[0]});
}

const pay=(url,header)=>fetch(url,{method:'POST',headers:{'PAYMENT-SIGNATURE':header}});

test('unpaid request gets a 402 with the payment requirements and no facilitator verify/settle',async()=>{
 await withGate({},async({base,facilitator,handled})=>{
  const paymentRequired=await requirementsFor(`${base}/pay/task-a`);
  assert.equal(paymentRequired.x402Version,2);
  assert.equal(paymentRequired.accepts.length,1);
  const [accept]=paymentRequired.accepts;
  assert.equal(accept.scheme,'exact');assert.equal(accept.network,NETWORK);assert.equal(accept.asset,'lovelace');
  assert.equal(accept.amount,PRICE);assert.equal(accept.payTo,PAY_TO);assert.equal(accept.maxTimeoutSeconds,600);
  assert.deepEqual(accept.extra.confirmationPolicy,{l1Confirmations:0});
  assert.match(paymentRequired.resource.url,/\/pay\/task-a$/);
  assert.equal(facilitator.calls.verify,0);assert.equal(facilitator.calls.settle,0);
  assert.equal(handled.length,0);
 });
});

test('valid payment is granted only after a confirmed settle, then stays idempotent',async()=>{
 await withGate({},async({base,facilitator,journalPath,handled})=>{
  const url=`${base}/pay/task-a`;
  const tx=fakeTx(1);
  const header=paymentHeader(await requirementsFor(url),tx);
  const response=await pay(url,header);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a'});
  const receipt=decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE'));
  assert.equal(receipt.success,true);assert.equal(receipt.transaction,tx.txHash);
  assert.equal(facilitator.calls.verify,1);assert.equal(facilitator.calls.settle,1);
  const entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.resourceId,'task-a');assert.equal(entry.state,'paid');assert.equal(entry.settlement.transaction,tx.txHash);
  assert.equal(readFileSync(journalPath,'utf8').includes(tx.transaction),false,'journal must not hold the signed tx');

  // Same payment for the same resource: idempotent, no second settle.
  const again=await pay(url,header);
  assert.equal(again.status,200);
  assert.equal((await again.json()).alreadyPaid,true);
  // Paid resource without a payment header: paid again, no new 402.
  const unpaid=await fetch(url,{method:'POST'});
  assert.equal(unpaid.status,200);
  assert.equal(decodePaymentResponseHeader(unpaid.headers.get('PAYMENT-RESPONSE')).transaction,tx.txHash);
  // A different payment for the already paid resource is refused (it would be a double payment).
  const second=await pay(url,paymentHeader(await requirementsFor(`${base}/pay/other`),fakeTx(2)));
  assert.equal(second.status,409);assert.equal((await second.json()).error,'resource_already_paid');
  assert.equal(facilitator.calls.settle,1);
  assert.equal(handled.length,3);
 });
});

test('a payment replayed for another resourceId is rejected, also after a restart',async()=>{
 await withGate({},async({base,restart,facilitator,journalPath})=>{
  const tx=fakeTx(3);
  const header=paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx);
  assert.equal((await pay(`${base}/pay/task-a`,header)).status,200);
  const replay=await pay(`${base}/pay/task-b`,header);
  assert.equal(replay.status,409);
  assert.equal((await replay.json()).error,'payment_already_used');
  assert.equal(facilitator.calls.settle,1);
  assert.equal((await fetch(`${base}/pay/task-b`,{method:'POST'})).status,402,'task-b is still unpaid');
  const restarted=await restart();
  const replay2=await pay(`${restarted}/pay/task-b`,header);
  assert.equal(replay2.status,409);
  assert.equal(facilitator.calls.settle,1);
  assert.deepEqual(Object.keys(readGateJournal(journalPath).payments),[tx.txHash]);
 });
});

test('the journal claim refuses a txHash bound to another resource even past the pre-check',()=>{
 const dir=mkdtempSync(join(tmpdir(),'x402-gate-'));
 try{
  const path=join(dir,'j.json');
  const hash='ab'.repeat(32);
  assert.deepEqual(claimPayment(path,hash,'task-a'),{ok:true});
  assert.deepEqual(claimPayment(path,hash,'task-b'),{conflict:'payment_already_used'});
  assert.deepEqual(claimPayment(path,'cd'.repeat(32),'task-a'),{conflict:'resource_payment_in_progress'});
  assert.deepEqual(claimPayment(path,hash,'task-a'),{ok:true},'same tx, same resource: idempotent retry');
  writeFileSync(path,'{broken');
  assert.throws(()=>claimPayment(path,hash,'task-a'),/Inspect it manually/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('settle failure grants no access and keeps the tx bound to its resource',async()=>{
 const facilitator=mockFacilitator({settle:txHash=>({success:false,errorReason:'exact_cardano_settlement_failed',errorMessage:'rejected',transaction:txHash,network:NETWORK})});
 await withGate({facilitator},async({base,journalPath,handled})=>{
  const tx=fakeTx(4);
  const header=paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx);
  const response=await pay(`${base}/pay/task-a`,header);
  assert.equal(response.status,402);
  assert.equal(decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')).success,false);
  assert.equal(handled.length,0);
  assert.equal(readGateJournal(journalPath).payments[tx.txHash].state,'failed');
  assert.equal((await pay(`${base}/pay/task-b`,header)).status,409,'a failed tx still cannot pay another resource');
 });
});

test('pending or mempool-only settlement is not access',async()=>{
 const pending=mockFacilitator({settle:txHash=>({success:false,errorReason:'settlement_pending',transaction:txHash,network:NETWORK,extra:{status:'pending'}})});
 await withGate({facilitator:pending},async({base,journalPath,handled})=>{
  const tx=fakeTx(5);
  const response=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx));
  assert.equal(response.status,402);
  assert.equal(handled.length,0);
  assert.equal(pending.calls.settle,2,'core retries a pending settle exactly once');
  assert.equal(readGateJournal(journalPath).payments[tx.txHash].state,'pending');
  const other=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),fakeTx(6)));
  assert.equal(other.status,409);assert.equal((await other.json()).error,'resource_payment_in_progress');
 });
 const mempool=mockFacilitator({settle:txHash=>({success:true,transaction:txHash,network:NETWORK,extra:{status:'mempool',confirmations:-1}})});
 await withGate({facilitator:mempool},async({base,handled})=>{
  const response=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),fakeTx(7)));
  assert.equal(response.status,402);assert.equal((await response.json()).error,'settlement_not_confirmed');
  assert.equal(handled.length,0);
 });
});

test('invalid verify never settles',async()=>{
 const facilitator=mockFacilitator({verify:()=>({isValid:false,invalidReason:'invalid_exact_cardano_payload_signature'})});
 await withGate({facilitator},async({base,journalPath})=>{
  const response=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),fakeTx(8)));
  assert.equal(response.status,402);
  assert.equal(decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED')).error,'invalid_exact_cardano_payload_signature');
  // Machine-readable for the payer (the live 2026-10-31 rejection answered a bare {}).
  assert.deepEqual(await response.json(),{error:'verify_failed',reason:'invalid_exact_cardano_payload_signature',submitted:false});
  assert.equal(facilitator.calls.settle,0);
  assert.deepEqual(readGateJournal(journalPath).payments,{});
 });
});

test('confirmation rule and constructor validation',()=>{
 const hash='ef'.repeat(32);
 const ok={success:true,transaction:hash,extra:{status:'confirmed',confirmations:0}};
 assert.equal(isConfirmedSettlement(ok,hash),true);
 assert.equal(isConfirmedSettlement(ok,hash,1),false);
 assert.equal(isConfirmedSettlement({...ok,transaction:'00'.repeat(32)},hash),false);
 assert.equal(isConfirmedSettlement({...ok,extra:{status:'mempool',confirmations:-1}},hash),false);
 assert.equal(isConfirmedSettlement({...ok,extra:undefined},hash),false);
 const base={priceLovelace:PRICE,payTo:PAY_TO,facilitator:mockFacilitator(),resourceId:'task-a',journalPath:'j.json'};
 assert.throws(()=>x402Gate({...base,priceLovelace:'1.5'}),/priceLovelace/);
 assert.throws(()=>x402Gate({...base,payTo:'addr1qxyz'}),/testnet/);
 assert.throws(()=>x402Gate({...base,facilitator:undefined}),/facilitator/);
 assert.throws(()=>x402Gate({...base,l1Confirmations:-1}),/mempool/);
 assert.throws(()=>x402Gate({...base,resourceId:'bad id'}),/resourceId/);
});
