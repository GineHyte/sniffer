import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createCustomerApi,loadConfig,looksLikeEInvoice,checkProjection,HttpError} from './api.mjs';
import {createMockDeps,mockCaseView,scenarioFor,INTAKE_CONFIRM_MS} from './mock.mjs';
import {intakeIds} from '../main/case-store.mjs';

const XML=readFileSync(new URL('../docs/fixtures/f1.xml',import.meta.url),'utf8');
const config=loadConfig({INTAKE_PRICE_LOVELACE:'2000000'},{mock:false});

async function withApi(deps,run){
 const server=createServer(createCustomerApi({config,...deps}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=body=>fetch(`${base}/api/invoices`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try{await run({base,post});}finally{await new Promise(resolve=>server.close(resolve));}
}

function fakeDeps({cases={},payError=null,check=null}={}){
 const calls={pay:[],getCheck:0};
 return {calls,
  main:{health:async()=>true,getCase:async id=>cases[id]?{status:200,body:cases[id]}:{status:404,body:{error:'not_found'}}},
  pay:async(xml,caseId)=>{calls.pay.push(caseId);if(payError)throw payError;return {caseId,txHash:'ab'.repeat(32)};},
  backend:{getCheck:async()=>{calls.getCheck+=1;if(!check)throw Object.assign(new Error('down'),{code:'backend_unavailable'});return {result:check};}}};
}

test('looksLikeEInvoice accepts CII and UBL roots and rejects other XML', ()=>{
 assert.equal(looksLikeEInvoice(XML),true);
 assert.equal(looksLikeEInvoice('﻿<?xml version="1.0"?><!-- c --><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>'),true);
 assert.equal(looksLikeEInvoice('<html><body>no</body></html>'),false);
 assert.equal(looksLikeEInvoice('<InvoiceList/>'),false);
});

test('loadConfig refuses a live start without an intake price', ()=>{
 assert.throws(()=>loadConfig({}),/INTAKE_PRICE_LOVELACE/);
 assert.equal(loadConfig({},{mock:true}).mode,'mock');
});

test('POST /api/invoices pays a new XML once and answers 202 with the case ID', async()=>{
 const deps=fakeDeps();
 await withApi(deps,async({post})=>{
  const response=await post({xml:XML});
  assert.equal(response.status,202);
  const body=await response.json();
  assert.equal(body.case_id,intakeIds(XML).caseId);
  assert.equal(body.existing,false);
  assert.deepEqual(deps.calls.pay,[intakeIds(XML).caseId]);
 });
});

test('an XML whose case already exists at Main is not paid again', async()=>{
 const {caseId}=intakeIds(XML);
 const deps=fakeDeps({cases:{[caseId]:{case_id:caseId,intake:{tx_hash:'cd'.repeat(32)}}}});
 await withApi(deps,async({post})=>{
  const response=await post({xml:XML});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{case_id:caseId,existing:true,payment_tx_hash:'cd'.repeat(32)});
  assert.equal(deps.calls.pay.length,0);
 });
});

test('invalid bodies and non-invoices are refused before any payment', async()=>{
 const deps=fakeDeps();
 await withApi(deps,async({base,post})=>{
  assert.equal((await post({xml:''})).status,400);
  assert.equal((await post({xml:XML,extra:1})).status,400);
  assert.equal((await post({xml:'<html/>'})).status,422);
  assert.equal((await fetch(`${base}/api/invoices`,{method:'POST',headers:{'content-type':'text/xml'},body:XML})).status,415);
  assert.equal((await post({xml:`<Invoice>${'x'.repeat(config.maxXmlBytes)}</Invoice>`})).status,413);
  assert.equal(deps.calls.pay.length,0);
 });
});

test('a refused intake passes through as 503 too_many_unconfirmed_intakes', async()=>{
 await withApi(fakeDeps({payError:new HttpError(503,'too_many_unconfirmed_intakes')}),async({post})=>{
  const response=await post({xml:XML});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'too_many_unconfirmed_intakes'});
 });
});

test('GET /api/cases joins the case view with the fired criteria and caches the check', async()=>{
 const {caseId}=intakeIds(XML);
 const check={check_id:'chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W',checked_at:'2026-10-31T10:00:03Z',
  summary:{band:'medium',decision:'review',risk_score:42,ko_triggered:false,checks_incomplete:[],decline_reasons:[]},
  criteria:[{id:'S-9',name:'Neuer Lieferant',points:12,evidence:'no history',agent:'research'}],reducers:[],invoice:{secret:'not projected'}};
 const deps=fakeDeps({cases:{[caseId]:{case_id:caseId,status:'investigating',check_id:check.check_id}},check});
 await withApi(deps,async({base})=>{
  for(let i=0;i<2;i+=1){
   const body=await (await fetch(`${base}/api/cases/${caseId}`)).json();
   assert.equal(body.case.status,'investigating');
   assert.deepEqual(body.check.criteria,check.criteria);
   assert.equal(body.check.risk_score,42);
   assert.equal(body.check.invoice,undefined);
  }
  assert.equal(deps.calls.getCheck,1);
  assert.equal((await fetch(`${base}/api/cases/case-nope`)).status,404);
 });
});

test('a backend outage keeps the case view and reports check_error', async()=>{
 const {caseId}=intakeIds(XML);
 const deps=fakeDeps({cases:{[caseId]:{case_id:caseId,status:'completed',check_id:'chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W'}}});
 await withApi(deps,async({base})=>{
  const body=await (await fetch(`${base}/api/cases/${caseId}`)).json();
  assert.equal(body.check,null);
  assert.equal(body.check_error,'backend_unavailable');
 });
});

test('checkProjection keeps only score, band and criteria', ()=>{
 assert.equal(checkProjection(null),null);
 const projected=checkProjection({check_id:'c',checked_at:'t',summary:{band:'low',decision:'approve',risk_score:3,ko_triggered:false,checks_incomplete:['X']},
  criteria:[{id:'I-1',name:'n',points:3,evidence:'e',agent:'invoice',extra:1}],reducers:[{id:'T-1',name:'r',points:-5,evidence:'e'}]});
 assert.deepEqual(projected.criteria,[{id:'I-1',name:'n',points:3,evidence:'e',agent:'invoice'}]);
 assert.deepEqual(projected.reducers,[{id:'T-1',name:'r',points:-5,evidence:'e'}]);
});

test('mock cases move through the Main statuses and refuse a second unconfirmed intake', async()=>{
 let clock=1_000_000;
 const deps=createMockDeps({now:()=>clock,sleep:async()=>{}});
 const ids=['case-'+'0'.repeat(32),'case-'+'1'.repeat(32)];
 await deps.pay('',ids[0]);
 await assert.rejects(deps.pay('',ids[1]),error=>error.status===503);
 clock+=INTAKE_CONFIRM_MS;
 await deps.pay('',ids[1]);
 const view=mockCaseView(ids[0],0,60_000);
 assert.equal(view.status,'completed');
 assert.equal(scenarioFor(ids[0]),'low');
 assert.equal(view.payout.state,'confirmed');
 assert.equal(mockCaseView(ids[1],0,0).intake.state,'submitted');
});
