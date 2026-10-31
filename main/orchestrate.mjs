// Main Sniffer orchestration for one case (Task 26).
// Flow: Rust initial check → summary.band (never re-derived)
//   low    → payout (policy-gated in Rust, signed by payout/transfer.mjs)
//   high   → DONT_PAY, no investigators, no payout
//   medium → 3 Sokosumi tasks → 3 x402 payments → poll reports → Main LLM → decide() → POST /v1/decisions → payout if approved
// Crash safety: every external write (initial check, task create, payment, decision, payout) is journaled in case.json
// BEFORE it is sent. A write whose journal entry exists without an outcome is never sent again: the case stops in
// `needs_inspection`. Two bounded exceptions, both journaled per attempt:
//  - the initial check is resent only after `connect_failed` (no TCP connection, so nothing reached Rust);
//  - a failed or interrupted Sokosumi create is resolved by a read-only `tasks list` check: one match is adopted,
//    provably none allows a new create (max 3 attempts), anything else stops for inspection.
// Payments go through payOnce, whose own journal makes a resumed call return the earlier result.
import {mkdirSync} from 'node:fs';
import {readPayJournal,payJournalPath} from '../x402/pay.mjs';
import {INVESTIGATOR_ROLES,investigatorPayPath,investigatorTaskId} from '../investigator/contract.mjs';
import {roleToAgent} from '../agents/report-schema.mjs';
import {validateReport} from '../client.mjs';
import {TERMINAL_STATUSES} from './case-store.mjs';
import {decide,decisionRequest} from './decide.mjs';
import {buildRoleInputs} from './inputs.mjs';
import {extractInvoiceFields} from './xml.mjs';
import {createInvestigatorTask,findCreatedTask,readInvestigatorTask,taskOutcome} from './sokosumi-tasks.mjs';

export const DEFAULT_INVESTIGATION_TIMEOUT_MS=15*60_000;
export const DEFAULT_POLL_MS=15_000;
export const DEFAULT_LLM_TIMEOUT_MS=5*60_000;
export const systemClock=Object.freeze({now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))});

/** Stops the case for manual inspection (an external write may have happened). */
export class CaseStop extends Error{constructor(code,message){super(message);this.name='CaseStop';this.code=code;}}
/** Ends the case as failed: the backend refused the request and stored nothing. */
export class CaseFailed extends Error{constructor(code,message){super(message);this.name='CaseFailed';this.code=code;}}

const clip=(value,max=600)=>{const text=String(value??'');return text.length>max?`${text.slice(0,max-1)}…`:text;};
const iso=ms=>new Date(ms).toISOString();
// The Rust API stored nothing for these 4xx statuses (spec 5.1: validation, auth, conflict). Every 5xx, timeout,
// reset or unparsable response stops the case for inspection (user decision 2026-10-31).
const NOTHING_STORED=new Set([400,401,403,404,409,413,415,422]);
export const DEFAULT_INITIAL_CHECK_MAX_ATTEMPTS=4; // 1 send + at most 3 resends, only after connect_failed
export const DEFAULT_INITIAL_CHECK_BACKOFF_MS=2_000; // 2 s, 4 s, 8 s
export const DEFAULT_TASK_CREATE_MAX_ATTEMPTS=3;
export const DEFAULT_TASK_CHECK_DELAY_MS=10_000; // lets an in-flight create land before the read-only check

async function loadInvestigationContext(ctx,result){
 const {deps}=ctx;
 let fields=null;let xmlStatus='ok';
 try{fields=extractInvoiceFields(await deps.backend.getXml(result.check_id));}
 catch(error){xmlStatus=error?.status===410?'expired':error?.status!==undefined?'unavailable':'unparsable';deps.log?.(`case=${ctx.caseId} event=xml_fields_unavailable reason=${xmlStatus}`);}
 let history=null;
 const supplierHash=result.supplier?.supplier_hash;
 if(supplierHash){
  try{history=await deps.backend.supplierHistory(supplierHash);}
  catch(error){if(error?.status===404)history={approved_count:0,median_eur:null,last_amounts:[],first_seen:null};else deps.log?.(`case=${ctx.caseId} event=history_unavailable`);}
 }
 return buildRoleInputs({caseId:ctx.caseId,result,fields,history,xmlStatus});
}

async function initialCheck(ctx){
 const {caseId,deps,save}=ctx;
 const step=ctx.state.steps.initial_check;
 if(step?.phase==='done')return step.result;
 if(step&&step.phase!=='not_sent')throw new CaseStop('initial_check_unknown','The initial check request may have been stored by the backend. Inspect GET /v1/checks before any retry; it is never resent automatically.');
 const xml=deps.store.readXml(caseId);
 if(xml===null)throw new CaseStop('xml_missing','The submitted XML is missing from the case directory.');
 const maxAttempts=deps.config.initialCheckMaxAttempts??DEFAULT_INITIAL_CHECK_MAX_ATTEMPTS;
 const backoffMs=deps.config.initialCheckBackoffMs??DEFAULT_INITIAL_CHECK_BACKOFF_MS;
 let result;
 for(;;){
  const attempts=ctx.state.steps.initial_check?.attempts??[];
  if(attempts.length>=maxAttempts){
   deps.store.removeXml(caseId);
   throw new CaseFailed('initial_check_unreachable',`The backend could not be reached in ${attempts.length} attempts (connection never established). Nothing was sent.`);
  }
  if(attempts.length){
   const delay=backoffMs*2**(attempts.length-1);
   deps.log?.(`case=${caseId} event=initial_check_resend attempt=${attempts.length+1} delay_ms=${delay}`);
   await deps.clock.sleep(delay);
  }
  save(state=>{state.status='initial_check';state.steps.initial_check={phase:'started',at:iso(deps.clock.now()),attempts:[...attempts,{n:attempts.length+1,at:iso(deps.clock.now())}]};});
  try{result=await deps.backend.initialCheck(xml);break;}
  catch(error){
   if(error?.code==='connect_failed'){
    // Proven not sent: the TCP connection was never established (backend.mjs connectionNotEstablished).
    save(state=>{const entry=state.steps.initial_check;entry.phase='not_sent';entry.attempts.at(-1).outcome='connect_failed';});
    continue;
   }
   if(NOTHING_STORED.has(error?.status)){
    save(state=>{state.steps.initial_check={...state.steps.initial_check,phase:'refused',code:error.code??'http_error',http_status:error.status};});
    deps.store.removeXml(caseId);
    throw new CaseFailed(`initial_check_refused:${error.code??error.status}`,`The backend refused the initial check (HTTP ${error.status} ${error.code}). Nothing was stored.`);
   }
   save(state=>{state.steps.initial_check={...state.steps.initial_check,phase:'unknown',code:error?.code??null,http_status:error?.status??null,error:clip(error?.message)};});
   throw new CaseStop('initial_check_unknown',`Initial check outcome unknown: ${clip(error?.message)}`);
  }
 }
 save(state=>{
  state.steps.initial_check={phase:'done',at:iso(deps.clock.now()),attempts:state.steps.initial_check.attempts,result};
  state.check={check_id:result.check_id,band:result.summary.band,risk_score:result.summary.risk_score??null};
 });
 deps.store.removeXml(caseId);
 return result;
}

// After a failed or interrupted `tasks create`: a read-only check decides. Exactly one match → use it. Provably none →
// the attempt is marked not_sent and may be retried. A failed or ambiguous check → stop for inspection.
async function resolveCreateAttempt(ctx,role,inputs){
 const {caseId,deps,save}=ctx;
 const investigator=deps.config.investigators[role];
 const delay=deps.config.taskCheckDelayMs??DEFAULT_TASK_CHECK_DELAY_MS;
 if(delay>0)await deps.clock.sleep(delay);
 const check=await findCreatedTask({run:deps.sokosumi,coworkerId:investigator.coworkerId,taskArgs:deps.config.taskArgs??[],name:taskName(caseId,role),
  description:inputs?.[role]?.text,logicalTaskId:investigatorTaskId(caseId,role)});
 const at=iso(deps.clock.now());
 save(state=>{
  const entry=state.steps.investigation.tasks[role];
  entry.attempts.at(-1).check={...check,at};
  if(check.outcome==='found')Object.assign(entry,{phase:'created',task_id:check.task_id,status:null,found_by_check:true});
  else if(check.outcome==='none')entry.phase='not_sent';
  else entry.phase='create_unknown';
 });
 deps.log?.(`case=${caseId} event=task_create_check role=${role} outcome=${check.outcome}${check.task_id?` task_id=${check.task_id}`:''}`);
 if(check.outcome==='ambiguous'||check.outcome==='check_failed')
  throw new CaseStop('sokosumi_create_unknown',`The ${role} task may exist; the read-only check was ${check.outcome} (${check.reason}). Inspect \`sokosumi tasks list --coworker-id ${investigator.coworkerId}\` before any retry.`);
}

const taskName=(caseId,role)=>`Sniffer ${caseId} ${role}`;

async function createTasks(ctx,result){
 const {caseId,deps,save}=ctx;
 const inv=()=>ctx.state.steps.investigation;
 const maxAttempts=deps.config.taskCreateMaxAttempts??DEFAULT_TASK_CREATE_MAX_ATTEMPTS;
 let inputs=null;
 for(const role of INVESTIGATOR_ROLES){
  const investigator=deps.config.investigators[role];
  for(;;){
   const entry=inv().tasks[role];
   if(entry?.phase==='created')break;
   if(entry?.phase==='create_unknown')throw new CaseStop('sokosumi_create_unknown',`A Sokosumi task for ${role} may already exist (journal phase ${entry.phase}). Inspect \`sokosumi tasks list\` before any retry.`);
   inputs??=await loadInvestigationContext(ctx,result);
   if(entry?.phase==='creating'){
    // Crash during an earlier create: never resend blindly, check first.
    if(!Array.isArray(entry.attempts)||!entry.attempts.length)save(state=>{state.steps.investigation.tasks[role].attempts=[{n:1,at:entry.at??null}];});
    await resolveCreateAttempt(ctx,role,inputs);
    continue;
   }
   const attempts=entry?.attempts??[];
   if(attempts.length>=maxAttempts)throw new CaseStop('sokosumi_create_attempts_exhausted',`Creating the ${role} task failed ${attempts.length} times; each time no task was found.`);
   save(state=>{state.steps.investigation.tasks[role]={phase:'creating',coworker_id:investigator.coworkerId,at:iso(deps.clock.now()),
    attempts:[...attempts,{n:attempts.length+1,at:iso(deps.clock.now())}]};});
   let created;
   try{created=await createInvestigatorTask({run:deps.sokosumi,coworkerId:investigator.coworkerId,taskArgs:deps.config.taskArgs??[],name:taskName(caseId,role),description:inputs[role].text});}
   catch(error){
    save(state=>{state.steps.investigation.tasks[role].attempts.at(-1).error=clip(error?.message);});
    if(error?.code==='coworker_mismatch'){
     save(state=>{state.steps.investigation.tasks[role].phase='create_unknown';});
     throw new CaseStop('sokosumi_create_unknown',`Sokosumi created the ${role} task ${error.taskId} for another Coworker. Inspect it before any retry.`);
    }
    await resolveCreateAttempt(ctx,role,inputs);
    continue;
   }
   save(state=>{Object.assign(state.steps.investigation.tasks[role],{phase:'created',task_id:created.taskId,status:created.status});});
   deps.log?.(`case=${caseId} event=task_created role=${role} task_id=${created.taskId}`);
  }
 }
}

async function payInvestigators(ctx){
 const {caseId,deps,save}=ctx;
 const inv=()=>ctx.state.steps.investigation;
 const journalDir=deps.store.payJournalDir(caseId);
 for(const role of INVESTIGATOR_ROLES){
  const payment=inv().payments[role];
  if(payment?.phase==='paid'||payment?.phase==='failed')continue;
  if(payment?.phase==='unknown')throw new CaseStop('investigator_payment_unknown',`The ${role} payment is unknown. Inspect ${payJournalPath(journalDir,`${caseId}-${role}`)}.`);
  // No entry, or a crash during payOnce ('paying'): payOnce's own journal returns a finished payment or refuses an open one.
  const investigator=deps.config.investigators[role];
  const key=investigatorTaskId(caseId,role);
  const taskId=inv().tasks[role].task_id;
  save(state=>{state.steps.investigation.payments[role]={phase:'paying',at:iso(deps.clock.now())};});
  try{
   const journal=await deps.payOnce({url:investigator.url.replace(/\/+$/,'')+investigatorPayPath(taskId),key,journalDir,signer:deps.payer,
    payTo:investigator.payTo,maxLovelace:deps.config.investigatorPriceLovelace,init:{method:'POST'}});
   save(state=>{state.steps.investigation.payments[role]={phase:'paid',tx_hash:journal?.txHash??null,payment_made:journal?.paymentMade??null,journal_phase:journal?.phase??null,at:iso(deps.clock.now())};});
   deps.log?.(`case=${caseId} event=investigator_paid role=${role}${journal?.txHash?` tx_hash=${journal.txHash}`:''}`);
  }catch(error){
   let journal;
   try{journal=readPayJournal(payJournalPath(journalDir,key));}catch{journal={phase:'unreadable'};}
   if(!journal||journal.phase==='failed_before_signing'||journal.phase==='rejected'){
    // Nothing was signed, or the signed tx provably can never land: the investigator is not paid, so it will not run.
    // Its report counts as missing (fail closed).
    save(state=>{state.steps.investigation.payments[role]={phase:'failed',error:clip(error?.message),at:iso(deps.clock.now())};});
    deps.log?.(`case=${caseId} event=investigator_payment_failed role=${role}`);
    continue;
   }
   save(state=>{state.steps.investigation.payments[role]={phase:'unknown',journal_phase:journal.phase,tx_hash:journal.txHash??null,error:clip(error?.message,2000)};});
   throw new CaseStop('investigator_payment_unknown',`The ${role} payment may have been submitted (payOnce journal phase ${journal.phase}). ${clip(error?.message,2000)}`);
  }
 }
}

async function collectReports(ctx){
 const {caseId,deps,save}=ctx;
 const inv=()=>ctx.state.steps.investigation;
 if(!inv().poll_started_at)save(state=>{state.steps.investigation.poll_started_at=deps.clock.now();});
 for(const role of INVESTIGATOR_ROLES)if(!inv().reports[role]&&inv().payments[role]?.phase!=='paid')save(state=>{state.steps.investigation.reports[role]={valid:false,status:'unpaid'};});
 const deadline=inv().poll_started_at+deps.config.investigationTimeoutMs;
 for(;;){
  for(const role of INVESTIGATOR_ROLES.filter(entry=>!inv().reports[entry])){
   const {task_id:taskId}=inv().tasks[role];
   const coworkerId=deps.config.investigators[role].coworkerId;
   let out;
   try{out=await readInvestigatorTask({run:deps.sokosumi,taskId,taskArgs:deps.config.taskArgs??[]});}
   catch(error){deps.log?.(`case=${caseId} event=task_read_failed role=${role} error=${clip(error?.message,120)}`);continue;}
   const outcome=taskOutcome(out,{taskId,coworkerId});
   if(outcome.state==='completed'){
    const checked=deps.validateReport(role,outcome.text,{case_id:caseId,task_id:investigatorTaskId(caseId,role)});
    save(state=>{state.steps.investigation.reports[role]=checked.ok?{valid:true,status:'completed',report:checked.value}:{valid:false,status:'invalid',error:clip(checked.error)};});
    deps.log?.(`case=${caseId} event=report role=${role} valid=${checked.ok}`);
   }else if(outcome.state==='failed'){
    save(state=>{state.steps.investigation.reports[role]={valid:false,status:'failed',error:outcome.error,task_status:outcome.status};});
   }
  }
  if(INVESTIGATOR_ROLES.every(role=>inv().reports[role]))return;
  const now=deps.clock.now();
  if(now>=deadline){
   save(state=>{for(const role of INVESTIGATOR_ROLES)state.steps.investigation.reports[role]??={valid:false,status:'timeout'};});
   deps.log?.(`case=${caseId} event=investigation_timeout`);
   return;
  }
  await deps.clock.sleep(Math.max(1,Math.min(deps.config.pollMs,deadline-now)));
 }
}

function mainLlmInput(ctx,result,reports){
 const {caseId,deps}=ctx;
 const inv=ctx.state.steps.investigation;
 const texts={};
 for(const criterion of result.criteria??[])if(deps.customerTexts?.[criterion.id])texts[criterion.id]=deps.customerTexts[criterion.id];
 return {
  case_id:caseId,
  invoice_reference:result.invoice?.invoice_number??null,
  initial_risk:{check_id:result.check_id,band:result.summary.band,risk_score:result.summary.risk_score,ko_triggered:result.summary.ko_triggered,
   checks_incomplete:result.summary.checks_incomplete??[],criteria:result.criteria??[],reducers:result.reducers??[]},
  agent_tasks:result.agent_tasks,
  criteria_customer_texts:texts,
  agent_reports:INVESTIGATOR_ROLES.map(role=>({role,agent:roleToAgent[role],task_id:investigatorTaskId(caseId,role),sokosumi_task_id:inv.tasks[role]?.task_id??null,
   status:reports[role].status,report:reports[role].valid?reports[role].report:null,error:reports[role].valid?null:(reports[role].error??null)})),
  x402_investigator_payments:INVESTIGATOR_ROLES.map(role=>({role,phase:inv.payments[role]?.phase??null,tx_hash:inv.payments[role]?.tx_hash??null})),
  policy_status:'NOT_EVALUATED',
  supplier_payment_status:'NOT_STARTED',
 };
}

async function runMainLlm(ctx,result,reports){
 const {caseId,deps,save}=ctx;
 const step=ctx.state.steps.main_llm;
 if(step?.phase==='done')return step.ok?step.report:null;
 save(state=>{state.status='deciding';state.steps.main_llm={phase:'running',at:iso(deps.clock.now())};});
 try{
  mkdirSync(deps.store.dirOf(caseId),{recursive:true,mode:0o700});
  const report=await deps.answerReport('main',mainLlmInput(ctx,result,reports),deps.store.llmJournalPath(caseId),Date.now()+deps.config.llmTimeoutMs);
  if(report?.case_id!==caseId)throw new Error('Main report case_id mismatch');
  save(state=>{state.steps.main_llm={phase:'done',ok:true,report,at:iso(deps.clock.now())};});
  return report;
 }catch(error){
  // Fail closed: decide() turns a missing LLM result into rejected/formal.
  save(state=>{state.steps.main_llm={phase:'done',ok:false,error:clip(error?.message),at:iso(deps.clock.now())};});
  deps.log?.(`case=${caseId} event=main_llm_failed`);
  return null;
 }
}

const decisionMatches=(view,body)=>{
 const state=view?.decision_state;
 return state?.final_decision===body.decision&&(state.final_reason_type??null)===(body.reason_type??null)&&(state.final_block_wallet??false)===body.block_wallet&&state.decided_by==='agents';
};

async function recordDecision(ctx,result,llm,reports){
 const {caseId,deps,save}=ctx;
 const step=ctx.state.steps.decision;
 if(step?.phase==='posted')return step;
 if(step?.phase==='posting'){
  // Never resent. A read-only check tells whether the earlier POST landed.
  let view;
  try{view=await deps.backend.getCheck(result.check_id);}catch(error){throw new CaseStop('decision_unknown',`The decision POST may have been stored and the check could not be read (${clip(error?.message)}).`);}
  if(!decisionMatches(view,step.request))throw new CaseStop('decision_unknown','A decision POST was journaled but the backend does not show the same decision. Inspect before any retry.');
  save(state=>{state.steps.decision.phase='posted';state.steps.decision.verified_by_read=true;});
  return ctx.state.steps.decision;
 }
 if(step)throw new CaseStop('decision_not_recorded',`Decision step is in phase ${step.phase}.`);
 const outcome=decide(llm,reports,{result,customerTexts:deps.customerTexts});
 const body=decisionRequest(result.check_id,outcome);
 save(state=>{state.steps.decision={phase:'posting',rule:outcome.rule,request:body,at:iso(deps.clock.now())};});
 let response;
 try{response=await deps.backend.postDecision(body);}
 catch(error){
  save(state=>{Object.assign(state.steps.decision,{phase:'error',code:error?.code??'error',http_status:error?.status??null});});
  throw new CaseStop(`decision_not_recorded:${error?.code??'error'}`,`POST /v1/decisions failed (HTTP ${error?.status} ${error?.code}).`);
 }
 save(state=>{Object.assign(state.steps.decision,{phase:'posted',response});});
 deps.log?.(`case=${caseId} event=decision_recorded decision=${body.decision} reason_type=${body.reason_type}`);
 return ctx.state.steps.decision;
}

async function payout(ctx,checkId){
 const {caseId,deps,save}=ctx;
 const step=ctx.state.steps.payout;
 if(step?.phase==='done'||step?.phase==='refused'){save(state=>{state.status='completed';});return;}
 if(step)throw new CaseStop('payout_unknown',`A payout for ${checkId} may have started (journal phase ${step.phase}). Inspect it with payout/transfer.mjs; it is never restarted automatically.`);
 save(state=>{state.status='payout';state.steps.payout={phase:'started',at:iso(deps.clock.now())};});
 try{
  const result=await deps.runPayout({checkId});
  save(state=>{state.steps.payout={phase:'done',state:result.state,payout_id:result.payoutId,tx_hash:result.txHash??null,at:iso(deps.clock.now())};state.status='completed';});
  deps.log?.(`case=${caseId} event=payout state=${result.state} tx_hash=${result.txHash}`);
 }catch(error){
  if(!error?.payoutId&&error?.status===409){
   // The Rust policy engine refused to authorize (spec §12): no intent, nothing signed.
   save(state=>{state.steps.payout={phase:'refused',code:error.code??'refused',at:iso(deps.clock.now())};state.status='completed';});
   deps.log?.(`case=${caseId} event=payout_refused code=${error.code}`);
   return;
  }
  save(state=>{state.steps.payout={phase:'error',code:error?.code??'payout_error',payout_id:error?.payoutId??null,tx_hash:error?.txHash??null,at:iso(deps.clock.now())};});
  throw new CaseStop(`payout_${error?.code??'error'}`,clip(error?.message,2000));
 }
}

/**
 * Runs or resumes one case until it is completed, failed or needs inspection. Never throws for case errors.
 * @param {string} caseId
 * @param {object} deps {config, store, backend, sokosumi, payOnce, payer, answerReport, validateReport, runPayout, clock, log, customerTexts}
 */
export async function runCase(caseId,deps){
 deps={...deps,clock:deps.clock??systemClock,validateReport:deps.validateReport??validateReport};
 let state=deps.store.read(caseId);
 if(!state)throw new Error(`Unknown case ${caseId}`);
 if(TERMINAL_STATUSES.has(state.status))return state;
 const ctx={caseId,deps,get state(){return state;}};
 ctx.save=mutate=>{mutate(state);state.updated_at=iso(deps.clock.now());deps.store.write(state);return state;};
 try{
  const result=await initialCheck(ctx);
  const band=result.summary.band;
  if(band==='high'){
   ctx.save(s=>{s.outcome={decision:'DONT_PAY',final_decision:'rejected',reason_type:result.summary.reason_type??null,block_wallet:false,
    decline_reasons:result.summary.decline_reasons??[],decided_by:'initial_check'};s.status='completed';});
   return state;
  }
  if(band==='low'){
   ctx.save(s=>{s.outcome={decision:'PAY',final_decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[],decided_by:'initial_check'};});
   await payout(ctx,result.check_id);
   return state;
  }
  if(!state.steps.investigation)ctx.save(s=>{s.status='investigating';s.steps.investigation={tasks:{},payments:{},reports:{}};});
  await createTasks(ctx,result);
  await payInvestigators(ctx);
  await collectReports(ctx);
  const reports=state.steps.investigation.reports;
  const llm=await runMainLlm(ctx,result,reports);
  const decision=await recordDecision(ctx,result,llm,reports);
  const body=decision.request;
  ctx.save(s=>{s.outcome={decision:body.decision==='approved'?'PAY':'DONT_PAY',final_decision:body.decision,reason_type:body.reason_type,block_wallet:body.block_wallet,
   decline_reasons:body.decline_reasons,decided_by:'agents',rule:decision.rule};if(body.decision!=='approved')s.status='completed';});
  if(body.decision==='approved')await payout(ctx,result.check_id);
  return state;
 }catch(error){
  const failed=error instanceof CaseFailed;
  const code=error instanceof CaseStop||failed?error.code:'internal_error';
  ctx.save(s=>{s.status=failed?'failed':'needs_inspection';s.inspection={code,message:clip(error?.message,2000)};});
  deps.log?.(`case=${caseId} event=${failed?'failed':'needs_inspection'} code=${code}`);
  return state;
 }
}

/** Public status view: no raw invoice data, no addresses, no report prose. */
export function caseView(state){
 const inv=state.steps?.investigation;
 const payoutStep=state.steps?.payout;
 return {
  case_id:state.case_id,
  status:state.status,
  created_at:state.created_at,
  updated_at:state.updated_at,
  check_id:state.check?.check_id??null,
  band:state.check?.band??null,
  risk_score:state.check?.risk_score??null,
  investigators:inv?Object.fromEntries(INVESTIGATOR_ROLES.map(role=>[role,{
   sokosumi_task_id:inv.tasks[role]?.task_id??null,
   payment:inv.payments[role]?.phase??null,
   payment_tx_hash:inv.payments[role]?.tx_hash??null,
   report:inv.reports[role]?.status??null,
   verdict:inv.reports[role]?.valid?inv.reports[role].report.verdict:null,
  }])):null,
  decision:state.outcome?{decision:state.outcome.decision,final_decision:state.outcome.final_decision,reason_type:state.outcome.reason_type,
   block_wallet:state.outcome.block_wallet,decline_reasons:state.outcome.decline_reasons,decided_by:state.outcome.decided_by}:null,
  payout:payoutStep?{phase:payoutStep.phase,state:payoutStep.state??null,payout_id:payoutStep.payout_id??null,tx_hash:payoutStep.tx_hash??null,code:payoutStep.code??null}:null,
  inspection:state.inspection?{code:state.inspection.code}:null,
 };
}
