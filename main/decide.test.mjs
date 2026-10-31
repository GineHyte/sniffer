import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide,decisionRequest,assertSendableReasons,loadCustomerTexts,FALLBACK_REASON} from './decide.mjs';
import {checkResult,investigatorReport,mainReport} from './test-fixtures.mjs';

const CASE='case-0123456789abcdef0123456789abcdef';
const result=checkResult('medium');
const customerTexts=loadCustomerTexts();
const ok=(role,options)=>({valid:true,status:'completed',report:investigatorReport(role,CASE,options)});
const allClear=()=>({invoice:ok('invoice'),wallet:ok('wallet'),supplier:ok('supplier')});
const pay=mainReport(CASE,'PAY');
const dontPay=mainReport(CASE,'DONT_PAY');
const run=(llm,reports)=>decide(llm,reports,{result,customerTexts});

test('customer texts load from the backend criteria config',()=>{
 assert.match(customerTexts['S-3'],/Zahlungsadresse/);
 assert.equal(customerTexts['T-1'],undefined);
});

test('rule 1a: a missing report → rejected/formal, no wallet block, even if the LLM says PAY',()=>{
 const reports=allClear();delete reports.wallet;
 const out=run(pay,reports);
 assert.deepEqual([out.decision,out.reason_type,out.block_wallet,out.rule],['rejected','formal',false,'missing_report']);
 assert.equal(out.decline_reasons[0].id,'AGENT_REVIEW_INCOMPLETE');
 assert.match(out.decline_reasons[0].evidence,/Zahlungsadresse \(kein Bericht\)/);
});

test('rule 1b: an invalid or timed-out report counts as missing',()=>{
 for(const entry of [{valid:false,status:'invalid',error:'bad'},{valid:false,status:'timeout'},{valid:true,report:null}]){
  const out=run(pay,{...allClear(),supplier:entry});
  assert.deepEqual([out.decision,out.reason_type,out.block_wallet],['rejected','formal',false]);
 }
 assert.match(run(pay,{...allClear(),supplier:{valid:false,status:'timeout'}}).decline_reasons[0].evidence,/Zeitüberschreitung/);
});

test('rule 1c: INSUFFICIENT_DATA → rejected/formal and wins over a CRITICAL wallet (no block)',()=>{
 const out=run(pay,{...allClear(),invoice:ok('invoice',{verdict:'INSUFFICIENT_DATA'}),wallet:ok('wallet',{verdict:'CRITICAL',critical_issue:true})});
 assert.deepEqual([out.decision,out.reason_type,out.block_wallet,out.rule],['rejected','formal',false,'insufficient_data']);
 assert.ok(out.decline_reasons.some(reason=>reason.id==='AGENT_REVIEW_INSUFFICIENT_DATA'));
});

test('rule 2: a CRITICAL report → rejected/risk even when the LLM says PAY; no block unless wallet CRITICAL+critical_issue',()=>{
 const out=run(pay,{...allClear(),supplier:ok('supplier',{verdict:'CRITICAL',critical_issue:true})});
 assert.deepEqual([out.decision,out.reason_type,out.block_wallet,out.rule],['rejected','risk',false,'critical_report']);
 assert.equal(out.decline_reasons[0].id,'AGENT_SUPPLIER');
});

test('rule 2 / A4: block_wallet only for a CRITICAL wallet report with critical_issue true',()=>{
 assert.equal(run(pay,{...allClear(),wallet:ok('wallet',{verdict:'CRITICAL',critical_issue:true})}).block_wallet,true);
 assert.equal(run(pay,{...allClear(),wallet:ok('wallet',{verdict:'CRITICAL',critical_issue:false})}).block_wallet,false);
 assert.equal(run(dontPay,{...allClear(),wallet:ok('wallet',{verdict:'CONCERN',critical_issue:true})}).block_wallet,false);
});

test('rule 3: a failed Main LLM (null or unusable) → rejected/formal, no block',()=>{
 for(const llm of [null,undefined,{decision:'MAYBE'}]){
  const out=run(llm,allClear());
  assert.deepEqual([out.decision,out.reason_type,out.block_wallet,out.rule],['rejected','formal',false,'main_llm_failed']);
  assert.equal(out.decline_reasons[0].id,'AGENT_DECISION_UNAVAILABLE');
 }
});

test('rule 4: LLM DONT_PAY with no CRITICAL → rejected/risk, reasons from criteria customer_text',()=>{
 const out=run(dontPay,{...allClear(),wallet:ok('wallet',{verdict:'CONCERN'})});
 assert.deepEqual([out.decision,out.reason_type,out.block_wallet,out.rule],['rejected','risk',false,'llm_dont_pay']);
 assert.equal(out.decline_reasons[0].id,'AGENT_WALLET');
 const s3=out.decline_reasons.find(reason=>reason.id==='S-3');
 assert.equal(s3.text,customerTexts['S-3']);
 assert.equal(s3.evidence,'supplier approved 6x, never with this wallet');
 // wallet criteria (focus role) come before invoice criteria
 assert.ok(out.decline_reasons.findIndex(r=>r.id==='W-2')<out.decline_reasons.findIndex(r=>r.id==='I-5'));
});

test('rule 5: all reports valid, none CRITICAL/INSUFFICIENT, LLM PAY → approved with no reasons',()=>{
 const out=run(pay,{...allClear(),invoice:ok('invoice',{verdict:'CONCERN'})});
 assert.deepEqual(out,{decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[],rule:'approved'});
 assert.deepEqual(decisionRequest('chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W',out),{check_id:'chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W',decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[]});
});

test('A5: reasons with Betrug/Fraud wording are never sent; 1–10 reasons, each ≤ 500 chars',()=>{
 const criteria=[
  {id:'X-1',points:50,evidence:'Verdacht auf BETRUG laut Notiz',agent:'wallet'},
  {id:'X-2',points:40,evidence:'ok',agent:'wallet'},
  ...Array.from({length:15},(_,index)=>({id:`Y-${index}`,points:10,evidence:'e'.repeat(800),agent:'invoice'})),
 ];
 const texts={'X-1':'Text eins.','X-2':'Possible fraud pattern.',...Object.fromEntries(criteria.slice(2).map(c=>[c.id,'t'.repeat(900)]))};
 const out=decide(dontPay,allClear(),{result:{...result,criteria},customerTexts:texts});
 assert.ok(out.decline_reasons.length>=1&&out.decline_reasons.length<=10);
 for(const reason of out.decline_reasons){
  assert.doesNotMatch(`${reason.text} ${reason.evidence}`,/betrug|fraud/i);
  assert.ok([...reason.text].length<=500&&[...reason.evidence].length<=500);
 }
 assert.ok(!out.decline_reasons.some(reason=>reason.id==='X-1'||reason.id==='X-2'));
 // final guard before POST
 assert.throws(()=>assertSendableReasons([{id:'S-3',text:'Fraud',evidence:''}],'rejected'),/forbidden wording/);
 assert.throws(()=>assertSendableReasons([{id:'S-3',text:'ok',evidence:'Betrugsverdacht'}],'rejected'),/forbidden wording/);
 assert.throws(()=>assertSendableReasons([],'rejected'),/1-10/);
});

test('A5: a filtered criterion leaves only clean fixed reasons',()=>{
 const out=decide(dontPay,allClear(),{result:{...result,criteria:[{id:'S-3',points:25,evidence:'fraud ring',agent:'wallet'}]},customerTexts:{'S-3':'x'}});
 assert.deepEqual(out.decline_reasons.map(reason=>reason.id),['AGENT_REVIEW_RISK']);
 assert.doesNotMatch(JSON.stringify(FALLBACK_REASON),/fraud|betrug/i);
});

test('decisionRequest: block_wallet is never sent for formal rejections',()=>{
 const body=decisionRequest('chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W',{decision:'rejected',reason_type:'formal',block_wallet:true,decline_reasons:[{id:'a',text:'b',evidence:''}]});
 assert.equal(body.block_wallet,false);
});
