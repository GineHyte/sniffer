import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {encodePaymentRequiredHeader,encodePaymentResponseHeader,decodePaymentSignatureHeader} from '@x402/core/http';
import {decodeCardanoTransaction} from '@x402/cardano';
import {payOnce,payJournalPath,readPayJournal,writeJsonAtomic,createKeyedQueue} from './pay.mjs';
import {x402Gate} from './gate.mjs';

const NETWORK='cardano:preprod';
const PAY_TO='addr_test1vqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpcjw59ta';
const PAYER='addr_test1vzpayerwalletforpaytestsonly0000000000000000000000000';
const REQUIREMENTS={scheme:'exact',network:NETWORK,amount:'1000000',asset:'lovelace',payTo:PAY_TO,maxTimeoutSeconds:600,extra:{areFeesSponsored:false,confirmationPolicy:{l1Confirmations:0}}};
const temp=()=>mkdtempSync(join(tmpdir(),'x402-pay-'));

function fakeTx(seed){
 const input=Buffer.alloc(32,seed).toString('hex');
 const hex='84a3'+'0081825820'+input+'00'+'0181'+'82581d'+'60'+'07'.repeat(28)+'1a000f4240'+'021a00029810'+'a0f5f6';
 return {transaction:Buffer.from(hex,'hex').toString('base64'),nonce:`${input}#0`};
}

// Mock ClientCardanoSigner: signs nothing real, records calls, optionally inspects the journal at signing time.
function mockSigner({address=PAYER,onSign}={}){
 let seed=0;
 const signer={signed:0,getAddress:()=>address,
  buildAndSignPaymentTransaction:async requirements=>{signer.signed+=1;seed+=1;await onSign?.(requirements);return fakeTx(seed);}};
 return signer;
}

// Mock x402 resource server behind fetch: 402 first, then a receipt for whatever tx was offered.
function mockServer({settle,delayMs=0,requirements=REQUIREMENTS,events=[]}={}){
 const fetchImpl=async request=>{
  const label=new URL(request.url).pathname;
  const header=request.headers.get('PAYMENT-SIGNATURE');
  events.push(`${header?'paid':'probe'}:${label}`);
  await sleep(delayMs);
  if(!header){
   const paymentRequired={x402Version:2,error:'Payment required',resource:{url:request.url,description:'',mimeType:'application/json'},accepts:[requirements]};
   return new Response('{}',{status:402,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader(paymentRequired),'content-type':'application/json'}});
  }
  const txHash=decodeCardanoTransaction(decodePaymentSignatureHeader(header).payload.transaction).txHash;
  const receipt=settle?settle(txHash):{success:true,transaction:txHash,network:NETWORK,payer:PAYER,extra:{status:'confirmed',confirmations:0}};
  events.push(`done:${label}`);
  return new Response(JSON.stringify({ok:receipt.success}),{status:receipt.success?200:402,headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(receipt),'content-type':'application/json'}});
 };
 fetchImpl.events=events;
 return fetchImpl;
}

const args=(dir,extra={})=>({url:'http://127.0.0.1:9/pay/task-a',key:'case1-invoice',journalDir:dir,payTo:PAY_TO,maxLovelace:'2000000',init:{method:'POST'},...extra});

test('pays once: journal is pending before signing, then paid with the tx hash',async()=>{
 const dir=temp();
 try{
  const path=payJournalPath(dir,'case1-invoice');
  const seenAtSigning=[];
  const signer=mockSigner({onSign:()=>{seenAtSigning.push(readPayJournal(path));}});
  const result=await payOnce({...args(dir),signer,fetchImpl:mockServer()});
  assert.equal(seenAtSigning.length,1);
  assert.equal(seenAtSigning[0].phase,'pending');assert.equal(seenAtSigning[0].txHash,undefined);
  assert.equal(result.phase,'paid');assert.equal(result.paymentMade,true);
  assert.equal(result.txHash,decodeCardanoTransaction(fakeTx(1).transaction).txHash);
  assert.deepEqual(readPayJournal(path),result);
  const text=readFileSync(path,'utf8');
  assert.equal(text.includes(fakeTx(1).transaction),false,'journal must not hold the signed tx');
  assert.deepEqual(readdirSync(dir),['pay-case1-invoice.json'],'no temp files left behind');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an existing paid journal returns without a new payment',async()=>{
 const dir=temp();
 try{
  const paid={key:'case1-invoice',phase:'paid',txHash:'ab'.repeat(32)};
  writeJsonAtomic(payJournalPath(dir,'case1-invoice'),paid);
  const signer=mockSigner();
  const fetchImpl=mockServer();
  assert.deepEqual(await payOnce({...args(dir),signer,fetchImpl}),paid);
  assert.equal(signer.signed,0);assert.deepEqual(fetchImpl.events,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an unknown journal throws "inspect" and never retries',async()=>{
 const dir=temp();
 try{
  writeJsonAtomic(payJournalPath(dir,'case1-invoice'),{key:'case1-invoice',phase:'unknown',txHash:'cd'.repeat(32)});
  const signer=mockSigner();const fetchImpl=mockServer();
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl}),error=>/inspect/i.test(error.message)&&error.message.includes('cd'.repeat(32)));
  assert.equal(signer.signed,0);assert.deepEqual(fetchImpl.events,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a stale or in-progress pending journal throws "inspect"; a corrupt journal too',async()=>{
 const dir=temp();
 try{
  const path=payJournalPath(dir,'case1-invoice');
  const signer=mockSigner();const fetchImpl=mockServer();
  writeJsonAtomic(path,{key:'case1-invoice',phase:'pending',createdAt:'2026-10-31T10:00:00.000Z',updatedAt:'2026-10-31T10:00:00.000Z'});
  const now=()=>new Date('2026-10-31T11:00:00.000Z');
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl,now}),/stale pending payment[\s\S]*[Ii]nspect/);
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl,now:()=>new Date('2026-10-31T10:01:00.000Z')}),/still in progress[\s\S]*[Ii]nspect/);
  writeFileSync(path,'{"phase":');
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl}),/[Ii]nspect/);
  assert.equal(signer.signed,0);assert.deepEqual(fetchImpl.events,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a failed settle after signing becomes unknown and is never retried',async()=>{
 const dir=temp();
 try{
  const signer=mockSigner();
  const fetchImpl=mockServer({settle:txHash=>({success:false,errorReason:'settlement_pending',transaction:txHash,network:NETWORK})});
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl}),/inspect/i);
  const journal=readPayJournal(payJournalPath(dir,'case1-invoice'));
  assert.equal(journal.phase,'unknown');assert.match(journal.txHash,/^[0-9a-f]{64}$/);
  assert.equal(signer.signed,1);
  await assert.rejects(payOnce({...args(dir),signer,fetchImpl}),/inspect/i);
  assert.equal(signer.signed,1,'no second signature');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('requirements outside the cap or to another address are never signed',async()=>{
 const dir=temp();
 try{
  for(const [patch,reason] of [[{amount:'2000001'},/maxAmountPerPayment/],[{payTo:'addr_test1vqother0000000000000000000000000000000000000000000000'},/payTo/]]){
   const signer=mockSigner();
   await assert.rejects(payOnce({...args(dir),signer,fetchImpl:mockServer({requirements:{...REQUIREMENTS,...patch}})}),reason);
   assert.equal(signer.signed,0);
   assert.equal(readPayJournal(payJournalPath(dir,'case1-invoice')).phase,'failed_before_signing');
  }
  // A clean pre-signing failure is safe to try again.
  const signer=mockSigner();
  assert.equal((await payOnce({...args(dir),signer,fetchImpl:mockServer()})).phase,'paid');
  assert.equal(readPayJournal(payJournalPath(dir,'case1-invoice')).attempt,3);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('two concurrent payOnce calls on one wallet run one after another',async()=>{
 const dir=temp();
 try{
  const signer=mockSigner();
  const fetchImpl=mockServer({delayMs:30});
  const [a,b]=await Promise.all([
   payOnce({...args(dir),url:'http://127.0.0.1:9/pay/task-a',key:'case1-invoice',signer,fetchImpl}),
   payOnce({...args(dir),url:'http://127.0.0.1:9/pay/task-b',key:'case1-wallet',signer,fetchImpl}),
  ]);
  assert.equal(a.phase,'paid');assert.equal(b.phase,'paid');assert.notEqual(a.txHash,b.txHash);
  assert.deepEqual(fetchImpl.events,['probe:/pay/task-a','paid:/pay/task-a','done:/pay/task-a','probe:/pay/task-b','paid:/pay/task-b','done:/pay/task-b']);
  // Different wallets are not serialized against each other.
  const other=mockServer({delayMs:30});
  await Promise.all([
   payOnce({...args(dir),key:'w1',signer:mockSigner({address:'addr_test1vqwalletone'}),fetchImpl:other}),
   payOnce({...args(dir),key:'w2',signer:mockSigner({address:'addr_test1vqwallettwo'}),fetchImpl:other}),
  ]);
  assert.deepEqual(other.events.slice(0,2).map(event=>event.split(':')[0]),['probe','probe']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('keyed queue keeps running after a failed task',async()=>{
 const queue=createKeyedQueue();
 const order=[];
 const first=queue('w',async()=>{await sleep(10);order.push(1);throw new Error('boom');});
 const second=queue('w',async()=>{order.push(2);return 'ok';});
 await assert.rejects(first,/boom/);
 assert.equal(await second,'ok');
 assert.deepEqual(order,[1,2]);
});

test('end to end against the gate: pay, then a second key for the same resource pays nothing',async()=>{
 const dir=temp();
 const calls={settle:0};
 const facilitator={
  getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network:NETWORK}],extensions:[],signers:{}}),
  verify:async()=>({isValid:true,payer:PAYER}),
  settle:async payload=>{calls.settle+=1;return {success:true,transaction:decodeCardanoTransaction(payload.payload.transaction).txHash,network:NETWORK,payer:PAYER,extra:{status:'confirmed',confirmations:0}};},
 };
 const gate=x402Gate({priceLovelace:'1000000',payTo:PAY_TO,facilitator,journalPath:join(dir,'gate.json'),resourceId:req=>req.url.split('/')[2]});
 const recorded=[];
 const server=createServer(async(req,res)=>{
  const paid=await gate(req,res);
  if(!paid)return;
  recorded.push(paid.txHash);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'paid'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/pay/task-a`;
  const signer=mockSigner();
  const first=await payOnce({...args(dir),url,key:'k1',signer});
  assert.equal(first.phase,'paid');assert.equal(first.paymentMade,true);
  assert.equal(first.response.status,200);assert.match(first.response.body,/paid/);
  assert.deepEqual(recorded,[first.txHash]);
  const second=await payOnce({...args(dir),url,key:'k2',signer});
  assert.equal(second.phase,'paid');assert.equal(second.paymentMade,false);assert.equal(second.txHash,first.txHash);
  assert.equal(signer.signed,1);assert.equal(calls.settle,1);
  assert.equal(existsSync(join(dir,'gate.json')),true);
 }finally{
  await new Promise(resolve=>server.close(()=>resolve()));
  rmSync(dir,{recursive:true,force:true});
 }
});
