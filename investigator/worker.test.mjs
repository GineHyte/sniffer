import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInvestigatorWorker,failClosedReport,MAX_MODEL_ATTEMPTS} from './worker.mjs';
import {investigatorPaths} from './config.mjs';
import {target,TX,inputText,validReport,fakeSokosumi,writePaid} from './test-fixtures.mjs';
import {acquireWorkerLock} from '../worker-lock.mjs';
import {parseModelJson,InvestigatorReport} from '../agents/report-schema.mjs';

function setup(){
 const dir=mkdtempSync(join(tmpdir(),'investigator-worker-'));
 const paths={gateJournal:join(dir,'gate-journal.json'),tasksDir:join(dir,'tasks')};
 const lines=[];
 const log={log:(...a)=>lines.push(a.join(' ')),error:(...a)=>lines.push(a.join(' '))};
 return {dir,paths,lines,log,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const journalOf=(paths,id)=>JSON.parse(readFileSync(join(paths.tasksDir,`${id}.json`),'utf8'));

function reporter(produce){
 const seen=[];
 const answerReport=async(role,input,journal,deadline)=>{seen.push({role,input,journal,deadline});return produce(input,seen.length);};
 return {answerReport,seen};
}

test('an unpaid READY task is never started and is logged once',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  const model=reporter(input=>validReport(input));
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  for(let i=0;i<2;i++)assert.deepEqual((await worker.tick()).skipped,['task-a']);
  // A pending or mempool-only payment is not paid either.
  writePaid(env.paths.gateJournal,'task-a',TX,{state:'pending'});
  assert.deepEqual((await worker.tick()).skipped,['task-a']);
  assert.equal(soko.count('runtime','start'),0);
  assert.equal(model.seen.length,0);
  assert.equal(env.lines.filter(l=>l.includes('unpaid')).length,1);
  assert.equal(existsSync(join(env.paths.tasksDir,'task-a.json')),false);
 }finally{env.cleanup();}
});

test('a paid task is started, answered and completed with a valid report file',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()},{id:'other-coworker',status:'READY',coworkerId:'cw-wallet',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  writePaid(env.paths.gateJournal,'other-coworker','cd'.repeat(32));
  const model=reporter(input=>validReport(input));
  let now=1000;
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,clock:()=>now,deadlineMs:60000,log:env.log});
  const summary=await worker.tick();
  assert.deepEqual(summary.started,['task-a']);
  assert.deepEqual(summary.completed,['task-a']);
  assert.deepEqual(soko.calls.find(c=>c[1]==='start'),['runtime','start','task-a','--personal','--coworker-id','cw-invoice']);
  assert.equal(model.seen.length,1);
  assert.equal(model.seen[0].role,'invoice');
  assert.equal(model.seen[0].input.task_id,'chk_01-invoice');
  assert.equal(model.seen[0].deadline,61000);
  const result=soko.byId.get('task-a').result;
  const parsed=parseModelJson(result,InvestigatorReport);
  assert.equal(parsed.ok,true);
  assert.equal(parsed.value.verdict,'CLEAR');
  const journal=journalOf(env.paths,'task-a');
  assert.equal(journal.phase,'completed');
  assert.equal(journal.payment.txHash,TX);
  assert.equal(journal.completion.eventId,'ev-task-a');
  assert.equal(journal.source,'model');
  // Nothing is redone on the next pass; the other Coworker's task is never touched.
  now+=5000;
  const again=await worker.tick();
  assert.deepEqual([again.started,again.completed,again.blocked],[[],[],[]]);
  assert.equal(soko.count('runtime','start'),1);
  assert.equal(soko.count('runtime','complete'),1);
  assert.equal(model.seen.length,1);
  assert.equal(soko.byId.get('other-coworker').status,'READY');
 }finally{env.cleanup();}
});

test('invalid input or a role mismatch is journaled as failed and never completed',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([
   {id:'task-bad',status:'READY',description:'not json'},
   {id:'task-wallet',status:'READY',description:inputText('wallet')},
   {id:'task-forged',status:'READY',description:JSON.stringify({...JSON.parse(inputText()),task_id:'chk_99-invoice'})},
  ]);
  for(const [i,id] of ['task-bad','task-wallet','task-forged'].entries())writePaid(env.paths.gateJournal,id,String(i+1).repeat(64));
  const model=reporter(input=>validReport(input));
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  const summary=await worker.tick();
  assert.deepEqual(summary.failed.sort(),['task-bad','task-forged','task-wallet']);
  assert.equal(model.seen.length,0);
  assert.equal(soko.count('runtime','complete'),0);
  assert.match(journalOf(env.paths,'task-bad').error,/not JSON/);
  assert.match(journalOf(env.paths,'task-wallet').error,/role wallet, not invoice/);
  assert.match(journalOf(env.paths,'task-forged').error,/task_id/);
  for(const id of ['task-bad','task-wallet','task-forged'])assert.equal(journalOf(env.paths,id).reason,'invalid_input');
  await worker.tick();
  assert.equal(soko.count('runtime','start'),3);
  assert.equal(soko.count('runtime','complete'),0);
 }finally{env.cleanup();}
});

test('model output invalid after repair completes with an explicit INSUFFICIENT_DATA report',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  const model=reporter(()=>{throw new Error('Model output invalid after repair');});
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  assert.deepEqual((await worker.tick()).completed,['task-a']);
  const parsed=parseModelJson(soko.byId.get('task-a').result,InvestigatorReport);
  assert.equal(parsed.ok,true);
  assert.equal(parsed.value.verdict,'INSUFFICIENT_DATA');
  assert.deepEqual(parsed.value.checks_completed,[]);
  assert.deepEqual(parsed.value.checks_not_verified,['I-1','I-2']);
  assert.equal(parsed.value.task_id,'chk_01-invoice');
  const journal=journalOf(env.paths,'task-a');
  assert.equal(journal.source,'fail-closed');
  assert.equal(journal.reason,'model_output_invalid');
  assert.equal(journal.verdict,'INSUFFICIENT_DATA');
 }finally{env.cleanup();}
});

test('a report that does not belong to the task is never submitted as a model report',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  const model=reporter(input=>validReport(input,{task_id:'chk_01-wallet'}));
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  assert.deepEqual((await worker.tick()).completed,['task-a']);
  assert.equal(model.seen.length,1);
  const result=JSON.parse(soko.byId.get('task-a').result);
  assert.equal(result.verdict,'INSUFFICIENT_DATA');
  assert.equal(result.task_id,'chk_01-invoice');
  assert.equal(journalOf(env.paths,'task-a').reason,'model_output_invalid');
 }finally{env.cleanup();}
});

test('repeated transient model failures end in a fail-closed completion',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  const model=reporter(()=>{throw new Error('fetch failed');});
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  for(let i=0;i<MAX_MODEL_ATTEMPTS;i++)assert.deepEqual((await worker.tick()).completed,[]);
  assert.equal(journalOf(env.paths,'task-a').phase,'model-retry');
  assert.deepEqual((await worker.tick()).completed,['task-a']);
  assert.equal(model.seen.length,MAX_MODEL_ATTEMPTS);
  assert.equal(soko.count('runtime','start'),1);
  assert.equal(JSON.parse(soko.byId.get('task-a').result).verdict,'INSUFFICIENT_DATA');
  assert.equal(journalOf(env.paths,'task-a').reason,'model_unavailable');
 }finally{env.cleanup();}
});

test('transient model errors are retried, then a later success completes normally',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  const model=reporter((input,n)=>{if(n===1)throw new Error('fetch failed');return validReport(input,{verdict:'CONCERN'});});
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  assert.deepEqual((await worker.tick()).started,['task-a']);
  assert.equal(journalOf(env.paths,'task-a').lastError,'fetch failed');
  assert.deepEqual((await worker.tick()).completed,['task-a']);
  assert.equal(soko.count('runtime','start'),1);
  assert.equal(JSON.parse(soko.byId.get('task-a').result).verdict,'CONCERN');
 }finally{env.cleanup();}
});

test('an expired deadline fails closed without a model call',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  let now=0;
  const model=reporter(input=>validReport(input));
  const crashModel=async()=>{now=10_000;throw new Error('fetch failed');};
  const first=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:crashModel,clock:()=>now,deadlineMs:5000,log:env.log});
  await first.tick();
  const second=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,clock:()=>now,deadlineMs:5000,log:env.log});
  assert.deepEqual((await second.tick()).completed,['task-a']);
  assert.equal(model.seen.length,0);
  assert.equal(journalOf(env.paths,'task-a').reason,'deadline_expired');
 }finally{env.cleanup();}
});

test('restart after a crash between start and complete never starts the task again',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([
   {id:'task-started',status:'RUNNING',description:inputText()},
   {id:'task-model',status:'RUNNING',description:inputText()},
   {id:'task-start-pending',status:'READY',description:inputText()},
   {id:'task-complete-pending',status:'RUNNING',description:inputText()},
  ]);
  ['task-started','task-model','task-start-pending','task-complete-pending'].forEach((id,i)=>writePaid(env.paths.gateJournal,id,String(i+1).repeat(64)));
  mkdirSync(env.paths.tasksDir,{recursive:true});
  const write=(id,state)=>writeFileSync(join(env.paths.tasksDir,`${id}.json`),JSON.stringify({taskId:id,payment:{txHash:TX},...state}));
  // Crashed right after runtime start, and in the middle of the model call.
  write('task-started',{phase:'started',input:inputText(),startedAt:Date.now(),attempts:0});
  write('task-model',{phase:'model-pending',input:inputText(),startedAt:Date.now(),attempts:1});
  // Crashed during runtime start / runtime complete: uncertain, needs inspection.
  write('task-start-pending',{phase:'start-pending'});
  const resultFile=join(env.paths.tasksDir,'task-complete-pending.result.json');
  writeFileSync(resultFile,JSON.stringify(validReport(JSON.parse(inputText()))));
  write('task-complete-pending',{phase:'complete-pending',resultFile});
  const model=reporter(input=>validReport(input));
  const worker=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  const summary=await worker.tick();
  assert.equal(soko.count('runtime','start'),0);
  assert.deepEqual(summary.completed.sort(),['task-model','task-started']);
  assert.deepEqual(summary.blocked.sort(),['task-complete-pending','task-start-pending']);
  assert.equal(journalOf(env.paths,'task-model').attempts,2);
  assert.equal(soko.byId.get('task-complete-pending').result,undefined,'an uncertain completion is never resubmitted');
  assert.equal(soko.byId.get('task-start-pending').status,'READY');
  assert.ok(env.lines.some(l=>l.includes('Uncertain start-pending')));
 }finally{env.cleanup();}
});

test('a crash during runtime complete leaves complete-pending and is not resubmitted',async()=>{
 const env=setup();
 try{
  const soko=fakeSokosumi([{id:'task-a',status:'READY',description:inputText()}]);
  writePaid(env.paths.gateJournal,'task-a');
  const model=reporter(input=>validReport(input));
  const failing=async args=>{if(args[1]==='complete')throw new Error('Task event submission failed (HTTP 502). Inspect the Task before retrying.');return soko.cli(args);};
  const first=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:failing,answerReport:model.answerReport,log:env.log});
  assert.deepEqual((await first.tick()).blocked,['task-a']);
  assert.equal(journalOf(env.paths,'task-a').phase,'complete-pending');
  const second=createInvestigatorWorker({role:'invoice',target,paths:env.paths,cli:soko.cli,answerReport:model.answerReport,log:env.log});
  assert.deepEqual((await second.tick()).blocked,['task-a']);
  assert.equal(soko.count('runtime','start'),1);
  assert.equal(soko.count('runtime','complete'),0);
  assert.equal(model.seen.length,1);
 }finally{env.cleanup();}
});

test('one worker lock per role: a second worker for the same role cannot start',()=>{
 const dir=mkdtempSync(join(tmpdir(),'investigator-lock-'));
 try{
  const invoice=investigatorPaths('invoice',{baseDir:dir}),wallet=investigatorPaths('wallet',{baseDir:dir});
  assert.notEqual(invoice.workerLock,wallet.workerLock);
  const release=acquireWorkerLock(invoice.workerLock);
  assert.throws(()=>acquireWorkerLock(invoice.workerLock),/already running/);
  const releaseWallet=acquireWorkerLock(wallet.workerLock);
  releaseWallet();release();
  acquireWorkerLock(invoice.workerLock)();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('fail-closed report is schema-valid and names every unchecked source once',()=>{
 const input=JSON.parse(inputText());
 input.tasks.push({source:'I-1',task:'again'});
 const report=failClosedReport('invoice',input,'model_output_invalid');
 assert.deepEqual(report.checks_not_verified,['I-1','I-2']);
 assert.equal(report.critical_issue,false);
 assert.equal(InvestigatorReport.safeParse(report).success,true);
});
