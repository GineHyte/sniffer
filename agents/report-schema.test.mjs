import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InvestigatorReport,MainReport,parseModelJson,roleToAgent,rustAgentToRole} from './report-schema.mjs';

const investigator=(agent,change={})=>({
 schema_version:'1.0',agent,case_id:'case-1',task_id:'task-1',verdict:'CONCERN',
 findings:[{finding:'IBAN changed',severity:'MEDIUM',details:'Differs from the last invoice'}],
 evidence:[{source_id:'xml:BT-84',fact:'IBAN DE00…',relevance:'Payment target'}],
 checks_completed:['iban_history'],checks_not_verified:[],missing_information:[],critical_issue:false,explanation:'Factual summary.',...change
});
const main=(change={})=>({
 agent:'MainSniffer',case_id:'case-1',initial_risk_score:35,initial_risk_level:'MEDIUM',final_risk_level:'HIGH',decision:'DONT_PAY',decision_reason:'Wallet concern',
 decline_reasons:[{id:'W-03',text:'Die Empfängeradresse ist neu.',evidence:'Wallet ohne Historie'}],
 hard_stops:[],agent_reports:[],key_findings:[],evidence_references:[],missing_information:[],
 policy_status:'NOT_EVALUATED',supplier_payment_status:'BLOCKED',supplier_transaction_hash:null,explanation:'Blocked pending review.',...change
});
const json=value=>JSON.stringify(value);

test('a valid report per investigator and a valid main report pass',()=>{
 for(const agent of Object.values(roleToAgent)){
  const result=parseModelJson(json(investigator(agent)),InvestigatorReport);
  assert.equal(result.ok,true,result.error);
  assert.equal(result.value.agent,agent);
 }
 assert.equal(parseModelJson(`\n ${json(main())} \n`,MainReport).ok,true);
 assert.equal(parseModelJson(json(main({decision:'PAY',final_risk_level:'LOW',decline_reasons:[]})),MainReport).ok,true);
 assert.equal(parseModelJson(json(investigator('MainSniffer')),InvestigatorReport).ok,false);
});

test('investigator reports reject missing verdicts, unknown keys and unsupported CRITICAL verdicts',()=>{
 const {verdict,...noVerdict}=investigator('WalletInvestigator');
 assert.match(parseModelJson(json(noVerdict),InvestigatorReport).error,/verdict/);
 assert.match(parseModelJson(json(investigator('WalletInvestigator',{note:'x'})),InvestigatorReport).error,/note/);
 assert.match(parseModelJson(json(investigator('WalletInvestigator',{findings:[{finding:'f',severity:'LOW',details:'d',extra:1}]})),InvestigatorReport).error,/extra/);
 assert.match(parseModelJson(json(investigator('WalletInvestigator',{verdict:'CRITICAL',evidence:[]})),InvestigatorReport).error,/CRITICAL verdict requires/);
 assert.equal(parseModelJson(json(investigator('WalletInvestigator',{verdict:'CRITICAL',critical_issue:true})),InvestigatorReport).ok,true);
});

test('model output must be one bare JSON object',()=>{
 const body=json(investigator('InvoiceInvestigator'));
 for(const text of [`Here is the report: ${body}`,`${body}\nDone.`,`\`\`\`json\n${body}\n\`\`\``,`${body}${body}`,'[]','null',42])
  assert.equal(parseModelJson(text,InvestigatorReport).ok,false,String(text).slice(0,30));
});

test('main report enforces decision rules, decline reason limits and wording',()=>{
 const reason=index=>({id:`C-${index}`,text:'Sachlicher Grund.',evidence:'Kriterium erfüllt'});
 assert.match(parseModelJson(json(main({decision:'PAY',final_risk_level:'LOW'})),MainReport).error,/PAY requires empty/);
 assert.match(parseModelJson(json(main({decision:'PAY',final_risk_level:'HIGH',decline_reasons:[]})),MainReport).error,/PAY requires final_risk_level LOW/);
 assert.match(parseModelJson(json(main({decline_reasons:[]})),MainReport).error,/DONT_PAY requires 1-10/);
 assert.match(parseModelJson(json(main({final_risk_level:'LOW'})),MainReport).error,/DONT_PAY requires final_risk_level HIGH/);
 assert.equal(parseModelJson(json(main({decline_reasons:Array.from({length:10},(_,i)=>reason(i))})),MainReport).ok,true);
 assert.equal(parseModelJson(json(main({decline_reasons:Array.from({length:11},(_,i)=>reason(i))})),MainReport).ok,false);
 assert.match(parseModelJson(json(main({decline_reasons:[{...reason(0),text:'Verdacht auf BETRUG'}]})),MainReport).error,/decline_reasons\.0\.text/);
 assert.match(parseModelJson(json(main({decline_reasons:[{...reason(0),evidence:'possible Fraud'}]})),MainReport).error,/decline_reasons\.0\.evidence/);
 assert.equal(parseModelJson(json(main({decline_reasons:[{...reason(0),text:'x'.repeat(501)}]})),MainReport).ok,false);
});

test('errors never echo the full model output',()=>{
 const secret='prose '.repeat(500);
 const prose=parseModelJson(secret,InvestigatorReport);
 assert.equal(prose.ok,false);
 assert.ok(!prose.error.includes(secret));
 assert.ok(prose.error.length<200,prose.error);
 const broken=parseModelJson(`{"a":"${'x'.repeat(5000)}"`+' }}',InvestigatorReport);
 assert.equal(broken.ok,false);
 assert.ok(broken.error.length<200,broken.error);
 const invalid=parseModelJson(json(investigator('InvoiceInvestigator',{[`k${'y'.repeat(300)}`]:1})),InvestigatorReport);
 assert.ok(invalid.error.length<600,invalid.error);
});

test('role maps route Rust agent groups to investigators',()=>{
 assert.deepEqual({...roleToAgent},{invoice:'InvoiceInvestigator',wallet:'WalletInvestigator',supplier:'SupplierInvestigator'});
 assert.deepEqual({...rustAgentToRole},{research:'supplier',invoice:'invoice',wallet:'wallet'});
 assert.equal(roleToAgent[rustAgentToRole.research],'SupplierInvestigator');
 assert.equal(rustAgentToRole.constructor,undefined);
 assert.ok(Object.isFrozen(roleToAgent)&&Object.isFrozen(rustAgentToRole));
});
