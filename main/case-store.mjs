// Durable per-case journal under <stateDir>/cases/<case_id>/ (Task 26). One process per state dir.
// case.json is replaced atomically (temp file + rename). invoice.xml exists only until the initial check is done.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from '../x402/pay.mjs';

export const CASE_ID_RE=/^case-[0-9a-f]{32}$/;
export const TERMINAL_STATUSES=new Set(['completed','failed','needs_inspection']);
// Intake states: 'submitted' (customer tx verified and submitted, not yet on chain), 'confirmed', 'failed'.
// A journal from before the early start has no state; it was accepted only after a confirmed settle.
export const intakeState=state=>state?.intake?(state.intake.state??'confirmed'):null;
/** The customer's intake tx is not confirmed yet and something still waits for it (counts against MAX_UNCONFIRMED_INTAKES). */
export const intakeAwaiting=state=>intakeState(state)==='submitted'&&state.status!=='needs_inspection'&&!state.intake.timed_out_at;
/** A completed case whose payout tx is submitted and still waits for on-chain confirmation. */
export const payoutAwaiting=state=>state?.status==='completed'&&state.steps?.payout?.phase==='submitted';
/** True while a case still has work for the runner: an open case, or a background intake/payout confirmation. */
export const hasOpenWork=state=>!!state&&(!TERMINAL_STATUSES.has(state.status)||intakeAwaiting(state)||payoutAwaiting(state));
export const assertCaseId=id=>{if(typeof id!=='string'||!CASE_ID_RE.test(id))throw new Error('Invalid case ID');return id;};

/** The intake binds one paid resource and one case to the SHA-256 of the submitted XML. */
export function intakeIds(xml){
 const digest=createHash('sha256').update(xml,'utf8').digest('hex');
 return {resourceId:`xml-${digest}`,caseId:`case-${digest.slice(0,32)}`,xmlSha256:digest};
}

export function createCaseStore(stateDir){
 if(typeof stateDir!=='string'||!stateDir)throw new Error('stateDir is required');
 const casesDir=join(stateDir,'cases');
 const dirOf=caseId=>join(casesDir,assertCaseId(caseId));
 const fileOf=caseId=>join(dirOf(caseId),'case.json');
 return {
  stateDir,
  dirOf,
  xmlPath:caseId=>join(dirOf(caseId),'invoice.xml'),
  payJournalDir:caseId=>join(dirOf(caseId),'pay'),
  llmJournalPath:caseId=>join(dirOf(caseId),'main-llm.json'),
  read(caseId){
   let text;
   try{text=readFileSync(fileOf(caseId),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw new Error(`Case journal ${caseId} is unreadable (${error.code}). Inspect it manually.`);}
   try{const value=JSON.parse(text);if(value?.version===1&&value.case_id===caseId)return value;}catch{}
   throw new Error(`Case journal ${caseId} is not valid. Inspect it manually.`);
  },
  write(state){writeJsonAtomic(fileOf(state.case_id),state);return state;},
  // Writes the XML, then the case journal, so an existing case.json always has its XML until the check ran.
  create({caseId,xml,intake,now}){
   const dir=dirOf(caseId);
   mkdirSync(dir,{recursive:true,mode:0o700});
   writeFileSync(join(dir,'invoice.xml'),xml,{mode:0o600});
   const at=now.toISOString();
   return this.write({version:1,case_id:caseId,status:'accepted',created_at:at,updated_at:at,intake,steps:{}});
  },
  readXml(caseId){try{return readFileSync(join(dirOf(caseId),'invoice.xml'),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}},
  removeXml(caseId){rmSync(join(dirOf(caseId),'invoice.xml'),{force:true});},
  list(){
   if(!existsSync(casesDir))return [];
   return readdirSync(casesDir,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&CASE_ID_RE.test(entry.name)).map(entry=>entry.name).sort();
  },
 };
}
