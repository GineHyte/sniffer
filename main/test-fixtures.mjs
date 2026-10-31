// Shared fixtures for main/*.test.mjs. No live services: every external call is a recording mock.
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeJsonAtomic,payJournalPath} from '../x402/pay.mjs';
import {createCaseStore,intakeIds} from './case-store.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
export const F9_XML=readFileSync(join(HERE,'..','docs','fixtures','f9.xml'),'utf8');
export const CHECK_ID='chk_01JBX7ZQ8V3K6M2N4P5R7S9T0W';
export const SUPPLIER_HASH=`hmac:${'c3'.repeat(32)}`;
export const ADDR=suffix=>`addr_test1vq${suffix.repeat(40).slice(0,50)}`;

export function checkResult(band,overrides={}){
 return {
  schema_version:'1.0',check_id:CHECK_ID,checked_at:'2026-10-30T12:00:00Z',engine:{version:'1.0.0',config_sha256:'0'.repeat(64)},
  summary:{band,decision:{low:'approve',medium:'review',high:'decline'}[band],final:band!=='medium',reason_type:band==='high'?'risk':null,
   risk_score:{low:5,medium:58,high:85}[band],ko_triggered:false,
   decline_reasons:band==='high'?[{id:'W-1',text:'Zur Zahlungsadresse liegen bestätigte Meldungen in einer Scam-Datenbank vor.',evidence:'2 trusted reports'}]:[],
   checks_incomplete:[],checks_skipped:[]},
  invoice:{invoice_hash:`hmac:${'4f'.repeat(32)}`,xml_ref:`/v1/checks/${CHECK_ID}/xml`,profile:'xrechnung_3.0',
   validation:{tool:'mustang',tool_version:'2.26.0',status:'valid',errors:0,error_rules:[],whitelisted_rules:[]},
   invoice_number:'RE-2026-0412',type_code:'380',issue_date:'2026-10-28',due_date:'2026-10-30',total:{amount:'833.00',currency:'EUR'},
   due_payable:{amount:'833.00',currency:'EUR'},payment:{means_code:'ZZZ',network:'preprod',asset:'ADA',address_type:'base',credential_type:'key',
    address_hash:`hmac:${'9b'.repeat(32)}`,wallet_hash:`hmac:${'2d'.repeat(32)}`},order_reference:'PO-2026-001'},
  supplier:{supplier_hash:SUPPLIER_HASH,country:'DE',vat_country:'DE',vat_valid:true,known:true,approved:6,trust:0.545,blocked:false,first_invoice:false},
  wallet:{wallet_hash:`hmac:${'2d'.repeat(32)}`,known:false,approved:0,rejected_risk:0,trust:0,blocked:false,has_transactions:true,first_tx_at:'2026-10-27T12:00:00Z',age_days:3,chainabuse:{reports:0,trusted_or_checked:0}},
  pair:{pair_hash:`hmac:${'7a'.repeat(32)}`,approved:0,rejected_risk:0},
  signature:{status:'absent',scheme:null,key_hash:null,matches_known_key:null},
  criteria:band==='medium'?[
   {id:'S-3',name:'Known supplier, new wallet',points:25,evidence:'supplier approved 6x, never with this wallet',agent:'wallet'},
   {id:'W-2',name:'Young address',points:15,evidence:'first transaction 2026-10-27, 3 days before check',agent:'wallet'},
   {id:'I-5',name:'Pressure wording',points:10,evidence:'pressure wording: dringend, neue wallet',agent:'invoice'},
   {id:'I-7',name:'Due date < 3 days',points:8,evidence:'BT-2 2026-10-28, BT-9 2026-10-30 (2 days)',agent:'invoice'},
  ]:[],
  reducers:[],
  agent_tasks:band==='medium'?{
   invoice:[{source:'I-5',task:'Prüfe, warum die Rechnung zu schneller Zahlung drängt.'},{source:'I-7',task:'Prüfe, ob ein Zahlungsziel unter 3 Tagen vereinbart ist.'}],
   wallet:[{source:'S-3',task:'Prüfe, ob der Rechnungssteller die neue Zahlungsadresse bestätigt hat.'},{source:'W-2',task:'Prüfe, warum eine sehr neue Zahlungsadresse verwendet wird.'}],
   research:[{source:'VIES_UNAVAILABLE',task:'Prüfe die Umsatzsteuer-Identifikationsnummer des Rechnungsstellers.'}],
  }:{invoice:[],wallet:[],research:[]},
  ...overrides,
 };
}

const AGENT={invoice:'InvoiceInvestigator',wallet:'WalletInvestigator',supplier:'SupplierInvestigator'};
export function investigatorReport(role,caseId,{verdict='CLEAR',critical_issue=false,...overrides}={}){
 return {schema_version:'1.0',agent:AGENT[role],case_id:caseId,task_id:`${caseId}-${role}`,verdict,
  findings:verdict==='CLEAR'?[]:[{finding:'Auffälligkeit',severity:verdict==='CRITICAL'?'HIGH':'MEDIUM',details:'Details'}],
  evidence:verdict==='CRITICAL'?[{source_id:'S-3',fact:'Fakt',relevance:'hoch'}]:[],
  checks_completed:['a'],checks_not_verified:[],missing_information:[],critical_issue,explanation:'Kurz.',...overrides};
}

export function mainReport(caseId,decision='PAY'){
 return {agent:'MainSniffer',case_id:caseId,initial_risk_score:58,initial_risk_level:'MEDIUM',final_risk_level:decision==='PAY'?'LOW':'HIGH',decision,
  decision_reason:'x',decline_reasons:decision==='PAY'?[]:[{id:'S-3',text:'Die Zahlungsadresse weicht ab.',evidence:'neu'}],hard_stops:[],agent_reports:[],key_findings:[],
  evidence_references:[],missing_information:[],policy_status:'NOT_EVALUATED',supplier_payment_status:'NOT_STARTED',supplier_transaction_hash:null,explanation:'x'};
}

export const ROLES=['invoice','wallet','supplier'];
export const COWORKERS={invoice:'cw-invoice',wallet:'cw-wallet',supplier:'cw-supplier'};

export function testConfig(overrides={}){
 return {
  host:'127.0.0.1',port:0,maxXmlBytes:500000,
  intake:{priceLovelace:'1000000',payTo:ADDR('a')},
  investigators:Object.fromEntries(ROLES.map((role,index)=>[role,{coworkerId:COWORKERS[role],url:`http://127.0.0.1:${21961+index}`,payTo:ADDR(String(index+1))}])),
  investigatorPriceLovelace:'2000000',investigationTimeoutMs:60_000,pollMs:10_000,llmTimeoutMs:60_000,taskArgs:[],
  ...overrides,
 };
}

export function fakeClock(start=Date.parse('2026-10-31T10:00:00Z')){
 const clock={t:start,sleeps:0,delays:[],now:()=>clock.t,sleep:async ms=>{clock.sleeps+=1;clock.delays.push(ms);clock.t+=ms;}};
 return clock;
}

export function tempStore(){
 const dir=mkdtempSync(join(tmpdir(),'main-test-'));
 return {dir,store:createCaseStore(dir),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

/** Creates a fresh accepted case for F9 and returns its ID. intake: extra intake fields, e.g. {state:'submitted'}. */
export function seedCase(store,xml=F9_XML,intake={}){
 const {caseId,resourceId,xmlSha256}=intakeIds(xml);
 store.create({caseId,xml,intake:{resource_id:resourceId,xml_sha256:xmlSha256,tx_hash:'ab'.repeat(32),...intake},now:new Date('2026-10-31T10:00:00Z')});
 return caseId;
}

/** Controllable deps.awaitIntake: every call waits until resolve(outcome) (or a preset outcome). */
export function fakeIntake(preset){
 const intake={calls:[],waiting:0,resolve:null};
 let release;
 const settled=new Promise(resolve=>{release=resolve;});
 intake.resolve=outcome=>release(outcome);
 if(preset!==undefined)release(preset);
 intake.awaitIntake=async caseId=>{intake.calls.push(caseId);intake.waiting+=1;try{return await settled;}finally{intake.waiting-=1;}};
 return intake;
}

/** Fake intake gate (acceptOn 'submitted'): records calls; paymentStatus/waitConfirmed like x402/gate.mjs. */
export function fakeGate({confirmed=false,status='submitted',wait=async()=>'confirmed',block}={}){
 const calls={gate:0,wait:[],status:[]};
 const gate=async req=>{
  calls.gate+=1;
  if(block)await block;
  const txHash=req.snifferResourceId.slice(4,68);
  return {paid:true,txHash,resourceId:req.snifferResourceId,confirmed};
 };
 return Object.assign(gate,{calls,paymentStatus:txHash=>{calls.status.push(txHash);return status;},waitConfirmed:async(txHash,options)=>{calls.wait.push([txHash,options]);return wait(txHash,options);}});
}

/**
 * Recording mocks for every external dependency of runCase.
 * reports: role → (caseId, taskId) → report text | null (never completes) | {status:'FAILED'}.
 */
// createPlan: role → per-attempt behaviour: 'ok' (default), 'fail_after' (task is created, then the CLI call fails),
// 'fail_before' (CLI fails, nothing created). list: optional override (args, allTasks) → CLI output, or throws.
// confirm: deps.confirmPayout behaviour ({payoutId,txHash}) → result; default confirms at once.
export function mocks({band='medium',result=checkResult(band),reports={},llm='PAY',payFails={},payout,confirm,createPlan={},list}={}){
 const calls={initialCheck:0,getXml:0,history:0,decisions:[],getCheck:0,creates:[],createAttempts:[],lists:[],gets:0,payments:[],llm:0,payouts:[],confirms:[]};
 let nextTask=1;
 const tasks=new Map();
 const backend={
  initialCheck:async()=>{calls.initialCheck+=1;return result;},
  getXml:async()=>{calls.getXml+=1;return F9_XML;},
  supplierHistory:async()=>{calls.history+=1;return {supplier_hash:SUPPLIER_HASH,approved_count:6,median_eur:'1145.00',last_amounts:['1050.00'],first_seen:'2026-04-15'};},
  postDecision:async body=>{calls.decisions.push(body);return {check_id:body.check_id,final_decision:body.decision,final_reason_type:body.reason_type,decided_by:'agents',decided_at:'2026-10-31T10:05:00Z'};},
  getCheck:async()=>{calls.getCheck+=1;return {result,decision_state:null};},
 };
 const sokosumi=async args=>{
  if(args[0]==='tasks'&&args[1]==='create'){
   const coworkerId=args[args.indexOf('--coworker-id')+1];
   const description=args[args.indexOf('--description')+1];
   const name=args[args.indexOf('--name')+1];
   const role=ROLES.find(entry=>COWORKERS[entry]===coworkerId);
   const attempt=calls.createAttempts.filter(entry=>entry===role).length;
   calls.createAttempts.push(role);
   const behaviour=createPlan[role]?.[attempt]??'ok';
   if(behaviour==='fail_before')throw new Error('sokosumi CLI failed (connection)');
   const id=`task${nextTask++}`;
   tasks.set(id,{id,role,coworkerId,description,name});
   calls.creates.push({role,id,description});
   if(behaviour==='fail_after')throw new Error('sokosumi CLI timed out');
   return {task:{id,status:'READY',coworkerId},events:[],jobs:[]};
  }
  if(args[0]==='tasks'&&args[1]==='list'){
   calls.lists.push(args);
   const all=[...tasks.values()];
   if(list)return list(args,all);
   const coworkerId=args[args.indexOf('--coworker-id')+1];
   return {tasks:all.filter(task=>task.coworkerId===coworkerId).map(task=>({id:task.id,name:task.name,description:task.description,status:'READY',coworkerId:task.coworkerId}))};
  }
  if(args[0]==='tasks'&&args[1]==='get'){
   calls.gets+=1;
   const id=args[2];const task=tasks.get(id);
   const input=JSON.parse(task.description);
   const behaviour=reports[task.role];
   const value=typeof behaviour==='function'?behaviour(input):behaviour===undefined?JSON.stringify(investigatorReport(task.role,input.case_id)):behaviour;
   if(value===null)return {task:{id,status:'RUNNING',coworkerId:task.coworkerId},events:[]};
   if(typeof value==='object')return {task:{id,status:value.status,coworkerId:task.coworkerId},events:[]};
   return {task:{id,status:'COMPLETED',coworkerId:task.coworkerId},events:[{id:'e1',taskId:id,status:'RUNNING'},{id:'e2',taskId:id,status:'COMPLETED',comment:value,actor:{type:'coworker',id:task.coworkerId}}]};
  }
  throw new Error(`unexpected sokosumi call ${args.join(' ')}`);
 };
 const payOnce=async options=>{
  calls.payments.push(options);
  const role=ROLES.find(entry=>options.key.endsWith(`-${entry}`));
  if(payFails[role]){
   writeJsonAtomic(payJournalPath(options.journalDir,options.key),{key:options.key,phase:payFails[role]});
   throw new Error(`payment ${payFails[role]}`);
  }
  const journal={key:options.key,phase:'paid',paymentMade:true,txHash:String(calls.payments.length).padStart(64,'0')};
  writeJsonAtomic(payJournalPath(options.journalDir,options.key),journal);
  return journal;
 };
 const answerReport=async(role,input)=>{
  calls.llm+=1;
  if(llm instanceof Error)throw llm;
  return mainReport(input.case_id,llm);
 };
 const runPayout=payout??(async()=>({payoutId:'pay_01JBX7ZQ8V3K6M2N4P5R7S9T0X',state:'confirmed',txHash:'cd'.repeat(32),resumed:false}));
 const confirmPayout=confirm??(async({payoutId,txHash})=>({payoutId,state:'confirmed',txHash,resumed:true}));
 return {calls,tasks,backend,sokosumi,payOnce,answerReport,runPayout:async args=>{calls.payouts.push(args.checkId);return runPayout(args);},
  confirmPayout:async args=>{calls.confirms.push(args);return confirmPayout(args);}};
}
