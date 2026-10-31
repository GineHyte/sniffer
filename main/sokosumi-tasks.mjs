// Sokosumi task create/read for the investigators (Task 26). Verified against the installed CLI 1.0.4:
//  - `tasks create … --json` prints {task, events, jobs}; task = parseTask(POST /v1/tasks) with `id`, `status`, `coworkerId`
//    (dist/src/cli/commands/tasks.js, dist/src/api/models/task.js).
//  - `tasks get TASK_ID --json` prints {task, events, jobs}; `events` are the raw GET /v1/tasks/{id}/events entries.
//  - `runtime complete --result-file` posts the event {status:"COMPLETED", comment:<result text>}
//    (dist/src/coworker/runtime-task.js completeVerifiedTask). The report is therefore the `comment` of the COMPLETED event.
import {assertTaskId} from '../investigator/contract.mjs';

export const FAILED_STATUSES=new Set(['FAILED','CANCELED','CANCELLED','ERROR','REJECTED']);

export function orgArgs(slug){
 const value=typeof slug==='string'?slug.trim():'';
 if(!value)return [];
 if(!/^[a-zA-Z0-9_-]+$/.test(value))throw new Error('SOKOSUMI_ORGANIZATION_SLUG must be a valid Workspace slug');
 return ['--organization-slug',value];
}

/** Creates one READY task for a Coworker. Returns the Sokosumi task ID. Throws if the response has no valid ID. */
export async function createInvestigatorTask({run,coworkerId,taskArgs=[],name,description}){
 if(typeof coworkerId!=='string'||!coworkerId.trim())throw new Error('Coworker ID is missing');
 const out=await run(['tasks','create',...taskArgs,'--coworker-id',coworkerId,'--name',name,'--description',description,'--status','READY']);
 const task=out?.task;
 const taskId=assertTaskId(task?.id);
 if(task.coworkerId&&task.coworkerId!==coworkerId)throw new Error(`Task ${taskId} was created for another Coworker`);
 return {taskId,status:task.status??null};
}

/**
 * Interprets a `tasks get` response.
 * @returns {{state:'pending'|'completed'|'failed',status:string|null,text?:string,error?:string}}
 */
export function taskOutcome(out,{taskId,coworkerId}){
 const task=out?.task;
 if(!task||task.id!==taskId)return {state:'failed',status:null,error:'task_mismatch'};
 if(task.coworkerId&&task.coworkerId!==coworkerId)return {state:'failed',status:task.status??null,error:'coworker_mismatch'};
 const status=typeof task.status==='string'?task.status.toUpperCase():null;
 if(status&&FAILED_STATUSES.has(status))return {state:'failed',status,error:'task_failed'};
 if(status!=='COMPLETED')return {state:'pending',status};
 const events=Array.isArray(out.events)?out.events:[];
 const completed=events.filter(event=>event&&typeof event==='object'&&event.status==='COMPLETED'&&typeof event.comment==='string'&&event.comment.trim()
  &&(event.taskId===undefined||event.taskId===taskId)
  &&(event.actor===undefined||event.actor===null||(event.actor.type==='coworker'&&event.actor.id===coworkerId)));
 // Events may be missing when the events fetch failed (detailsErrors); keep polling until the deadline.
 if(!completed.length)return {state:'pending',status,error:'completed_without_result'};
 return {state:'completed',status,text:completed.at(-1).comment};
}

export async function readInvestigatorTask({run,taskId,taskArgs=[]}){
 return run(['tasks','get',assertTaskId(taskId),...taskArgs]);
}
