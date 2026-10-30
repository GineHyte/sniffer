import { Client } from 'eve/client';
import { writeFileSync } from 'node:fs';
import {roleToAgent,parseModelJson,InvestigatorReport,MainReport} from './agents/report-schema.mjs';
export const client=new Client({host:process.env.EVE_URL});
export const REPORT_INPUT_MAX_CHARS=100000;
const reportSchemas=Object.freeze(Object.assign(Object.create(null),{invoice:InvestigatorReport,wallet:InvestigatorReport,supplier:InvestigatorReport,main:MainReport}));
const record=(journal,state)=>writeFileSync(journal,JSON.stringify(state),{mode:0o600});
const beforeDeadline=(deadline,stage)=>{if(deadline!==undefined&&Date.now()>=deadline)throw new Error(`Result deadline expired before ${stage}`);};
async function finalMessage(session,message){
 const result=await (await session.send(message)).result();
 if(result.status==='failed'||result.inputRequests.length||!result.message?.trim()) throw new Error('Turn did not return a final answer');
 return result.message;
}
export async function answer(input,journal,deadline,{client:eve=client}={}) {
 if(typeof input!=='string'||!input.trim()||input.length>16000) throw new Error('Input must contain 1 to 16000 characters');
 const {session}=await eve.sessions.create();
 record(journal,{sessionId:session.state.sessionId,phase:'sending'});
 beforeDeadline(deadline,'model send');
 const message=await finalMessage(session,input);
 record(journal,{sessionId:session.state.sessionId,phase:'answered',result:message});
 return message;
}
const expectedId=(input,key)=>{const value=input[key];if(typeof value!=='string'||!value.trim())throw new Error(`Report input needs a non-empty ${key}`);return value.trim();};
export function validateReport(role,text,ids){
 const parsed=parseModelJson(text,reportSchemas[role]);
 if(!parsed.ok)return parsed;
 const report=parsed.value;
 if(role!=='main'&&report.agent!==roleToAgent[role])return {ok:false,error:`agent must be ${JSON.stringify(roleToAgent[role])}`};
 for(const [key,value] of Object.entries(ids))if(report[key]!==value)return {ok:false,error:`${key} must be ${JSON.stringify(value)}`};
 return parsed;
}
export const repairMessage=error=>`Return only the JSON object matching the required schema. Problem: ${String(error).slice(0,400)}`;
export async function answerReport(role,input,journal,deadline,{client:eve=client}={}) {
 if(!Object.hasOwn(reportSchemas,role))throw new Error(`Unknown report role: ${JSON.stringify(String(role).slice(0,40))}`);
 if(input===null||typeof input!=='object'||Array.isArray(input))throw new Error('Report input must be a JSON object');
 const ids=role==='main'?{case_id:expectedId(input,'case_id')}:{case_id:expectedId(input,'case_id'),task_id:expectedId(input,'task_id')};
 const message=JSON.stringify(input);
 if(message.length>REPORT_INPUT_MAX_CHARS)throw new Error(`Report input must serialize to at most ${REPORT_INPUT_MAX_CHARS} characters`);
 const {session}=await eve.sessions.create();
 const sessionId=session.state.sessionId;
 record(journal,{sessionId,role,phase:'sending'});
 beforeDeadline(deadline,'model send');
 let checked=validateReport(role,await finalMessage(session,message),ids);
 if(!checked.ok){
  record(journal,{sessionId,role,phase:'repairing',error:checked.error});
  beforeDeadline(deadline,'repair send');
  checked=validateReport(role,await finalMessage(session,repairMessage(checked.error)),ids);
  if(!checked.ok){
   record(journal,{sessionId,role,phase:'invalid',error:checked.error});
   throw new Error('Model output invalid after repair');
  }
 }
 record(journal,{sessionId,role,phase:'answered',result:JSON.stringify(checked.value)});
 return checked.value;
}
