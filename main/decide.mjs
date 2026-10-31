// Code guardrails for the Medium-case decision (Task 26, plan §M4, A3–A5). Code wins over the Main LLM.
//  1. A missing or invalid report, or any INSUFFICIENT_DATA verdict → rejected / formal, no wallet block.
//  2. Any CRITICAL verdict → rejected / risk.
//  3. Main LLM failed (no valid main-prompt JSON) → rejected / formal (an operational failure is no evidence of risk).
//  4. LLM DONT_PAY → rejected / risk.
//  5. Otherwise approved.
// block_wallet is true only in a risk rejection where the Wallet report is CRITICAL with critical_issue === true (A4).
// decline_reasons are German, 1–10, built only from fixed texts and the criteria's customer_text; never from model prose.
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INVESTIGATOR_ROLES} from '../investigator/contract.mjs';

export const BANNED_WORDING=/betrug|fraud/iu;
export const MAX_DECLINE_REASONS=10;
export const MAX_REASON_CHARS=500;
const CRITERIA_PATH=join(dirname(fileURLToPath(import.meta.url)),'..','backend','config','criteria.json');
const RUST_AGENT={invoice:'invoice',wallet:'wallet',supplier:'research'};
const ROLE_LABEL={invoice:'Prüfung der Rechnungsangaben',wallet:'Prüfung der Zahlungsadresse',supplier:'Prüfung des Rechnungsstellers'};
const ROLE_TEXT={
 invoice:'Die zusätzliche Prüfung der Rechnungsangaben ergab Auffälligkeiten.',
 wallet:'Die zusätzliche Prüfung der Zahlungsadresse ergab Auffälligkeiten.',
 supplier:'Die zusätzliche Prüfung der Angaben zum Rechnungssteller ergab Auffälligkeiten.',
};
const STATUS_TEXT={missing:'kein Bericht',timeout:'Zeitüberschreitung',invalid:'ungültiger Bericht',failed:'Prüfung fehlgeschlagen',unpaid:'nicht beauftragt'};
export const FALLBACK_REASON=Object.freeze({id:'AGENT_REVIEW',text:'Die Rechnung kann nach der zusätzlichen Prüfung nicht automatisch bezahlt werden.',evidence:'Ergebnis der zusätzlichen Prüfung.'});

/** Reads {criterion id → customer_text} from the backend criteria config. */
export function loadCustomerTexts(path=CRITERIA_PATH){
 const config=JSON.parse(readFileSync(path,'utf8'));
 const texts=Object.create(null);
 for(const criterion of config.criteria??[])if(typeof criterion?.id==='string'&&typeof criterion.customer_text==='string')texts[criterion.id]=criterion.customer_text;
 return texts;
}

const clipChars=(value,max=MAX_REASON_CHARS)=>{const chars=[...String(value??'').trim()];return chars.length>max?`${chars.slice(0,max-1).join('')}…`:chars.join('');};
export const hasBannedWording=reason=>BANNED_WORDING.test(reason?.text??'')||BANNED_WORDING.test(reason?.evidence??'')||BANNED_WORDING.test(reason?.id??'');

/** Throws if any reason would break the A5 wording rule or the 5.4 limits. Run right before POST /v1/decisions. */
export function assertSendableReasons(reasons,decision){
 if(!Array.isArray(reasons))throw new Error('decline_reasons must be an array');
 if(decision==='approved'){if(reasons.length)throw new Error('approved requires empty decline_reasons');return;}
 if(reasons.length<1||reasons.length>MAX_DECLINE_REASONS)throw new Error('rejected requires 1-10 decline_reasons');
 for(const reason of reasons){
  if(hasBannedWording(reason))throw new Error('Refusing to send a decline reason with forbidden wording');
  if(!String(reason.id??'').trim()||!String(reason.text??'').trim())throw new Error('decline reason needs id and text');
  if([...reason.text].length>MAX_REASON_CHARS||[...String(reason.evidence??'')].length>MAX_REASON_CHARS)throw new Error('decline reason exceeds 500 characters');
 }
}

const isValid=entry=>entry?.valid===true&&entry.report&&typeof entry.report==='object';
const llmUsable=llm=>llm!==null&&typeof llm==='object'&&(llm.decision==='PAY'||llm.decision==='DONT_PAY');

function sanitize(entries){
 const seen=new Set();const out=[];
 for(const entry of entries){
  const reason={id:clipChars(entry.id,64),text:clipChars(entry.text),evidence:clipChars(entry.evidence)};
  if(!reason.id||!reason.text||seen.has(reason.id)||hasBannedWording(reason))continue;
  seen.add(reason.id);out.push(reason);
  if(out.length===MAX_DECLINE_REASONS)break;
 }
 return out.length?out:[{...FALLBACK_REASON}];
}

function criteriaReasons(result,customerTexts,focusRoles){
 const focus=new Set(focusRoles.map(role=>RUST_AGENT[role]));
 const criteria=(Array.isArray(result?.criteria)?result.criteria:[])
  .filter(criterion=>typeof criterion?.id==='string'&&Number(criterion.points)>0&&typeof customerTexts?.[criterion.id]==='string');
 criteria.sort((a,b)=>(focus.has(b.agent)-focus.has(a.agent))||(Number(b.points)-Number(a.points)));
 return criteria.map(criterion=>({id:criterion.id,text:customerTexts[criterion.id],evidence:typeof criterion.evidence==='string'?criterion.evidence:''}));
}

/**
 * @param {object|null} llm Validated main-prompt JSON, or null when the Main LLM failed.
 * @param {Record<'invoice'|'wallet'|'supplier',{valid:boolean,report?:object,status?:string}>} reports
 * @param {{result?:object,customerTexts?:Record<string,string>}} [context] Rust check result and criterion texts.
 * @returns {{decision:'approved'|'rejected',reason_type:null|'formal'|'risk',block_wallet:boolean,decline_reasons:object[],rule:string}}
 */
export function decide(llm,reports,{result,customerTexts={}}={}){
 const valid=role=>isValid(reports?.[role]);
 const verdict=role=>valid(role)?reports[role].report.verdict:undefined;
 const missing=INVESTIGATOR_ROLES.filter(role=>!valid(role));
 const insufficient=INVESTIGATOR_ROLES.filter(role=>verdict(role)==='INSUFFICIENT_DATA');
 const critical=INVESTIGATOR_ROLES.filter(role=>verdict(role)==='CRITICAL');
 const concern=INVESTIGATOR_ROLES.filter(role=>verdict(role)==='CONCERN');
 const walletBlock=valid('wallet')&&reports.wallet.report.verdict==='CRITICAL'&&reports.wallet.report.critical_issue===true;

 let outcome;
 if(missing.length||insufficient.length)outcome={decision:'rejected',reason_type:'formal',block_wallet:false,rule:missing.length?'missing_report':'insufficient_data'};
 else if(critical.length)outcome={decision:'rejected',reason_type:'risk',block_wallet:walletBlock,rule:'critical_report'};
 else if(!llmUsable(llm))outcome={decision:'rejected',reason_type:'formal',block_wallet:false,rule:'main_llm_failed'};
 else if(llm.decision==='DONT_PAY')outcome={decision:'rejected',reason_type:'risk',block_wallet:walletBlock,rule:'llm_dont_pay'};
 else return {decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[],rule:'approved'};

 const entries=[];
 if(outcome.reason_type==='formal'){
  if(missing.length)entries.push({id:'AGENT_REVIEW_INCOMPLETE',text:'Die zusätzliche Prüfung dieser Rechnung konnte nicht vollständig abgeschlossen werden. Die Rechnung wird daher nicht automatisch bezahlt.',
   evidence:`Kein gültiges Prüfergebnis: ${missing.map(role=>`${ROLE_LABEL[role]} (${STATUS_TEXT[reports?.[role]?.status]??STATUS_TEXT.missing})`).join(', ')}.`});
  if(insufficient.length)entries.push({id:'AGENT_REVIEW_INSUFFICIENT_DATA',text:'Für die zusätzliche Prüfung lagen nicht genug Informationen vor. Die Rechnung wird daher nicht automatisch bezahlt.',
   evidence:`Unzureichende Datenlage: ${insufficient.map(role=>ROLE_LABEL[role]).join(', ')}.`});
  if(outcome.rule==='main_llm_failed')entries.push({id:'AGENT_DECISION_UNAVAILABLE',text:'Die abschließende Bewertung der zusätzlichen Prüfung konnte nicht erstellt werden. Die Rechnung wird daher nicht automatisch bezahlt.',
   evidence:'Die automatische Gesamtbewertung lieferte kein gültiges Ergebnis.'});
 }else{
  for(const role of [...critical,...concern])entries.push({id:`AGENT_${role.toUpperCase()}`,text:ROLE_TEXT[role],
   evidence:`Ergebnis der ${ROLE_LABEL[role]}: ${verdict(role)==='CRITICAL'?'schwerwiegende Auffälligkeit':'Auffälligkeit'}.`});
  if(!critical.length&&!concern.length)entries.push({id:'AGENT_REVIEW_RISK',text:'Die Gesamtbewertung der zusätzlichen Prüfung erlaubt keine automatische Zahlung.',evidence:'Gesamtbewertung: Zahlung nicht freigegeben.'});
 }
 entries.push(...criteriaReasons(result,customerTexts,[...critical,...concern,...insufficient]));
 return {...outcome,decline_reasons:sanitize(entries)};
}

/** The POST /v1/decisions body (spec 5.4) for a decide() outcome. */
export function decisionRequest(checkId,outcome){
 const body=outcome.decision==='approved'
  ?{check_id:checkId,decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[]}
  :{check_id:checkId,decision:'rejected',reason_type:outcome.reason_type,block_wallet:outcome.reason_type==='risk'&&outcome.block_wallet===true,decline_reasons:outcome.decline_reasons};
 assertSendableReasons(body.decline_reasons,body.decision);
 return body;
}
