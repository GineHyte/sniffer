// Mock dependencies for the customer gateway (npm run customer -- --mock): no Main, no wallet, no payment, no backend.
// Every submitted XML becomes a scripted case whose status moves on with wall-clock time, in the shape of the Main case
// view (docs/openapi/main-api.yaml CaseView) and the backend CheckResult. The band follows the case ID:
// hex digit 6 of the case ID mod 3 → 0 low, 1 medium, 2 high. Tx hashes are fake (sha256 of a label), never on chain.
// A new intake while MOCK_MAX_UNCONFIRMED intakes are in their first INTAKE_CONFIRM_MS answers 503 too_many_unconfirmed_intakes,
// so the frontend queue's wait-and-retry path can be seen without paying.
import {createHash} from 'node:crypto';
import {HttpError} from './api.mjs';

export const INTAKE_CONFIRM_MS=1500;
export const MOCK_MAX_UNCONFIRMED=1;
export const PAY_DELAY_MS=1200;
const fakeHash=label=>createHash('sha256').update(`mock:${label}`).digest('hex');
const checkIdFor=caseId=>`chk_${caseId.slice(5,31).toUpperCase()}`;

export const scenarioFor=caseId=>['low','medium','high'][parseInt(caseId[11],16)%3];

const CRITERIA={
 low:{score:5,criteria:[{id:'I-7',name:'Zahlungsziel kürzer als üblich',points:5,evidence:'Fälligkeit 7 Tage nach Rechnungsdatum (Historie: 30 Tage)',agent:'invoice'}],
  reducers:[{id:'T-1',name:'Lieferant mit genehmigter Historie',points:-10,evidence:'3 genehmigte Rechnungen an dieselbe Wallet'}],decision:'approve'},
 medium:{score:42,criteria:[
  {id:'S-9',name:'Neuer Lieferant',points:12,evidence:'Keine frühere Rechnung zu dieser USt-ID',agent:'research'},
  {id:'W-3',name:'Junge Wallet',points:15,evidence:'Erste Transaktion vor 4 Tagen (Blockfrost)',agent:'wallet'},
  {id:'I-4',name:'Betrag knapp unter Freigabegrenze',points:15,evidence:'9.950,00 EUR bei Grenze 10.000,00 EUR',agent:'invoice'}],reducers:[],decision:'review'},
 high:{score:100,criteria:[
  {id:'KO-2',name:'Zahlungsadresse ungültig',points:100,evidence:'BT-84 ist keine Preprod-Adresse',agent:'wallet'},
  {id:'S-2',name:'USt-ID ungültig',points:35,evidence:'VIES: DE999999999 nicht gültig',agent:'research'}],reducers:[],decision:'decline'},
};

function investigators(caseId,age){
 const view={};
 for(const [i,role] of ['invoice','wallet','supplier'].entries()){
  const paid=age>=4500+i*300,reported=age>=9000+i*700;
  view[role]={sokosumi_task_id:`task_mock_${role}_${caseId.slice(5,13)}`,payment:paid?'paid':'paying',payment_tx_hash:paid?fakeHash(`${caseId}:${role}`):null,
   report:reported?'completed':null,verdict:reported?(role==='wallet'?'CONCERN':'CLEAR'):null};
 }
 return view;
}

/** Main case view of a mock case at `age` ms after its creation. */
export function mockCaseView(caseId,createdAt,now){
 const age=now-createdAt,band=scenarioFor(caseId),c=CRITERIA[band];
 const at=ms=>new Date(createdAt+ms).toISOString();
 const confirmed=age>=INTAKE_CONFIRM_MS;
 const view={case_id:caseId,status:'accepted',created_at:at(0),updated_at:at(0),check_id:null,
  intake:{tx_hash:fakeHash(`${caseId}:intake`),state:confirmed?'confirmed':'submitted',paid_at:at(0),confirmed_at:confirmed?at(INTAKE_CONFIRM_MS):null},
  band:null,risk_score:null,investigators:null,decision:null,payout:null,inspection:null};
 const step=(ms,patch)=>{if(age>=ms)Object.assign(view,patch,{updated_at:at(ms)});};
 step(INTAKE_CONFIRM_MS,{status:'initial_check'});
 step(3000,{check_id:checkIdFor(caseId),band,risk_score:c.score});
 const payout=state=>({phase:{authorized:'started',submitted:'submitted',confirmed:'done'}[state],state,payout_id:`pay_${caseId.slice(5,31).toUpperCase()}`,
  tx_hash:fakeHash(`${caseId}:payout`),code:null});
 const approved=by=>({decision:'PAY',final_decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[],decided_by:by});
 if(band==='high'){
  step(3000,{status:'completed',decision:{decision:'DONT_PAY',final_decision:'rejected',reason_type:'formal',block_wallet:false,
   decline_reasons:c.criteria.map(({id,name,evidence})=>({id,text:name,evidence})),decided_by:'initial_check'}});
 }else if(band==='low'){
  step(3000,{status:'payout',decision:approved('initial_check'),payout:payout('authorized')});
  step(4500,{status:'completed',payout:payout('submitted')});
  step(9000,{payout:payout('confirmed')});
 }else{
  if(age>=3000)view.status='investigating';
  if(age>=3000)view.investigators=investigators(caseId,age);
  step(11000,{status:'deciding'});
  step(12500,{status:'payout',decision:approved('agents'),payout:payout('authorized')});
  step(14000,{status:'completed',payout:payout('submitted')});
  step(19000,{payout:payout('confirmed')});
 }
 return view;
}

/** Backend CheckResult (only the fields the gateway projects) of a mock case. */
export function mockCheckResult(caseId,createdAt){
 const band=scenarioFor(caseId),c=CRITERIA[band];
 return {check_id:checkIdFor(caseId),checked_at:new Date(createdAt+3000).toISOString().replace(/\.\d+Z$/,'Z'),
  summary:{band,decision:c.decision,risk_score:c.score,ko_triggered:band==='high',checks_incomplete:band==='medium'?['CHAINABUSE_UNAVAILABLE']:[]},
  criteria:c.criteria,reducers:c.reducers};
}

export function createMockDeps({now=()=>Date.now(),sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms))}={}){
 const cases=new Map(); // case_id → createdAt (ms)
 const byCheck=new Map();
 return {
  main:{
   health:async()=>true,
   getCase:async caseId=>cases.has(caseId)?{status:200,body:mockCaseView(caseId,cases.get(caseId),now())}:{status:404,body:{error:'not_found'}},
  },
  pay:async(_xml,caseId)=>{
   if(cases.has(caseId))return {caseId,txHash:fakeHash(`${caseId}:intake`)};
   const unconfirmed=[...cases.values()].filter(created=>now()-created<INTAKE_CONFIRM_MS).length;
   if(unconfirmed>=MOCK_MAX_UNCONFIRMED)throw new HttpError(503,'too_many_unconfirmed_intakes');
   await sleep(PAY_DELAY_MS);
   const created=now();
   cases.set(caseId,created);byCheck.set(checkIdFor(caseId),caseId);
   return {caseId,txHash:fakeHash(`${caseId}:intake`)};
  },
  backend:{
   getCheck:async checkId=>{
    const caseId=byCheck.get(checkId);
    if(!caseId)throw Object.assign(new Error('unknown check'),{code:'not_found'});
    return {result:mockCheckResult(caseId,cases.get(caseId)),decision_state:null};
   },
  },
 };
}
