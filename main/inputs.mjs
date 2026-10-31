// Domain-scoped investigator inputs (Task 26, A6, main prompt Step 4). Each role gets only the fields of its domain.
//  invoice:  Rust invoice block (numbers, dates, totals, validation status), invoice-side XML fields (notes, terms,
//            line items, totals, order/contract refs), the supplier approved-amount history (O2), and the open order the
//            Rust backend matched to BT-13 + BT-31 (`open_order`, null without a match). No names, no address.
//  wallet:   raw recipient address (BT-84) and payment means, Rust wallet/pair blocks, supplier counts only. No names.
//  supplier: seller identity from the XML (name, IDs, VAT, address, contact), Rust supplier block, history counts,
//            invoice number and date, the matched open order (business-relationship evidence for S-9). No wallet address,
//            no line items.
// Every role also gets its own criteria (id, name, points, evidence) and agent_tasks (`research` → supplier).
import {buildInvestigatorInput,INVESTIGATOR_ROLES,MAX_INPUT_CHARS} from '../investigator/contract.mjs';

export const ROLE_TO_RUST_AGENT=Object.freeze({invoice:'invoice',wallet:'wallet',supplier:'research'});
const pick=(object,keys)=>object&&typeof object==='object'?Object.fromEntries(keys.filter(key=>object[key]!==undefined).map(key=>[key,object[key]])):null;

function criteriaFor(result,role){
 const agent=ROLE_TO_RUST_AGENT[role];
 return (Array.isArray(result.criteria)?result.criteria:[]).filter(criterion=>criterion?.agent===agent)
  .map(criterion=>({id:String(criterion.id),name:String(criterion.name??''),points:Number(criterion.points)||0,evidence:String(criterion.evidence??'').slice(0,500)}));
}

function tasksFor(result,role){
 return (result.agent_tasks?.[ROLE_TO_RUST_AGENT[role]]??[]).slice(0,50)
  .map(task=>({source:String(task.source).slice(0,64),task:String(task.task).slice(0,2000)}));
}

function historyView(history){
 if(!history||typeof history!=='object')return {available:false};
 return {available:true,...pick(history,['approved_count','median_eur','last_amounts','first_seen'])};
}

// Rust `invoice.open_order` (I-8/T-3 match from backend/data/open-orders.json): the backend is the single source of truth.
function openOrderView(invoice){
 const order=invoice?.open_order;
 if(!order||typeof order!=='object')return null;
 const view=pick(order,['order_id','supplier_vat_id','ordered_total','description']);
 if(typeof view.description==='string')view.description=view.description.slice(0,500);
 return view;
}

function dataFor(role,{result,fields,history,xmlStatus}){
 const summary=result.summary;
 const common={
  check:{band:summary.band,risk_score:summary.risk_score,checks_incomplete:summary.checks_incomplete??[]},
  criteria:criteriaFor(result,role),
  xml_fields_status:xmlStatus,
 };
 const invoice=result.invoice??{};
 if(role==='invoice')return {...common,
  invoice:{...pick(invoice,['invoice_number','type_code','profile','issue_date','due_date','total','due_payable','order_reference']),
   validation:pick(invoice.validation,['status','errors','error_rules'])},
  invoice_xml:fields?.invoice??null,
  supplier_history:historyView(history),
  open_order:openOrderView(invoice),
 };
 if(role==='wallet')return {...common,
  payment:{...pick(invoice.payment,['means_code','network','asset','address_type','credential_type']),
   recipient_address:fields?.wallet?.address??null,payment_information:fields?.wallet?.payment_information??null},
  wallet:pick(result.wallet,['known','approved','rejected_risk','trust','blocked','has_transactions','first_tx_at','age_days','chainabuse']),
  pair:pick(result.pair,['approved','rejected_risk']),
  supplier_counts:pick(result.supplier,['known','approved','first_invoice']),
 };
 return {...common,
  invoice:pick(invoice,['invoice_number','issue_date']),
  supplier_xml:fields?.supplier??null,
  supplier:pick(result.supplier,['country','vat_country','vat_valid','known','approved','trust','blocked','first_invoice']),
  supplier_history:historyView(history),
  open_order:openOrderView(invoice),
 };
}

// Shrinks optional bulk data until the serialized input fits MAX_INPUT_CHARS.
function shrink(data,level){
 if(level===0)return data;
 const copy=structuredClone(data);
 const xml=copy.invoice_xml;
 if(xml){
  if(level>=1&&Array.isArray(xml.line_items))xml.line_items=xml.line_items.slice(0,10);
  if(level>=2){delete xml.line_items;if(Array.isArray(xml.notes))xml.notes=xml.notes.slice(0,2);}
  if(level>=3){delete xml.notes;delete xml.payment_terms;}
 }
 if(level>=3)copy.criteria=copy.criteria.map(criterion=>({...criterion,evidence:criterion.evidence.slice(0,200)}));
 return copy;
}

/** Builds the {input, text} pair for one role (text = Sokosumi task description). */
export function buildRoleInput(role,{caseId,result,fields,history,xmlStatus='ok'}){
 const data=dataFor(role,{result,fields,history,xmlStatus});
 const tasks=tasksFor(result,role);
 let lastError;
 for(const level of [0,1,2,3]){
  try{
   const built=buildInvestigatorInput({case_id:caseId,role,tasks,data:shrink(data,level)});
   if(built.text.length<=MAX_INPUT_CHARS)return built;
  }catch(error){lastError=error;if(!/at most/.test(error.message))throw error;}
 }
 throw lastError??new Error('Investigator input is too large');
}

export function buildRoleInputs(context){
 return Object.fromEntries(INVESTIGATOR_ROLES.map(role=>[role,buildRoleInput(role,context)]));
}
