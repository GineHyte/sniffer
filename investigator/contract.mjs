import {z} from 'zod';
import {roleToAgent} from '../agents/report-schema.mjs';

// Shared contract between the Main orchestrator (writer, T26) and the investigator
// worker and API (reader, T25). Change it only together with both sides.

export const INVESTIGATOR_ROLES=Object.freeze(['invoice','wallet','supplier']);
export const INPUT_SCHEMA_VERSION='1';
// Upper bound for the serialized task description sent through Sokosumi.
export const MAX_INPUT_CHARS=16000;
// Sokosumi task IDs as they appear in `POST /pay/{taskId}` and in journal file names.
// A subset of x402/gate.mjs RESOURCE_ID_REGEX and x402/pay.mjs PAY_KEY_REGEX.
export const TASK_ID_REGEX=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const id=z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const AgentTask=z.strictObject({source:z.string().min(1).max(64),task:z.string().min(1).max(2000)});
export const InvestigatorInput=z.strictObject({
 schema_version:z.literal(INPUT_SCHEMA_VERSION),
 case_id:id,
 task_id:id,
 role:z.enum(INVESTIGATOR_ROLES),
 agent:z.enum(Object.values(roleToAgent)),
 tasks:z.array(AgentTask).max(50),
 data:z.record(z.string(),z.unknown())
}).superRefine((input,ctx)=>{
 if(input.agent!==roleToAgent[input.role])ctx.addIssue({code:'custom',path:['agent'],message:`agent must be ${roleToAgent[input.role]}`});
 if(input.task_id!==investigatorTaskId(input.case_id,input.role))ctx.addIssue({code:'custom',path:['task_id'],message:'task_id must be <case_id>-<role>'});
});

// The logical task ID inside the report (`report.task_id`). Not the Sokosumi task ID.
export function investigatorTaskId(caseId,role){
 if(!INVESTIGATOR_ROLES.includes(role))throw new Error(`Unknown investigator role: ${JSON.stringify(String(role).slice(0,40))}`);
 return `${caseId}-${role}`;
}

export function buildInvestigatorInput({case_id,role,tasks,data}){
 const input={schema_version:INPUT_SCHEMA_VERSION,case_id,task_id:investigatorTaskId(case_id,role),role,agent:roleToAgent[role],tasks,data};
 const parsed=InvestigatorInput.safeParse(input);
 if(!parsed.success)throw new Error(`Invalid investigator input: ${parsed.error.issues.map(i=>`${i.path.join('.')||'(root)'}: ${i.message}`).join('; ').slice(0,400)}`);
 const text=JSON.stringify(parsed.data);
 if(text.length>MAX_INPUT_CHARS)throw new Error(`Investigator input must serialize to at most ${MAX_INPUT_CHARS} characters`);
 return {input:parsed.data,text};
}

// Sokosumi prepends the Workspace design document to stored task descriptions (measured on Preprod 2026-10-31):
// `[DESIGN.md](https://…)\n\n<original text>`. Only whole lines that are each one https Markdown link, followed by
// at least one blank line, are removed; anything else is returned unchanged so the JSON check still fails closed.
export const MAX_DESCRIPTION_PREFIX_CHARS=2000;
const DESCRIPTION_PREFIX_REGEX=/^(?:[ \t]*\[[^\[\]\r\n]+\]\(https:\/\/[^\s()]+\)[ \t]*\r?\n)+(?:[ \t]*\r?\n)+/;
export function stripDescriptionPrefix(text){
 if(typeof text!=='string')return text;
 const match=DESCRIPTION_PREFIX_REGEX.exec(text);
 return match&&match[0].length<=MAX_DESCRIPTION_PREFIX_CHARS?text.slice(match[0].length):text;
}

export function parseInvestigatorInput(text,expectedRole){
 const sizeError=()=>new Error(`Task description must contain 1 to ${MAX_INPUT_CHARS} characters`);
 if(typeof text!=='string'||text.length>MAX_INPUT_CHARS+MAX_DESCRIPTION_PREFIX_CHARS)throw sizeError();
 const body=stripDescriptionPrefix(text);
 if(!body.trim()||body.length>MAX_INPUT_CHARS)throw sizeError();
 let value;
 try{value=JSON.parse(body)}catch{throw new Error('Task description is not JSON')}
 const parsed=InvestigatorInput.safeParse(value);
 if(!parsed.success)throw new Error(`Invalid investigator input: ${parsed.error.issues.map(i=>`${i.path.join('.')||'(root)'}: ${i.message}`).join('; ').slice(0,400)}`);
 if(expectedRole!==undefined&&parsed.data.role!==expectedRole)throw new Error(`Task is for role ${parsed.data.role}, not ${expectedRole}`);
 return parsed.data;
}

export function assertTaskId(taskId){
 if(typeof taskId!=='string'||!TASK_ID_REGEX.test(taskId))throw new Error('Invalid Sokosumi task ID');
 return taskId;
}

// Investigator payment endpoint, relative to the role's INVESTIGATOR_<ROLE>_URL.
export function investigatorPayPath(taskId){
 return `/pay/${encodeURIComponent(assertTaskId(taskId))}`;
}
