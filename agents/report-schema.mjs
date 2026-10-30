import {z} from 'zod';

export const roleToAgent=Object.freeze(Object.assign(Object.create(null),{invoice:'InvoiceInvestigator',wallet:'WalletInvestigator',supplier:'SupplierInvestigator'}));
export const rustAgentToRole=Object.freeze(Object.assign(Object.create(null),{research:'supplier',invoice:'invoice',wallet:'wallet'}));

const id=z.string().trim().min(1);
const strings=z.array(z.string());
const banned=/betrug|fraud/iu;

export const Finding=z.strictObject({finding:z.string(),severity:z.enum(['LOW','MEDIUM','HIGH']),details:z.string()});
export const Evidence=z.strictObject({source_id:z.string(),fact:z.string(),relevance:z.string()});

export const InvestigatorReport=z.strictObject({
 schema_version:z.literal('1.0'),
 agent:z.enum(Object.values(roleToAgent)),
 case_id:id,
 task_id:id,
 verdict:z.enum(['CLEAR','CONCERN','CRITICAL','INSUFFICIENT_DATA']),
 findings:z.array(Finding),
 evidence:z.array(Evidence),
 checks_completed:strings,
 checks_not_verified:strings,
 missing_information:strings,
 critical_issue:z.boolean(),
 explanation:z.string()
}).superRefine((report,ctx)=>{
 if(report.verdict==='CRITICAL'&&report.evidence.length===0)ctx.addIssue({code:'custom',path:['evidence'],message:'CRITICAL verdict requires at least one evidence entry'});
});

export const DeclineReason=z.strictObject({id,text:z.string().max(500),evidence:z.string().max(500)});

export const MainReport=z.strictObject({
 agent:z.literal('MainSniffer'),
 case_id:id,
 initial_risk_score:z.int().min(0).max(100),
 initial_risk_level:z.enum(['LOW','MEDIUM','HIGH']),
 final_risk_level:z.enum(['LOW','HIGH']),
 decision:z.enum(['PAY','DONT_PAY']),
 decision_reason:z.string(),
 decline_reasons:z.array(DeclineReason).max(10),
 hard_stops:z.array(z.unknown()),
 agent_reports:z.array(z.unknown()),
 key_findings:z.array(z.unknown()),
 evidence_references:z.array(z.unknown()),
 missing_information:strings,
 policy_status:z.enum(['NOT_EVALUATED','APPROVED','REJECTED','ERROR']),
 supplier_payment_status:z.enum(['NOT_STARTED','PENDING','SUBMITTED','CONFIRMED','FAILED','BLOCKED','UNKNOWN']),
 supplier_transaction_hash:z.string().min(1).nullable(),
 explanation:z.string()
}).superRefine((report,ctx)=>{
 const issue=(path,message)=>ctx.addIssue({code:'custom',path,message});
 const reasons=report.decline_reasons;
 if(report.decision==='PAY'){
  if(reasons.length)issue(['decline_reasons'],'PAY requires empty decline_reasons');
  if(report.final_risk_level!=='LOW')issue(['final_risk_level'],'PAY requires final_risk_level LOW');
 }else{
  if(report.final_risk_level!=='HIGH')issue(['final_risk_level'],'DONT_PAY requires final_risk_level HIGH');
  if(reasons.length<1||reasons.length>10)issue(['decline_reasons'],'DONT_PAY requires 1-10 decline_reasons');
 }
 reasons.forEach((reason,index)=>{for(const key of ['text','evidence'])if(banned.test(reason[key]))issue(['decline_reasons',index,key],'decline reason must not contain banned wording');});
});

const clip=(value,max=80)=>{const text=String(value);return text.length>max?`${text.slice(0,max-1)}…`:text;};
const fail=error=>({ok:false,error});

export function parseModelJson(text,schema){
 if(typeof text!=='string')return fail('Model output must be a string');
 const trimmed=text.trim();
 if(!trimmed.startsWith('{')||!trimmed.endsWith('}'))return fail(`Model output must be a single JSON object without Markdown or prose: ${JSON.stringify(clip(trimmed))}`);
 let value;
 try{value=JSON.parse(trimmed);}catch{return fail(`Model output is not valid JSON: ${JSON.stringify(clip(trimmed))}`);}
 if(value===null||typeof value!=='object'||Array.isArray(value))return fail('Model output must be a JSON object');
 const result=schema.safeParse(value);
 if(result.success)return {ok:true,value:result.data};
 const issues=result.error.issues.slice(0,5).map(issue=>clip(`${issue.path.join('.')||'(root)'}: ${issue.message}`));
 return fail(`Model output does not match schema: ${issues.join('; ')}${result.error.issues.length>5?'; …':''}`);
}
