import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {decodePaymentRequiredHeader,encodePaymentSignatureHeader} from '@x402/core/http';
import {decodeCardanoTransaction} from '@x402/cardano';
import {x402Gate} from '../x402/gate.mjs';
import {createMainApi,createCaseRunner,loadConfig} from './api.mjs';
import {intakeIds} from './case-store.mjs';
import {tempStore,testConfig,F9_XML,ADDR,seedCase} from './test-fixtures.mjs';

const NETWORK='cardano:preprod';

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

async function withApi(run,{config=testConfig()}={}){
 const temp=tempStore();
 const facilitator=mockFacilitator();
 const started=[];
 const gate=x402Gate({priceLovelace:config.intake.priceLovelace,payTo:config.intake.payTo,facilitator,resourceId:req=>req.snifferResourceId,journalPath:join(temp.dir,'intake-gate.json')});
 const server=createServer(createMainApi({config,store:temp.store,gate,runner:{start:caseId=>started.push(caseId)}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{await run({base,store:temp.store,started,facilitator});}
 finally{await new Promise(resolve=>server.close(resolve));temp.cleanup();}
}

const post=(base,body,headers={})=>fetch(`${base}/v1/invoices`,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
const paymentHeader=(paymentRequired,tx)=>encodePaymentSignatureHeader({x402Version:2,payload:{transaction:tx.transaction,nonce:tx.nonce},resource:paymentRequired.resource,accepted:paymentRequired.accepts[0]});

test('unpaid intake → 402 with requirements; no case, no orchestration',async()=>{
 await withApi(async({base,store,started,facilitator})=>{
  const response=await post(base,{xml:F9_XML});
  assert.equal(response.status,402);
  const required=decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(required.accepts[0].amount,'1000000');
  assert.equal(required.accepts[0].payTo,ADDR('a'));
  assert.deepEqual(started,[]);
  assert.deepEqual(store.list(),[]);
  assert.equal(facilitator.calls.settle,0);
 });
});

test('paid intake → 202 with case id and status URL; the case starts once; replay for another XML is refused',async()=>{
 await withApi(async({base,store,started,facilitator})=>{
  const required=decodePaymentRequiredHeader((await post(base,{xml:F9_XML})).headers.get('PAYMENT-REQUIRED'));
  const tx=fakeTx(7);
  const header=paymentHeader(required,tx);
  const response=await post(base,{xml:F9_XML},{'PAYMENT-SIGNATURE':header});
  assert.equal(response.status,202);
  const body=await response.json();
  const {caseId}=intakeIds(F9_XML);
  assert.deepEqual(body,{case_id:caseId,status:'accepted',status_url:`/v1/cases/${caseId}`,payment_tx_hash:tx.txHash});
  assert.deepEqual(started,[caseId]);
  assert.equal(store.read(caseId).intake.tx_hash,tx.txHash);
  assert.equal(existsSync(store.xmlPath(caseId)),true);

  const view=await (await fetch(`${base}${body.status_url}`)).json();
  assert.equal(view.case_id,caseId);
  assert.equal(view.status,'accepted');
  assert.doesNotMatch(JSON.stringify(view),/Alpha Consulting|addr_test1/);

  // The same paid XML again: idempotent, same case, no second settle.
  const again=await post(base,{xml:F9_XML});
  assert.equal(again.status,202);
  assert.equal((await again.json()).case_id,caseId);
  // The same payment for a different XML is a replay.
  const other=F9_XML.replace('RE-2026-0412','RE-2026-0413');
  const replay=await post(base,{xml:other},{'PAYMENT-SIGNATURE':header});
  assert.equal(replay.status,409);
  assert.equal((await replay.json()).error,'payment_already_used');
  assert.equal(facilitator.calls.settle,1);
  assert.deepEqual(store.list(),[caseId]);
 });
});

test('raw application/xml bodies are accepted the same way',async()=>{
 await withApi(async({base})=>{
  const response=await fetch(`${base}/v1/invoices`,{method:'POST',headers:{'content-type':'application/xml'},body:F9_XML});
  assert.equal(response.status,402);
 });
});

test('invalid intake requests are rejected before any payment is asked for',async()=>{
 await withApi(async({base,started})=>{
  assert.equal((await post(base,'not json')).status,400);
  assert.equal((await post(base,{xml:1})).status,400);
  assert.equal((await post(base,{xml:F9_XML,extra:true})).status,400);
  assert.equal((await post(base,{xml:'   '})).status,400);
  assert.equal((await fetch(`${base}/v1/invoices`,{method:'POST',headers:{'content-type':'text/plain'},body:F9_XML})).status,415);
  assert.equal((await fetch(`${base}/v1/invoices`)).status,405);
  assert.equal((await fetch(`${base}/v1/cases/case-0000`)).status,404);
  assert.equal((await fetch(`${base}/v1/cases/case-${'0'.repeat(32)}`)).status,404);
  assert.deepEqual(started,[]);
 });
 await withApi(async({base})=>{
  const response=await post(base,{xml:F9_XML});
  assert.equal(response.status,413);
  assert.equal((await response.json()).error,'xml_too_large');
 },{config:testConfig({maxXmlBytes:1000})});
});

test('case runner starts a case once at a time and resumes only open cases',async()=>{
 const temp=tempStore();
 try{
  const open=seedCase(temp.store);
  const done=seedCase(temp.store,F9_XML.replace('RE-2026-0412','RE-X'));
  temp.store.write({...temp.store.read(done),status:'completed'});
  const runs=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const runner=createCaseRunner({store:temp.store,log:()=>{}},{run:async caseId=>{runs.push(caseId);await gate;}});
  const first=runner.start(open);
  assert.equal(runner.start(open),first);
  release();
  await first;
  await runner.resumeAll();
  assert.deepEqual(runs,[open,open]);
 }finally{temp.cleanup();}
});

test('loadConfig validates required settings and uses safe defaults',()=>{
 const env={INTAKE_PRICE_LOVELACE:'1000000',INTAKE_PAY_TO:ADDR('a'),INVESTIGATOR_PRICE_LOVELACE:'2000000',SOKOSUMI_ORGANIZATION_SLUG:'team-ws'};
 for(const [index,role] of ['INVOICE','WALLET','SUPPLIER'].entries()){
  env[`COWORKER_ID_${role}`]=`cw-${role}`;env[`INVESTIGATOR_${role}_URL`]=`http://127.0.0.1:${21961+index}/`;env[`INVESTIGATOR_${role}_PAY_TO`]=ADDR(String(index));
 }
 const config=loadConfig(env);
 assert.equal(config.port,21951);
 assert.equal(config.investigationTimeoutMs,15*60_000);
 assert.equal(config.investigators.wallet.url,'http://127.0.0.1:21962');
 assert.deepEqual(config.taskArgs,['--organization-slug','team-ws']);
 assert.throws(()=>loadConfig({...env,COWORKER_ID_WALLET:''}),/COWORKER_ID_WALLET/);
 assert.throws(()=>loadConfig({...env,INTAKE_PAY_TO:'addr1qmainnet'}),/INTAKE_PAY_TO/);
 assert.throws(()=>loadConfig({...env,INVESTIGATOR_PRICE_LOVELACE:'1.5'}),/INVESTIGATOR_PRICE_LOVELACE/);
 assert.throws(()=>loadConfig({...env,INVESTIGATION_TIMEOUT_MS:'-1'}),/INVESTIGATION_TIMEOUT_MS/);
});
