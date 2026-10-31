// Sokosumi task create/read for the investigators (Task 26). Verified against the installed CLI 1.0.4:
//  - `tasks create … --json` prints {task, events, jobs}; task = parseTask(POST /v1/tasks) with `id`, `status`, `coworkerId`
//    (dist/src/cli/commands/tasks.js, dist/src/api/models/task.js).
//  - `tasks get TASK_ID --json` prints {task, events, jobs}; `events` are the raw GET /v1/tasks/{id}/events entries.
//  - `runtime complete --result-file` posts the event {status:"COMPLETED", comment:<result text>}
//    (dist/src/coworker/runtime-task.js completeVerifiedTask). The report is therefore the `comment` of the COMPLETED event.
//  - `tasks list --coworker-id ID --limit N --json` prints {tasks:[parseTask(...)]} with id, name, description, status,
//    coworkerId (or assigneeId), createdAt, … from the first page of GET /v1/tasks?coworkerId=&take=
//    (dist/src/cli/commands/tasks.js runTasksCommand "list", dist/src/api/services/task-service.js fetchTasks).
import {assertTaskId,TASK_ID_REGEX} from '../investigator/contract.mjs';

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
 if(task.coworkerId&&task.coworkerId!==coworkerId)throw Object.assign(new Error(`Task ${taskId} was created for another Coworker`),{code:'coworker_mismatch',taskId});
 return {taskId,status:task.status??null};
}

// Page size for the read-only existence check. `tasks list` returns only the first page (CLI 1.0.4 fetchTasks has
// no cursor loop), so "none found" counts as proof only when fewer than this many tasks came back.
export const TASK_CHECK_LIMIT=100;

const taskIdInDescription=description=>{
 if(typeof description!=='string')return undefined;
 try{const value=JSON.parse(description);return typeof value?.task_id==='string'?value.task_id:undefined;}catch{return undefined;}
};

/**
 * Read-only check whether an investigator task for (case, role) exists after a failed or interrupted create.
 * A listed task matches when its name is the expected name, its description is the exact text, or the JSON
 * description carries the logical task_id `<case_id>-<role>`. Uses `tasks list --coworker-id … --limit …` and,
 * when a single match lacks its Coworker ID, `tasks get` to confirm the assignee.
 * @returns {Promise<{outcome:'found',task_id:string,listed:number}|{outcome:'none',listed:number}|{outcome:'ambiguous'|'check_failed',reason:string,listed?:number,matches?:string[]}>}
 */
export async function findCreatedTask({run,coworkerId,taskArgs=[],name,description,logicalTaskId,limit=TASK_CHECK_LIMIT}){
 let out;
 try{out=await run(['tasks','list',...taskArgs,'--coworker-id',coworkerId,'--limit',String(limit)]);}
 catch(error){return {outcome:'check_failed',reason:`list_failed: ${String(error?.message).slice(0,200)}`};}
 const tasks=out?.tasks;
 if(!Array.isArray(tasks))return {outcome:'check_failed',reason:'list_response_invalid'};
 const listed=tasks.length;
 const isMatch=task=>task&&typeof task==='object'&&(task.name===name||task.description===description||taskIdInDescription(task.description)===logicalTaskId);
 const matches=tasks.filter(isMatch);
 const ids=matches.map(task=>String(task.id));
 if(matches.length>1)return {outcome:'ambiguous',reason:'multiple_matches',listed,matches:ids};
 if(matches.length===1){
  const [task]=matches;
  if(typeof task.id!=='string'||!TASK_ID_REGEX.test(task.id))return {outcome:'ambiguous',reason:'match_without_valid_id',listed,matches:ids};
  let assignee=task.coworkerId;
  if(assignee===null||assignee===undefined){
   try{assignee=(await run(['tasks','get',task.id,...taskArgs]))?.task?.coworkerId??null;}
   catch(error){return {outcome:'check_failed',reason:`get_failed: ${String(error?.message).slice(0,200)}`,listed,matches:ids};}
  }
  if(assignee!==coworkerId)return {outcome:'ambiguous',reason:'match_for_other_coworker',listed,matches:ids};
  return {outcome:'found',task_id:task.id,listed};
 }
 if(tasks.some(task=>typeof task?.name!=='string'&&typeof task?.description!=='string'))return {outcome:'ambiguous',reason:'unidentifiable_tasks',listed};
 if(listed>=limit)return {outcome:'ambiguous',reason:'list_may_be_truncated',listed};
 return {outcome:'none',listed};
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
