// Shared fixtures for investigator tests. Not imported by runtime code.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {buildInvestigatorInput} from './contract.mjs';

export const target=Object.freeze({coworkerId:'cw-invoice',organizationId:null,taskArgs:[],runtimeArgs:['--personal']});
export const TX='ab'.repeat(32);

export function inputText(role='invoice',caseId='chk_01'){
 return buildInvestigatorInput({case_id:caseId,role,tasks:[{source:'I-1',task:'Prüfe die Summen.'},{source:'I-2',task:'Prüfe die IBAN.'}],data:{total:'100.00'}}).text;
}

export function validReport(input,overrides={}){
 return {schema_version:'1.0',agent:'InvoiceInvestigator',case_id:input.case_id,task_id:input.task_id,verdict:'CLEAR',findings:[],evidence:[],
  checks_completed:['I-1','I-2'],checks_not_verified:[],missing_information:[],critical_issue:false,explanation:'Totals match.',...overrides};
}

// In-memory Sokosumi: tasks list, runtime start (READY -> RUNNING), runtime complete (RUNNING -> COMPLETED).
export function fakeSokosumi(tasks){
 const calls=[];
 const byId=new Map(tasks.map(task=>[task.id,{coworkerId:target.coworkerId,organizationId:null,name:'Investigate',...task}]));
 const cli=async args=>{
  calls.push(args);
  const [group,command,taskId]=args;
  if(group==='tasks'&&command==='list')return {tasks:[...byId.values()].map(({description,result,...rest})=>rest)};
  const task=byId.get(taskId);
  if(!task)throw new Error('Task read failed (HTTP 404). Inspect the Task before retrying.');
  if(group==='runtime'&&command==='start'){
   if(task.status!=='READY')throw new Error('Task must be READY. No further operation was submitted.');
   task.status='RUNNING';
   return {id:task.id,name:task.name,description:task.description,organizationId:null,assigneeId:target.coworkerId,status:'RUNNING'};
  }
  if(group==='runtime'&&command==='complete'){
   if(task.status!=='RUNNING')throw new Error('Task must be RUNNING. No further operation was submitted.');
   const result=readFileSync(args[args.indexOf('--result-file')+1],'utf8');
   task.status='COMPLETED';task.result=result;
   return {taskId:task.id,eventId:`ev-${task.id}`,status:'COMPLETED',result};
  }
  throw new Error(`Unexpected CLI call ${args.join(' ')}`);
 };
 const count=(group,command)=>calls.filter(c=>c[0]===group&&c[1]===command).length;
 return {cli,calls,byId,count};
}

// Writes a gate journal entry in the shape x402/gate.mjs records after a settle.
export function writePaid(path,taskId,txHash=TX,{state='paid',status='confirmed'}={}){
 const journal=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1,payments:{}};
 journal.payments[txHash]={resourceId:taskId,state,settlement:{transaction:txHash,network:'cardano:preprod',extra:{status,confirmations:0}},paidAt:'2026-10-31T00:00:00.000Z'};
 writeFileSync(path,JSON.stringify(journal));
}
