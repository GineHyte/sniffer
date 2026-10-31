import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {decodePaymentRequiredHeader,encodePaymentSignatureHeader} from '@x402/core/http';
import {decodeCardanoTransaction} from '@x402/cardano';
import {createInvestigatorServer,createInvestigatorGate,taskIdFromPath} from './api.mjs';
import {createInvestigatorWorker} from './worker.mjs';
import {readGateJournal} from '../x402/gate.mjs';
import {target,inputText,validReport,fakeSokosumi} from './test-fixtures.mjs';

const NETWORK='cardano:preprod';
const PAY_TO='addr_test1vqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpcjw59ta';
const PRICE='1000000';

// Minimal well-formed Cardano tx (same shape as x402/gate.test.mjs); the seed varies the tx id.
function fakeTx(seed){
 const input=Buffer.alloc(32,seed).toString('hex');
 const hex='84a3'+'0081825820'+input+'00'+'0181'+'82581d'+'60'+'07'.repeat(28)+'1a000f4240'+'021a00029810'+'a0f5f6';
 const transaction=Buffer.from(hex,'hex').toString('base64');
 return {transaction,nonce:`${input}#0`,txHash:decodeCardanoTransaction(transaction).txHash};
}

function mockFacilitator(){
 const calls={verify:0,settle:0};
 return {calls,
  getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:NETWORK}],extensions:[],signers:{}}),
  verify:async()=>{calls.verify+=1;return {isValid:true,payer:'addr_test1payer'};},
  settle:async payload=>{calls.settle+=1;const txHash=decodeCardanoTransaction(payload.payload.transaction).txHash;
   return {success:true,transaction:txHash,network:NETWORK,payer:'addr_test1payer',extra:{status:'confirmed',confirmations:0}};}};
}

async function withApi(run){
 const dir=mkdtempSync(join(tmpdir(),'investigator-api-'));
 const paths={gateJournal:join(dir,'gate-journal.json'),tasksDir:join(dir,'tasks')};
 const facilitator=mockFacilitator();
 const errors=[];
 const gate=createInvestigatorGate({priceLovelace:PRICE,payTo:PAY_TO,facilitator,journalPath:paths.gateJournal});
 const server=createInvestigatorServer({role:'invoice',gate,log:{error:(...a)=>errors.push(a.join(' '))}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{await run({base,paths,facilitator,errors});}
 finally{await new Promise(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
}

async function requirementsFor(url){
 const response=await fetch(url,{method:'POST'});
 assert.equal(response.status,402);
 return decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
}
const header=(required,tx)=>encodePaymentSignatureHeader({x402Version:2,payload:{transaction:tx.transaction,nonce:tx.nonce},resource:required.resource,accepted:required.accepts[0]});
const pay=(url,value)=>fetch(url,{method:'POST',headers:{'PAYMENT-SIGNATURE':value}});

test('taskIdFromPath accepts exactly /pay/{valid Sokosumi task ID}',()=>{
 assert.equal(taskIdFromPath('/pay/cm1abc_DEF-2'),'cm1abc_DEF-2');
 for(const bad of ['/pay/','/pay/a/b','/pay/..%2Fx','/pay/a%2Fb','/pay/-lead','/pay/%E0%A4%A','/payx/a','/pay/a%20b'])assert.equal(taskIdFromPath(bad),null,bad);
});

test('health, routing and task ID validation happen before the gate',async()=>{
 await withApi(async({base,facilitator})=>{
  const health=await fetch(`${base}/health`);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true,role:'invoice'});
  assert.equal((await fetch(`${base}/pay/task-a`)).status,405);
  assert.equal((await fetch(`${base}/pay/a%2Fb`,{method:'POST'})).status,400);
  assert.equal((await fetch(`${base}/nope`)).status,404);
  const oversized=await new Promise((resolve,reject)=>{
   const req=request(`${base}/pay/task-a`,{method:'POST',headers:{'content-length':String(70*1024)}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.flushHeaders();
  });
  assert.equal(oversized,413);
  assert.equal(facilitator.calls.verify,0);
 });
});

test('a confirmed payment is recorded for the Sokosumi task ID and starts no work',async()=>{
 await withApi(async({base,paths,facilitator})=>{
  const url=`${base}/pay/task-a`;
  const required=await requirementsFor(url);
  assert.equal(required.accepts[0].amount,PRICE);
  assert.equal(required.accepts[0].payTo,PAY_TO);
  const tx=fakeTx(1);
  const response=await pay(url,header(required,tx));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{task_id:'task-a',paid:true,tx_hash:tx.txHash});
  const entry=readGateJournal(paths.gateJournal).payments[tx.txHash];
  assert.equal(entry.resourceId,'task-a');
  assert.equal(entry.state,'paid');
  assert.equal(existsSync(paths.tasksDir),false,'the API writes no task state');
  // Idempotent: the paid task answers paid again without a new settle.
  const again=await fetch(url,{method:'POST'});
  assert.equal(again.status,200);
  assert.equal((await again.json()).tx_hash,tx.txHash);
  assert.equal(facilitator.calls.settle,1);
 });
});

test('a payment replayed for another task does not unlock that task in the worker',async()=>{
 await withApi(async({base,paths,facilitator})=>{
  const tx=fakeTx(2);
  const paid=header(await requirementsFor(`${base}/pay/task-a`),tx);
  assert.equal((await pay(`${base}/pay/task-a`,paid)).status,200);
  const replay=await pay(`${base}/pay/task-b`,paid);
  assert.equal(replay.status,409);
  assert.equal((await replay.json()).error,'payment_already_used');
  assert.equal(facilitator.calls.settle,1);

  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()},{id:'task-b',status:'READY',description:inputText('invoice','chk_02')}]);
  const seen=[];
  const worker=createInvestigatorWorker({role:'invoice',target,paths,cli:soko.cli,log:{log(){},error(){}},
   answerReport:async(role,input)=>{seen.push(input.case_id);return validReport(input);}});
  const summary=await worker.tick();
  assert.deepEqual(summary.started,['task-a']);
  assert.deepEqual(summary.skipped,['task-b']);
  assert.deepEqual(seen,['chk_01']);
  assert.equal(soko.byId.get('task-b').status,'READY');
  assert.equal(soko.calls.filter(c=>c[1]==='start'&&c[2]==='task-b').length,0);
 });
});

test('the server refuses an unknown role or a missing gate',()=>{
 assert.throws(()=>createInvestigatorServer({role:'main',gate:async()=>null}),/role/);
 assert.throws(()=>createInvestigatorServer({role:'invoice'}),/gate/);
});
