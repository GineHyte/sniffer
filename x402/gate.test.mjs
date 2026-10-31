import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodePaymentRequiredHeader,decodePaymentResponseHeader,encodePaymentSignatureHeader} from '@x402/core/http';
import {decodeCardanoTransaction} from '@x402/cardano';
import {x402Gate,readGateJournal,claimPayment,isConfirmedSettlement} from './gate.mjs';
import {blockfrostChain} from './chain.mjs';

const NETWORK='cardano:preprod';
const PAY_TO='addr_test1vqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpcjw59ta';
const PRICE='1000000';

// Minimal well-formed Cardano tx (1 input, 1 output, fee, optional TTL slot, no witnesses). The seed varies the input, hence the tx id.
function fakeTx(seed,ttlSlot){
 const input=Buffer.alloc(32,seed).toString('hex');
 const address='60'+'07'.repeat(28);
 const ttl=ttlSlot===undefined?'':'031a'+ttlSlot.toString(16).padStart(8,'0');
 const hex='84'+(ttl?'a4':'a3')+'0081825820'+input+'00'+'0181'+'82581d'+address+'1a000f4240'+'021a00029810'+ttl+'a0f5f6';
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
 const gates=[];
 const makeServer=(gateOptions)=>{
  const gate=x402Gate({priceLovelace:PRICE,payTo:PAY_TO,facilitator,journalPath,resourceId:req=>decodeURIComponent(new URL(req.url,'http://x').pathname.split('/')[2]??''),...options.gate,...gateOptions});
  gates.push(gate);
  return createServer(async(req,res)=>{
   const result=await gate(req,res);
   if(!result)return;
   handled.push(result);
   res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
 };
 const servers=[];
 const start=async gateOptions=>{
  const server=makeServer(gateOptions);servers.push(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
 };
 try{await run({base:await start(),restart:start,facilitator,journalPath,handled,dir,gates});}
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
  assert.deepEqual(await response.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a',confirmed:true});
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
 assert.throws(()=>x402Gate({...base,acceptOn:'mempool'}),/acceptOn/);
});

// ---- acceptOn:'submitted' (grant on broadcast, confirm in the background) ----

const confirmedSettle=txHash=>({success:true,transaction:txHash,network:NETWORK,payer:'addr_test1payer',extra:{status:'confirmed',confirmations:0}});
const expiredSettle=txHash=>({success:false,errorReason:'exact_cardano_settlement_failed',errorMessage:'validity window closed',transaction:txHash,network:NETWORK,extra:{status:'expired'}});

// Like createInProcessFacilitator: announces the broadcast via onSubmitted, then holds settle until the test confirms or fails it.
function broadcastingFacilitator({evidence}={}){
 const listeners=new Set();
 const held=new Map();
 const evidenceCalls=[];
 const base=mockFacilitator({settle:txHash=>{for(const listener of listeners)listener(txHash);return new Promise(resolve=>held.set(txHash,resolve));}});
 return {...base,held,evidenceCalls,
  onSubmitted(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
  ...evidence?{transactionEvidence:async txHash=>{evidenceCalls.push(txHash);return evidence(txHash,evidenceCalls.length);}}:{},
  finish(txHash,result){held.get(txHash)(result);},
 };
}

const SUBMITTED={acceptOn:'submitted',confirmPollMs:5,confirmWatchMs:2000};

test('submitted mode grants before confirmation (confirmed:false), then the journal moves submitted -> confirmed',async()=>{
 const facilitator=broadcastingFacilitator();
 await withGate({facilitator,gate:SUBMITTED},async({base,journalPath,handled,gates})=>{
  const gate=gates[0];
  const url=`${base}/pay/task-a`;
  const tx=fakeTx(20);
  const header=paymentHeader(await requirementsFor(url),tx);
  const response=await pay(url,header);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a',confirmed:false});
  const receipt=decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE'));
  assert.equal(receipt.success,true);assert.equal(receipt.transaction,tx.txHash);assert.equal(receipt.extra.status,'submitted');
  assert.equal(facilitator.held.has(tx.txHash),true,'settle is still waiting for confirmation');
  let entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.phase,'submitted');assert.equal(entry.state,'submitted');assert.equal(entry.resourceId,'task-a');
  assert.equal(gate.paymentStatus(tx.txHash),'submitted');
  assert.equal(gate.paymentStatus('00'.repeat(32)),undefined);

  // Same payment, same resource while submitted: idempotent, no second settle.
  const again=await pay(url,header);
  assert.equal(again.status,200);
  assert.deepEqual(await again.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a',confirmed:false,alreadyPaid:true});
  assert.equal(facilitator.calls.settle,1);
  // Replay for another resource and a second payment for this resource are refused while submitted.
  const replay=await pay(`${base}/pay/task-b`,header);
  assert.equal(replay.status,409);assert.equal((await replay.json()).error,'payment_already_used');
  const second=await pay(url,paymentHeader(await requirementsFor(`${base}/pay/other`),fakeTx(21)));
  assert.equal(second.status,409);assert.equal((await second.json()).error,'resource_payment_in_progress');
  assert.equal(facilitator.calls.settle,1);

  const waiting=gate.waitConfirmed(tx.txHash,{timeoutMs:2000});
  facilitator.finish(tx.txHash,confirmedSettle(tx.txHash));
  assert.equal(await waiting,'confirmed');
  entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.phase,'confirmed');assert.equal(entry.state,'paid');assert.equal(entry.settlement.extra.status,'confirmed');
  assert.equal(gate.paymentStatus(tx.txHash),'confirmed');
  const after=await pay(url,header);
  assert.deepEqual(await after.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a',confirmed:true,alreadyPaid:true});
  assert.equal(handled.length,3);
 });
});

test('submitted mode: a tx that never lands moves submitted -> failed, frees the resource, stays bound',async()=>{
 const facilitator=broadcastingFacilitator();
 await withGate({facilitator,gate:SUBMITTED},async({base,journalPath,gates})=>{
  const tx=fakeTx(22);
  const header=paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx);
  assert.equal((await pay(`${base}/pay/task-a`,header)).status,200);
  const waiting=gates[0].waitConfirmed(tx.txHash,{timeoutMs:2000});
  facilitator.finish(tx.txHash,expiredSettle(tx.txHash));
  assert.equal(await waiting,'failed');
  const entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.phase,'failed');assert.equal(entry.state,'failed');assert.equal(entry.errorReason,'exact_cardano_settlement_failed');
  assert.equal(gates[0].paymentStatus(tx.txHash),'failed');
  assert.equal((await gates[0].waitConfirmed(tx.txHash)),'failed','a terminal phase answers at once');
  assert.equal((await pay(`${base}/pay/task-b`,header)).status,409,'a failed tx still cannot pay another resource');
  const retry=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/other`),fakeTx(28)));
  assert.equal(retry.status,200,'the failed payment no longer blocks the resource');
  facilitator.finish(fakeTx(28).txHash,confirmedSettle(fakeTx(28).txHash));
 });
});

test('waitConfirmed times out while nothing is known and rejects an unknown txHash',async()=>{
 const facilitator=broadcastingFacilitator();
 await withGate({facilitator,gate:SUBMITTED},async({base,gates})=>{
  const tx=fakeTx(23);
  assert.equal((await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx))).status,200);
  const started=Date.now();
  assert.equal(await gates[0].waitConfirmed(tx.txHash,{timeoutMs:60}),'timeout');
  assert.ok(Date.now()-started>=50);
  assert.equal(gates[0].paymentStatus(tx.txHash),'submitted');
  await assert.rejects(gates[0].waitConfirmed('ab'.repeat(32),{timeoutMs:10}),/no payment/);
  facilitator.finish(tx.txHash,confirmedSettle(tx.txHash));
 });
});

test('submitted mode without a broadcast hook grants on a pending settle and confirms from chain evidence',async()=>{
 let confirmations=null;
 const facilitator=mockFacilitator({settle:txHash=>({success:false,errorReason:'settlement_pending',transaction:txHash,network:NETWORK,extra:{status:'pending'}})});
 facilitator.transactionEvidence=async()=>confirmations===null?{status:'unknown',confirmations:-2}:{status:'confirmed',confirmations};
 await withGate({facilitator,gate:SUBMITTED},async({base,journalPath,gates})=>{
  const tx=fakeTx(24);
  const response=await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx));
  assert.equal(response.status,200);
  assert.equal((await response.json()).confirmed,false);
  assert.equal(readGateJournal(journalPath).payments[tx.txHash].phase,'submitted');
  const waiting=gates[0].waitConfirmed(tx.txHash,{timeoutMs:2000});
  confirmations=0;
  assert.equal(await waiting,'confirmed');
  assert.equal(readGateJournal(journalPath).payments[tx.txHash].state,'paid');
 });
});

test('waitConfirmed after a restart checks Blockfrost itself; concurrent waiters share one watcher',async()=>{
 const facilitator=broadcastingFacilitator();
 const tx=fakeTx(25);
 let txLookups=0;
 const fetchImpl=async url=>{
  const path=new URL(url).pathname;
  if(path===`/txs/${tx.txHash}`){txLookups+=1;return txLookups<2?new Response('',{status:404}):Response.json({hash:tx.txHash,block_height:100,valid_contract:true});}
  if(path==='/blocks/latest')return Response.json({height:101});
  return new Response('',{status:500});
 };
 const chain=blockfrostChain({projectId:'pid',baseUrl:'https://bf.test',fetchImpl});
 await withGate({facilitator,gate:SUBMITTED},async({base,restart,journalPath,gates})=>{
  assert.equal((await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx))).status,200);
  // The first process "dies" with its settle still running; a new gate instance on the same journal has no watcher of its own.
  await restart({chain});
  const fresh=gates[1];
  assert.equal(fresh.paymentStatus(tx.txHash),'submitted');
  const [a,b]=await Promise.all([fresh.waitConfirmed(tx.txHash,{timeoutMs:2000}),fresh.waitConfirmed(tx.txHash,{timeoutMs:2000})]);
  assert.equal(a,'confirmed');assert.equal(b,'confirmed');
  assert.equal(txLookups,2,'one shared watcher: one unknown lookup, one confirmed lookup');
  const entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.phase,'confirmed');assert.equal(entry.state,'paid');assert.equal(entry.settlement.extra.confirmations,1);
  assert.equal(gates[0].paymentStatus(tx.txHash),'confirmed','status is read from the shared journal');
 });
});

test('waitConfirmed after a restart fails a tx whose validity window closed without it landing',async()=>{
 const facilitator=broadcastingFacilitator();
 const tx=fakeTx(26,1000); // TTL slot 1000: long past on Preprod
 const chain={transactionEvidence:async()=>({status:'unknown',confirmations:-2})};
 await withGate({facilitator,gate:SUBMITTED},async({base,restart,journalPath,gates})=>{
  assert.equal((await pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx))).status,200);
  assert.match(readGateJournal(journalPath).payments[tx.txHash].validUntil,/^20\d\d-/);
  await restart({chain});
  assert.equal(await gates[1].waitConfirmed(tx.txHash,{timeoutMs:2000}),'failed');
  const entry=readGateJournal(journalPath).payments[tx.txHash];
  assert.equal(entry.phase,'failed');assert.equal(entry.errorReason,'validity_window_closed');
 });
});

test('default mode never grants on broadcast alone',async()=>{
 const facilitator=broadcastingFacilitator();
 await withGate({facilitator},async({base,journalPath,handled,gates})=>{
  const tx=fakeTx(27);
  const responding=pay(`${base}/pay/task-a`,paymentHeader(await requirementsFor(`${base}/pay/task-a`),tx));
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(handled.length,0,'broadcast is not access in the default mode');
  assert.equal(readGateJournal(journalPath).payments[tx.txHash].state,'settling');
  facilitator.finish(tx.txHash,confirmedSettle(tx.txHash));
  const response=await responding;
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{paid:true,txHash:tx.txHash,resourceId:'task-a',confirmed:true});
  assert.equal(gates[0].paymentStatus(tx.txHash),'confirmed');
 });
});
