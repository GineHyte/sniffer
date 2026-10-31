// Investigator worker for one role (Task 25). Starts a READY Sokosumi task only after this role's x402 gate
// journal holds a confirmed payment bound to that exact Sokosumi task ID, then runs the role's Eve model and
// completes the task with the validated JSON report.
//
// Per-task journal phases (written BEFORE each external write; a finished step is never redone):
//   start-pending -> started -> model-pending | model-retry -> result-saved -> complete-pending -> completed
//   failed: the task input is invalid; the task stays RUNNING and is never completed.
// start-pending and complete-pending after a crash are uncertain: the worker stops on that task for inspection.
//
// Fail-closed policy:
// - Invalid input (not JSON, wrong schema, wrong role): journal `failed`, do not complete. Without a trusted
//   case_id/task_id no valid report can be built, and a report for another role's task would be wrong.
//   Main's timeout then rejects the case as formal.
// - Valid input but no valid model report (invalid after the one repair, deadline expired, or MAX_MODEL_ATTEMPTS
//   transient failures): complete with a code-built INSUFFICIENT_DATA report that says no check was completed.
//   It is schema-valid, maps to the same Main guardrail (rejected/formal, no wallet penalty) as a missing report,
//   and releases the paid task instead of leaving it RUNNING.
import {readFileSync,writeFileSync,renameSync,mkdirSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readGateJournal,paidPaymentFor} from '../x402/gate.mjs';
import {writeJsonAtomic} from '../x402/pay.mjs';
import {InvestigatorReport,roleToAgent} from '../agents/report-schema.mjs';
import {isTaskForTarget} from '../task-target.mjs';
import {parseInvestigatorInput,TASK_ID_REGEX,INVESTIGATOR_ROLES} from './contract.mjs';

export const MAX_MODEL_ATTEMPTS=3;
const PERMANENT_MODEL_ERRORS=[/^Model output invalid after repair$/,/deadline expired/i];

function readJournal(path){
 let text;
 try{text=readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return {};throw new Error(`Task journal ${path} is unreadable (${error.code}). Inspect it manually.`);}
 try{const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
 throw new Error(`Task journal ${path} is not a JSON object. Inspect it manually.`);
}

function writeTextAtomic(path,text){
 const tmp=`${path}.${process.pid}.${randomUUID()}.tmp`;
 try{writeFileSync(tmp,text,{mode:0o600,flag:'wx'});renameSync(tmp,path);}
 catch(error){try{unlinkSync(tmp);}catch{}throw error;}
}

const short=error=>String(error?.message??error).slice(0,300);

// Paid only on a journal entry the gate wrote after a confirmed settle of this tx for this resource.
export function confirmedPaymentFor(gateJournalPath,taskId){
 const paid=paidPaymentFor(readGateJournal(gateJournalPath),taskId);
 if(!paid)return null;
 const settlement=paid.entry.settlement;
 if(settlement?.transaction!==paid.txHash||settlement?.extra?.status!=='confirmed')return null;
 return {txHash:paid.txHash,paidAt:paid.entry.paidAt??null};
}

export function checkReport(role,input,report){
 const parsed=InvestigatorReport.safeParse(report);
 if(!parsed.success)throw new Error('Model report does not match the investigator schema');
 const value=parsed.data;
 if(value.agent!==roleToAgent[role]||value.case_id!==input.case_id||value.task_id!==input.task_id)throw new Error('Model report agent, case_id or task_id does not match the task');
 return value;
}

export function failClosedReport(role,input,reason){
 const sources=[...new Set(input.tasks.map(task=>task.source))];
 return InvestigatorReport.parse({schema_version:'1.0',agent:roleToAgent[role],case_id:input.case_id,task_id:input.task_id,
  verdict:'INSUFFICIENT_DATA',findings:[],evidence:[],checks_completed:[],checks_not_verified:sources,
  missing_information:[`No valid investigator report was produced (${reason}).`],critical_issue:false,
  explanation:'Automatic fail-closed report from the investigator worker. The model did not return a valid report, so no check is confirmed. Treat this investigation as not verified.'});
}

/**
 * @param {object} options
 * @param {string} options.role invoice | wallet | supplier
 * @param {{coworkerId:string,organizationId:string|null,taskArgs:string[],runtimeArgs:string[]}} options.target
 * @param {{gateJournal:string,tasksDir:string}} options.paths
 * @param {(args:string[])=>Promise<object>|object} options.cli Sokosumi CLI runner (adds --preprod and --json).
 * @param {(role,input,journal,deadline)=>Promise<object>} options.answerReport
 * @param {()=>number} [options.clock] Milliseconds.
 */
export function createInvestigatorWorker({role,target,paths,cli,answerReport,clock=Date.now,deadlineMs=15*60*1000,log=console}){
 if(!INVESTIGATOR_ROLES.includes(role))throw new Error(`role must be one of ${INVESTIGATOR_ROLES.join(', ')}`);
 if(typeof cli!=='function'||typeof answerReport!=='function')throw new Error('cli and answerReport are required');
 const tasksDir=resolve(paths.tasksDir);
 const logged=new Set();
 const once=(key,...message)=>{if(logged.has(key))return;logged.add(key);log.log(...message);};
 const files=taskId=>({journal:join(tasksDir,`${taskId}.json`),session:join(tasksDir,`${taskId}.session.json`),result:join(tasksDir,`${taskId}.result.json`)});

 async function start(task,file,summary){
  const payment=confirmedPaymentFor(paths.gateJournal,task.id);
  if(!payment){once(`${task.id}:unpaid`,'Skipping unpaid task',task.id);summary.skipped.push(task.id);return null;}
  writeJsonAtomic(file.journal,{taskId:task.id,phase:'start-pending',payment:{txHash:payment.txHash},updatedAt:clock()});
  const started=await cli(['runtime','start',task.id,...target.runtimeArgs,'--coworker-id',target.coworkerId]);
  if(started?.id!==task.id||started.status!=='RUNNING')throw new Error('runtime start did not confirm RUNNING. Inspect the Task before recovery.');
  const state={taskId:task.id,phase:'started',payment:{txHash:payment.txHash},input:typeof started.description==='string'?started.description:'',startedAt:clock(),attempts:0};
  writeJsonAtomic(file.journal,{...state,updatedAt:clock()});
  summary.started.push(task.id);
  log.log('Started paid task',task.id);
  return state;
 }

 function saveResult(file,state,report,extra){
  writeTextAtomic(file.result,JSON.stringify(report));
  const next={...state,...extra,phase:'result-saved',resultFile:file.result,verdict:report.verdict};
  writeJsonAtomic(file.journal,{...next,updatedAt:clock()});
  return next;
 }

 async function runModel(task,file,state,summary){
  let input;
  try{input=parseInvestigatorInput(state.input,role);}
  catch(error){
   const failed={...state,phase:'failed',reason:'invalid_input',error:short(error)};
   writeJsonAtomic(file.journal,{...failed,updatedAt:clock()});
   once(`${task.id}:failed`,'Task input invalid; not completed',task.id,failed.error);
   summary.failed.push(task.id);
   return failed;
  }
  const deadline=state.startedAt+deadlineMs;
  const attempts=state.attempts??0;
  const fallback=(reason,error)=>saveResult(file,state,failClosedReport(role,input,reason),{source:'fail-closed',reason,...(error?{error:short(error)}:{})});
  if(clock()>=deadline)return fallback('deadline_expired');
  if(attempts>=MAX_MODEL_ATTEMPTS)return fallback('model_unavailable',state.lastError);
  writeJsonAtomic(file.journal,{...state,phase:'model-pending',attempts:attempts+1,updatedAt:clock()});
  let answer;
  try{answer=await answerReport(role,input,file.session,deadline);}
  catch(error){
   if(PERMANENT_MODEL_ERRORS.some(pattern=>pattern.test(String(error?.message))))return fallback('model_output_invalid',error);
   const retry={...state,phase:'model-retry',attempts:attempts+1,lastError:short(error)};
   writeJsonAtomic(file.journal,{...retry,updatedAt:clock()});
   log.error('Model attempt failed',task.id,retry.attempts,retry.lastError);
   return retry;
  }
  let report;
  try{report=checkReport(role,input,answer);}catch(error){return fallback('model_output_invalid',error);}
  return saveResult(file,state,report,{source:'model',attempts:attempts+1});
 }

 async function complete(task,file,state,summary){
  if(!existsSync(state.resultFile))throw new Error('Saved result file is missing. Inspect the task journal before recovery.');
  writeJsonAtomic(file.journal,{...state,phase:'complete-pending',updatedAt:clock()});
  const completed=await cli(['runtime','complete',task.id,...target.runtimeArgs,'--coworker-id',target.coworkerId,'--result-file',state.resultFile]);
  if(completed?.taskId!==task.id||completed.status!=='COMPLETED'||typeof completed.eventId!=='string'||!completed.eventId)throw new Error('runtime complete did not confirm COMPLETED. Inspect the Task before recovery.');
  const done={...state,phase:'completed',completion:{eventId:completed.eventId}};
  writeJsonAtomic(file.journal,{...done,updatedAt:clock()});
  summary.completed.push(task.id);
  log.log('Completed task',task.id,state.verdict);
  return done;
 }

 async function advance(task,summary){
  const file=files(task.id);
  let state=readJournal(file.journal);
  if(!state.phase){
   if(task.status!=='READY')return;
   state=await start(task,file,summary);
   if(!state)return;
  }
  if(state.phase==='start-pending'||state.phase==='complete-pending')throw new Error(`Uncertain ${state.phase}. Inspect the Task before recovery; automatic retry disabled.`);
  if(['started','model-pending','model-retry'].includes(state.phase))state=await runModel(task,file,state,summary);
  if(state.phase==='result-saved')state=await complete(task,file,state,summary);
 }

 // One polling pass. Returns what happened, for logs and tests.
 async function tick(){
  const summary={started:[],completed:[],skipped:[],failed:[],blocked:[]};
  mkdirSync(tasksDir,{recursive:true,mode:0o700});
  const listing=await cli(['tasks','list','--coworker-id',target.coworkerId,...target.taskArgs]);
  if(!Array.isArray(listing?.tasks))throw new Error('Sokosumi task list has an unexpected shape');
  for(const task of listing.tasks){
   if(!isTaskForTarget(task,target))continue;
   if(typeof task.id!=='string'||!TASK_ID_REGEX.test(task.id)){once(`invalid:${String(task.id).slice(0,40)}`,'Ignoring task with an invalid ID');continue;}
   try{await advance(task,summary);}
   catch(error){summary.blocked.push(task.id);once(`${task.id}:blocked:${short(error)}`,'Task blocked',task.id,short(error));}
  }
  return summary;
 }

 return {tick};
}

// Usage: node --env-file=.env investigator/worker.mjs <role>   (or AGENT_ROLE=<role>)
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {workerConfig,envWithRole}=await import('./config.mjs');
 const {acquireWorkerLock}=await import('../worker-lock.mjs');
 const {sokosumi}=await import('../sokosumi-cli.mjs');
 const {answerReport}=await import('../client.mjs');
 const {Client}=await import('eve/client');
 const config=workerConfig(envWithRole());
 const release=acquireWorkerLock(config.paths.workerLock);
 process.once('exit',release);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{release();process.exit(0);});
 const eve=new Client({host:config.eveUrl});
 await eve.health();
 const worker=createInvestigatorWorker({role:config.role,target:config.target,paths:config.paths,deadlineMs:config.deadlineMs,
  cli:args=>sokosumi(args),answerReport:(role,input,journal,deadline)=>answerReport(role,input,journal,deadline,{client:eve})});
 console.log(`Investigator ${config.role} worker running`,process.pid);
 while(true){
  try{await worker.tick();}catch(error){console.error('Polling read failed',short(error));}
  await new Promise(r=>setTimeout(r,config.pollMs));
 }
}
