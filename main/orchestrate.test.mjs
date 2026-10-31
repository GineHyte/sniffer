import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {payOnce as realPayOnce} from '../x402/pay.mjs';
import {runCase,caseView} from './orchestrate.mjs';
import {loadCustomerTexts} from './decide.mjs';
import {mocks,tempStore,seedCase,testConfig,fakeClock,investigatorReport,ROLES,CHECK_ID,ADDR,checkResult} from './test-fixtures.mjs';

const customerTexts=loadCustomerTexts();

function deps(store,m,extra={}){
 return {config:testConfig(),store,backend:m.backend,sokosumi:m.sokosumi,payOnce:m.payOnce,payer:{fake:true},answerReport:m.answerReport,
  runPayout:m.runPayout,clock:fakeClock(),customerTexts,log:()=>{},...extra};
}

async function withCase(run){
 const temp=tempStore();
 try{await run(temp.store,seedCase(temp.store));}finally{temp.cleanup();}
}

// Simulates a process crash: from the matching journal write on, nothing more reaches disk and runCase rejects.
function crashOnce(store,predicate){
 let crashed=false;
 return {...store,write(state){if(crashed||predicate(state)){crashed=true;throw new Error('simulated crash');}return store.write(state);}};
}

test('high band → DONT_PAY from the initial check: no Sokosumi call, no payment, no decision POST, no payout',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({band:'high'});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed');
  assert.deepEqual([state.outcome.decision,state.outcome.final_decision,state.outcome.decided_by],['DONT_PAY','rejected','initial_check']);
  assert.equal(m.calls.creates.length+m.calls.gets,0);
  assert.equal(m.calls.payments.length,0);
  assert.equal(m.calls.decisions.length,0);
  assert.equal(m.calls.payouts.length,0);
  assert.equal(m.calls.llm,0);
  assert.equal(existsSync(store.xmlPath(caseId)),false,'raw XML is removed after the initial check');
 });
});

test('low band → no investigators, no LLM, payout runs once',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({band:'low'});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed');
  assert.equal(state.outcome.decision,'PAY');
  assert.equal(m.calls.creates.length+m.calls.gets+m.calls.payments.length+m.calls.llm,0);
  assert.equal(m.calls.decisions.length,0);
  assert.deepEqual(m.calls.payouts,[CHECK_ID]);
  assert.equal(state.steps.payout.state,'confirmed');
  assert.equal(caseView(state).payout.tx_hash,'cd'.repeat(32));
 });
});

test('medium happy path → 3 tasks, 3 payments, domain-scoped inputs, decision approved, payout',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  const d=deps(store,m);
  const state=await runCase(caseId,d);
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.deepEqual(m.calls.creates.map(entry=>entry.role),ROLES);
  assert.equal(m.calls.payments.length,3);
  for(const [index,role] of ROLES.entries()){
   const payment=m.calls.payments[index];
   assert.equal(payment.key,`${caseId}-${role}`);
   assert.equal(payment.url,`${d.config.investigators[role].url}/pay/${state.steps.investigation.tasks[role].task_id}`);
   assert.equal(payment.payTo,d.config.investigators[role].payTo);
   assert.equal(payment.maxLovelace,'2000000');
   assert.deepEqual(payment.init,{method:'POST'});
  }
  assert.deepEqual(m.calls.decisions,[{check_id:CHECK_ID,decision:'approved',reason_type:null,block_wallet:false,decline_reasons:[]}]);
  assert.deepEqual(m.calls.payouts,[CHECK_ID]);
  assert.equal(m.calls.llm,1);
  assert.deepEqual(state.outcome.decision,'PAY');

  const inputs=Object.fromEntries(m.calls.creates.map(entry=>[entry.role,JSON.parse(entry.description)]));
  assert.equal(inputs.wallet.task_id,`${caseId}-wallet`);
  assert.deepEqual(inputs.invoice.tasks.map(task=>task.source),['I-5','I-7']);
  assert.deepEqual(inputs.supplier.tasks.map(task=>task.source),['VIES_UNAVAILABLE'],'research tasks go to the supplier role');
  assert.match(inputs.wallet.data.payment.recipient_address,/^addr_test1/);
  assert.equal(inputs.supplier.data.supplier_xml.name,'Alpha Consulting GmbH');
  assert.equal(inputs.supplier.data.supplier_xml.vat_id,'DE111111111');
  assert.equal(inputs.invoice.data.invoice_xml.line_items[0].name,'Beratungsleistung Oktober');
  assert.equal(inputs.invoice.data.supplier_history.median_eur,'1145.00');
  // domain scoping: no supplier identity for wallet/invoice, no wallet address for supplier/invoice
  assert.doesNotMatch(JSON.stringify(inputs.wallet),/Alpha Consulting|DE111111111/);
  assert.doesNotMatch(JSON.stringify(inputs.invoice),/Alpha Consulting|addr_test1/);
  assert.doesNotMatch(JSON.stringify(inputs.supplier),/addr_test1|Beratungsleistung/);
  assert.deepEqual(inputs.wallet.data.criteria.map(c=>c.id),['S-3','W-2']);
 });
});

test('medium: one investigator never completes → timeout → rejected/formal, no payout',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({reports:{wallet:null}});
  const d=deps(store,m);
  const state=await runCase(caseId,d);
  assert.equal(state.status,'completed');
  assert.equal(state.steps.investigation.reports.wallet.status,'timeout');
  assert.equal(m.calls.decisions.length,1);
  const [body]=m.calls.decisions;
  assert.deepEqual([body.decision,body.reason_type,body.block_wallet],['rejected','formal',false]);
  assert.ok(body.decline_reasons.length>=1);
  assert.equal(m.calls.payouts.length,0);
  assert.ok(d.clock.t-Date.parse('2026-10-31T10:00:00Z')>=60_000,'waited for the full timeout');
 });
});

test('medium: a report with a foreign task_id or case_id counts as missing → rejected/formal',async()=>{
 for(const forged of [{task_id:'case-ffffffffffffffffffffffffffffffff-invoice'},{case_id:'case-ffffffffffffffffffffffffffffffff'}]){
  await withCase(async(store,caseId)=>{
   const m=mocks({reports:{invoice:input=>JSON.stringify(investigatorReport('invoice',input.case_id,forged))}});
   const state=await runCase(caseId,deps(store,m));
   assert.equal(state.steps.investigation.reports.invoice.valid,false);
   assert.equal(state.steps.investigation.reports.invoice.status,'invalid');
   assert.deepEqual([m.calls.decisions[0].decision,m.calls.decisions[0].reason_type],['rejected','formal']);
   assert.equal(m.calls.payouts.length,0);
  });
 }
});

test('medium: CRITICAL wallet with critical_issue → rejected/risk with block_wallet, no payout',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({reports:{wallet:input=>JSON.stringify(investigatorReport('wallet',input.case_id,{verdict:'CRITICAL',critical_issue:true}))}});
  const state=await runCase(caseId,deps(store,m));
  assert.deepEqual([m.calls.decisions[0].decision,m.calls.decisions[0].reason_type,m.calls.decisions[0].block_wallet],['rejected','risk',true]);
  assert.equal(state.outcome.decision,'DONT_PAY');
  assert.equal(m.calls.payouts.length,0);
 });
});

test('medium: Main LLM failure fails closed → rejected/formal',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({llm:new Error('Model output invalid after repair')});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.steps.main_llm.ok,false);
  assert.deepEqual([m.calls.decisions[0].decision,m.calls.decisions[0].reason_type,m.calls.decisions[0].block_wallet],['rejected','formal',false]);
  assert.equal(m.calls.payouts.length,0);
 });
});

test('restart after a crash between task creation and payment → no duplicate task or payment',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  const crashing=crashOnce(store,state=>state.steps.investigation?.payments?.invoice?.phase==='paying');
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(m.calls.creates.length,3);
  assert.equal(m.calls.payments.length,0);
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.equal(m.calls.creates.length,3,'no task is created twice');
  assert.equal(m.calls.payments.length,3,'each investigator is paid once');
  assert.equal(m.calls.decisions.length,1);
  assert.equal(m.calls.payouts.length,1);
 });
});

test('restart after a crash right after a payment settled → payOnce journal returns it, nothing is signed again',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  const crashing=crashOnce(store,state=>state.steps.investigation?.payments?.supplier?.phase==='paid');
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(m.calls.payments.length,3);
  const signer={getAddress:()=>ADDR('p'),buildAndSignPaymentTransaction:async()=>{throw new Error('must not sign again');}};
  const state=await runCase(caseId,deps(store,m,{payOnce:realPayOnce,payer:signer}));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.equal(state.steps.investigation.payments.supplier.phase,'paid');
  assert.equal(m.calls.payments.length,3);
  assert.equal(m.calls.creates.length,3);
 });
});

test('restart after a crash during task creation → read-only check adopts the created task, no second create',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  const crashing=crashOnce(store,state=>state.steps.investigation?.tasks?.wallet?.phase==='created');
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(m.calls.creates.length,2);
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.equal(m.calls.lists.length,1);
  assert.equal(state.steps.investigation.tasks.wallet.task_id,m.calls.creates[1].id);
  assert.equal(state.steps.investigation.tasks.wallet.found_by_check,true);
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet','supplier'],'wallet is never created twice');
  assert.equal(m.calls.payments.length,3);
 });
});

test('Q1: create fails after the task was created → exactly one match is adopted and the case continues',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({createPlan:{wallet:['fail_after']}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  const wallet=state.steps.investigation.tasks.wallet;
  assert.equal(wallet.attempts.length,1);
  assert.match(wallet.attempts[0].error,/timed out/);
  assert.deepEqual([wallet.attempts[0].check.outcome,wallet.attempts[0].check.task_id],['found',wallet.task_id]);
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet','supplier']);
  assert.deepEqual(m.calls.lists[0].slice(0,6),['tasks','list','--coworker-id','cw-wallet','--limit','100']);
  assert.equal(m.calls.payments.length,3);
 });
});

test('Q1: create fails and the check proves no task exists → marked not_sent and created again',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({createPlan:{supplier:['fail_before']}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  const supplier=state.steps.investigation.tasks.supplier;
  assert.deepEqual(supplier.attempts.map(entry=>entry.check?.outcome??null),['none',null]);
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet','supplier','supplier']);
  assert.equal(m.calls.creates.length,3);
  assert.equal(m.calls.payments.length,3);
 });
});

test('Q1: three attempts that each prove nothing was created → stop for inspection, no fourth create',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({createPlan:{invoice:['fail_before','fail_before','fail_before','ok']}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'sokosumi_create_attempts_exhausted');
  assert.deepEqual(m.calls.createAttempts,['invoice','invoice','invoice']);
  assert.equal(state.steps.investigation.tasks.invoice.attempts.length,3);
  assert.equal(m.calls.payments.length,0);
 });
});

test('Q1: an ambiguous check (two matches) or a failing list call stops for inspection without recreating',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({createPlan:{wallet:['fail_after']},list:(args,all)=>({tasks:[...all,...all].filter(task=>task.role==='wallet').map(task=>({...task,status:'READY'}))})});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'sokosumi_create_unknown');
  assert.equal(state.steps.investigation.tasks.wallet.attempts[0].check.reason,'multiple_matches');
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet']);
  assert.equal(m.calls.payments.length,0);
 });
 await withCase(async(store,caseId)=>{
  const m=mocks({createPlan:{wallet:['fail_before']},list:()=>{throw new Error('Sokosumi CLI returned non-JSON output');}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.steps.investigation.tasks.wallet.attempts[0].check.outcome,'check_failed');
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet']);
  // a stopped case is never resumed
  await runCase(caseId,deps(store,m));
  assert.deepEqual(m.calls.createAttempts,['invoice','wallet']);
 });
});

const connectFailed=()=>Object.assign(new Error('Backend initial-check request failed (connection not established).'),{status:0,code:'connect_failed'});

test('Q2: connect_failed → initial check resent with backoff, then the case continues',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({band:'low'});
  const ok=m.backend.initialCheck;
  m.backend.initialCheck=async xml=>{if(m.calls.initialCheck<2){m.calls.initialCheck+=1;throw connectFailed();}return ok(xml);};
  const d=deps(store,m);
  const state=await runCase(caseId,d);
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.equal(m.calls.initialCheck,3);
  assert.deepEqual(d.clock.delays.slice(0,2),[2000,4000]);
  assert.deepEqual(state.steps.initial_check.attempts.map(entry=>entry.outcome??null),['connect_failed','connect_failed',null]);
  assert.equal(m.calls.payouts.length,1);
 });
});

test('Q2: connect_failed on every attempt → 1 send + 3 resends, then the case fails (nothing was sent)',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  m.backend.initialCheck=async()=>{m.calls.initialCheck+=1;throw connectFailed();};
  const d=deps(store,m);
  const state=await runCase(caseId,d);
  assert.equal(state.status,'failed');
  assert.equal(state.inspection.code,'initial_check_unreachable');
  assert.equal(m.calls.initialCheck,4);
  assert.deepEqual(d.clock.delays,[2000,4000,8000]);
  assert.deepEqual(state.steps.initial_check.attempts.map(entry=>entry.outcome),['connect_failed','connect_failed','connect_failed','connect_failed']);
 });
});

test('Q2: timeout, reset, 5xx or an unparsable result are never resent → inspection after one send',async()=>{
 for(const failure of [{status:0,code:'network_error'},{status:503,code:'dependency_unavailable'},{status:502,code:'http_error'},{status:200,code:'invalid_response'},{}]){
  await withCase(async(store,caseId)=>{
   const m=mocks();
   m.backend.initialCheck=async()=>{m.calls.initialCheck+=1;throw Object.assign(new Error('x'),failure);};
   const state=await runCase(caseId,deps(store,m));
   assert.equal(state.status,'needs_inspection',JSON.stringify(failure));
   assert.equal(state.inspection.code,'initial_check_unknown');
   assert.equal(m.calls.initialCheck,1);
   const again=await runCase(caseId,deps(store,m));
   assert.equal(again.status,'needs_inspection');
   assert.equal(m.calls.initialCheck,1);
  });
 }
});

test('Q2: restart after a crash during the resend backoff continues from the journaled not_sent attempt',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({band:'high'});
  const ok=m.backend.initialCheck;
  m.backend.initialCheck=async()=>{m.calls.initialCheck+=1;throw connectFailed();};
  const crashing=crashOnce(store,state=>state.steps.initial_check?.attempts?.length===2);
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(store.read(caseId).steps.initial_check.phase,'not_sent');
  m.backend.initialCheck=ok;
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed',JSON.stringify(state.inspection));
  assert.equal(m.calls.initialCheck,2);
 });
});

test('an unknown investigator payment stops the case for inspection: no LLM, no decision, no payout',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({payFails:{wallet:'unknown'}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'investigator_payment_unknown');
  assert.equal(m.calls.payments.length,2);
  assert.equal(m.calls.llm+m.calls.decisions.length+m.calls.payouts.length,0);
  const again=await runCase(caseId,deps(store,m));
  assert.equal(again.status,'needs_inspection');
  assert.equal(m.calls.payments.length,2,'a stopped case is not resumed');
 });
});

test('a payment that failed before signing leaves that investigator unpaid → rejected/formal',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({payFails:{supplier:'failed_before_signing'}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.steps.investigation.reports.supplier.status,'unpaid');
  assert.deepEqual([m.calls.decisions[0].decision,m.calls.decisions[0].reason_type],['rejected','formal']);
  assert.equal(m.calls.payouts.length,0);
 });
});

test('restart with a journaled decision POST is verified by a read, never resent',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  const crashing=crashOnce(store,state=>state.steps.decision?.phase==='posted');
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(m.calls.decisions.length,1);
  const body=m.calls.decisions[0];
  m.backend.getCheck=async()=>({result:checkResult('medium'),decision_state:{final_decision:body.decision,final_reason_type:body.reason_type,final_block_wallet:body.block_wallet,decided_by:'agents'}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed');
  assert.equal(m.calls.decisions.length,1,'decision not resent');
  assert.equal(m.calls.payouts.length,1);
 });
});

test('restart with a started payout → needs_inspection, payout never restarted',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks({band:'low'});
  const crashing=crashOnce(store,state=>state.steps.payout?.phase==='done');
  await assert.rejects(runCase(caseId,deps(crashing,m)),/simulated crash/);
  assert.equal(m.calls.payouts.length,1);
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'payout_unknown');
  assert.equal(m.calls.payouts.length,1);
 });
});

test('a payout policy refusal ends the case without retry; a manual payout error needs inspection',async()=>{
 await withCase(async(store,caseId)=>{
  const refused=Object.assign(new Error('Payout authorization refused: over_invoice_cap (HTTP 409).'),{code:'over_invoice_cap',status:409,payoutId:null});
  const m=mocks({band:'low',payout:async()=>{throw refused;}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'completed');
  assert.deepEqual([state.steps.payout.phase,state.steps.payout.code],['refused','over_invoice_cap']);
 });
 await withCase(async(store,caseId)=>{
  const manual=Object.assign(new Error('MANUAL INSPECTION REQUIRED'),{code:'submit_failed',payoutId:'pay_01JBX7ZQ8V3K6M2N4P5R7S9T0X',manual:true});
  const m=mocks({band:'low',payout:async()=>{throw manual;}});
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'payout_submit_failed');
 });
});

test('an initial check refused by the backend fails the case; an unknown outcome is never resent',async()=>{
 await withCase(async(store,caseId)=>{
  const m=mocks();
  m.backend.initialCheck=async()=>{m.calls.initialCheck+=1;throw Object.assign(new Error('x'),{status:413,code:'xml_too_large'});};
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'failed');
  assert.equal(state.inspection.code,'initial_check_refused:xml_too_large');
 });
 await withCase(async(store,caseId)=>{
  const m=mocks();
  m.backend.initialCheck=async()=>{m.calls.initialCheck+=1;throw Object.assign(new Error('timeout'),{status:0,code:'network_error'});};
  const state=await runCase(caseId,deps(store,m));
  assert.equal(state.status,'needs_inspection');
  assert.equal(state.inspection.code,'initial_check_unknown');
  assert.equal(m.calls.initialCheck,1);
 });
});
