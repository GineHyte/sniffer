import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {answer,answerReport} from './client.mjs';

function fakeClient(replies) {
 const sent=[];
 let sessions=0;
 const session={state:{sessionId:'session-test'},async send(message){
  sent.push(message);
  if(!replies.length)throw new Error('Unexpected extra model turn');
  const reply=replies.shift();
  return {result:async()=>typeof reply==='string'?{status:'completed',inputRequests:[],message:reply}:reply};
 }};
 return {sent,get sessions(){return sessions;},client:{sessions:{create:async()=>{sessions++;return {session};}}}};
}
const dir=mkdtempSync(join(tmpdir(),'client-test-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const journal=name=>join(dir,`${name}.json`);
const readJournal=name=>JSON.parse(readFileSync(journal(name),'utf8'));

const input={case_id:'case-1',task_id:'task-1',tasks:[{source:'S-1',task:'Prüfe die Rechnung'}],data:{total:'100.00'}};
const report=(overrides={})=>JSON.stringify({schema_version:'1.0',agent:'InvoiceInvestigator',case_id:'case-1',task_id:'task-1',verdict:'CLEAR',findings:[],evidence:[],checks_completed:['totals'],checks_not_verified:[],missing_information:[],critical_issue:false,explanation:'Totals match.',...overrides});
const mainReport=(overrides={})=>JSON.stringify({agent:'MainSniffer',case_id:'case-1',initial_risk_score:40,initial_risk_level:'MEDIUM',final_risk_level:'LOW',decision:'PAY',decision_reason:'All investigators clear.',decline_reasons:[],hard_stops:[],agent_reports:[],key_findings:[],evidence_references:[],missing_information:[],policy_status:'NOT_EVALUATED',supplier_payment_status:'NOT_STARTED',supplier_transaction_hash:null,explanation:'Clear.',...overrides});
const repairPrefix='Return only the JSON object matching the required schema. Problem: ';

test('valid first reply returns the parsed report from one turn',async()=>{
 const fake=fakeClient([report()]);
 const value=await answerReport('invoice',input,journal('valid'),undefined,{client:fake.client});
 assert.equal(value.verdict,'CLEAR');
 assert.deepEqual(fake.sent,[JSON.stringify(input)]);
 assert.equal(fake.sessions,1);
 assert.deepEqual(readJournal('valid'),{sessionId:'session-test',role:'invoice',phase:'answered',result:report()});
});

test('main role validates against the main report schema',async()=>{
 const fake=fakeClient([mainReport()]);
 assert.equal((await answerReport('main',{case_id:'case-1',reports:[]},journal('main'),undefined,{client:fake.client})).decision,'PAY');
});

test('invalid reply is repaired once in the same session',async()=>{
 const fake=fakeClient([report({verdict:undefined}),report()]);
 const value=await answerReport('invoice',input,journal('repair'),undefined,{client:fake.client});
 assert.equal(value.verdict,'CLEAR');
 assert.equal(fake.sessions,1);
 assert.equal(fake.sent.length,2);
 assert.ok(fake.sent[1].startsWith(repairPrefix),fake.sent[1]);
 assert.match(fake.sent[1],/verdict/);
});

test('invalid reply twice fails closed',async()=>{
 const fake=fakeClient(['not json',report({critical_issue:'no'})]);
 await assert.rejects(answerReport('invoice',input,journal('twice'),undefined,{client:fake.client}),{message:'Model output invalid after repair'});
 assert.equal(fake.sent.length,2);
 assert.equal(readJournal('twice').phase,'invalid');
});

test('wrong agent name triggers repair',async()=>{
 const fake=fakeClient([report({agent:'WalletInvestigator'}),report()]);
 await answerReport('invoice',input,journal('agent'),undefined,{client:fake.client});
 assert.equal(fake.sent.length,2);
 assert.match(fake.sent[1],/agent must be "InvoiceInvestigator"/);
});

test('case or task id mismatch triggers repair',async()=>{
 const fake=fakeClient([report({task_id:'task-2'}),report({case_id:'case-9'})]);
 await assert.rejects(answerReport('invoice',input,journal('ids'),undefined,{client:fake.client}),/invalid after repair/);
 assert.match(fake.sent[1],/task_id must be "task-1"/);
});

test('prose-wrapped JSON triggers repair',async()=>{
 const fake=fakeClient([`Here is the report:\n\`\`\`json\n${report()}\n\`\`\``,report()]);
 assert.equal((await answerReport('invoice',input,journal('prose'),undefined,{client:fake.client})).agent,'InvoiceInvestigator');
 assert.match(fake.sent[1],/single JSON object without Markdown or prose/);
});

test('report input and role are checked before any model call',async()=>{
 const fake=fakeClient([]);
 await assert.rejects(answerReport('research',input,journal('bad'),undefined,{client:fake.client}),/Unknown report role/);
 await assert.rejects(answerReport('invoice','{}',journal('bad'),undefined,{client:fake.client}),/must be a JSON object/);
 await assert.rejects(answerReport('wallet',{case_id:'case-1'},journal('bad'),undefined,{client:fake.client}),/non-empty task_id/);
 assert.equal(fake.sessions,0);
});

test('expired deadline stops before the model send',async()=>{
 const fake=fakeClient([report()]);
 await assert.rejects(answerReport('invoice',input,journal('late'),Date.now()-1,{client:fake.client}),/deadline expired before model send/);
 assert.equal(fake.sent.length,0);
});

test('answer keeps returning the plain model message',async()=>{
 const fake=fakeClient(['Five names.']);
 assert.equal(await answer('Suggest names',journal('answer'),undefined,{client:fake.client}),'Five names.');
 assert.equal(readJournal('answer').phase,'answered');
});
