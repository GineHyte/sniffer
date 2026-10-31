import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,assertConfirmed,prepareXml,duePayableCents,payoutLovelace,caseIdFromJournal,pollCase,progressLine,payKeyFor,
 follow,formatElapsed,trackMilestones,timingLines,failureMessage,intakeRefusal,payoutUnconfirmed,DEFAULT_CONFIRM_WAIT_MS,
 normalizeVat,supplierHash,sellerVat,validMockVats,openOrderFor,supplierRewrite,pickFreshSupplier,resolveSupplier,expectedOutcome,supplierLines,
 supplierLookups,readRepoJson,VIES_MOCK_FILE,OPEN_ORDERS_FILE,CONFIRM_FLAG,DEFAULT_FIXTURE,DEFAULT_TIMEOUT_MS,DEFAULT_POLL_MS,
 freshWalletName,resolveRecipient} from './demo-case.mjs';
import {intakeIds} from '../main/case-store.mjs';
import {PAY_KEY_REGEX} from '../x402/pay.mjs';

const SCRIPT=fileURLToPath(new URL('./demo-case.mjs',import.meta.url));
const F1=readFileSync(fileURLToPath(new URL('../docs/fixtures/f1.xml',import.meta.url)),'utf8');
const CASE='case-'+'a'.repeat(32);
const ADDR='addr_test1qqsukwn3txs33kx4qh97g5suejsc6w78x994j7y6sefsk29vnt2urqy4t5rmhddtmprmhpfuueuupmd7kaez7ganq3xs5usuqq';

test('parseArgs: defaults, every option, and invalid input',()=>{
 const defaults=parseArgs([]);
 assert.deepEqual(defaults,{confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:'payer',
  mainUrl:'http://127.0.0.1:21951',timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null,newSupplier:false,supplierVat:null,supplierName:null,waitConfirm:true,freshWallet:false});
 assert.equal(DEFAULT_POLL_MS,2000);
 assert.equal(parseArgs(['--no-wait-confirm']).waitConfirm,false);
 assert.equal(parseArgs([],{MAIN_PORT:'22000'}).mainUrl,'http://127.0.0.1:22000');
 const all=parseArgs([CONFIRM_FLAG,'--fixture','docs/fixtures/f11.xml','--invoice-number','RE-2026-0413','--recipient-wallet','payee','--wallet','payer2',
  '--main-url','http://localhost:1234/','--timeout-ms','60000','--poll-ms','500','--case',CASE,'--supplier-vat','DE222222222','--supplier-name','Müller & Söhne GmbH']);
 assert.deepEqual(all,{confirm:true,help:false,fixture:'docs/fixtures/f11.xml',invoiceNumber:'RE-2026-0413',recipientWallet:'payee',wallet:'payer2',
  mainUrl:'http://localhost:1234',timeoutMs:60000,pollMs:500,caseId:CASE,newSupplier:false,supplierVat:'DE222222222',supplierName:'Müller & Söhne GmbH',waitConfirm:true,freshWallet:false});
 assert.equal(parseArgs(['--new-supplier','--supplier-name','Beta GmbH']).newSupplier,true);
 assert.equal(parseArgs(['-h']).help,true);
 for(const [argv,reason] of [[['--bogus'],/Unknown argument/],[['--fixture'],/needs a value/],[['--fixture','--poll-ms'],/needs a value/],
  [['--timeout-ms','0'],/timeout-ms/],[['--poll-ms','1.5'],/poll-ms/],[['--case','case-123'],/--case/],[['--invoice-number','a b'],/invoice-number/],
  [['--wallet','Payer'],/--wallet/],[['--recipient-wallet','../x'],/recipient-wallet/],[['--main-url','ftp://x'],/main-url/],
  [['--supplier-vat','de222222222'],/supplier-vat/],[['--supplier-vat','D1'],/supplier-vat/],[['--supplier-name','<x>'],/supplier-name/],
  [['--supplier-name','a'.repeat(101)],/supplier-name/],[['--new-supplier','--supplier-vat','DE222222222'],/either --new-supplier or --supplier-vat/],
  [['--fresh-wallet','--recipient-wallet','payee'],/either --fresh-wallet or --recipient-wallet/]]){
  assert.throws(()=>parseArgs(argv),reason,argv.join(' '));
 }
});

test('assertConfirmed: the pay path needs the flag, following a case does not',()=>{
 assert.throws(()=>assertConfirmed(parseArgs([])),error=>/Refusing to run/.test(error.message)&&error.message.includes(CONFIRM_FLAG));
 assert.doesNotThrow(()=>assertConfirmed(parseArgs([CONFIRM_FLAG])));
 assert.doesNotThrow(()=>assertConfirmed(parseArgs(['--case',CASE])));
});

test('CLI refuses without the flag before touching wallets, journals or the network',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sniffer-demo-'));
 try{
  // Unreachable Main and empty Blockfrost key: if a guard ever failed, nothing could be paid.
  const env={...process.env,DEMO_STATE_DIR:join(dir,'demo'),X402_STATE_DIR:join(dir,'x402'),BLOCKFROST_API_KEY_PREPROD:'',MAIN_PORT:'1'};
  const result=spawnSync(process.execPath,[SCRIPT,'--fixture',DEFAULT_FIXTURE],{encoding:'utf8',env});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Refusing to run/);
  assert.match(result.stderr,new RegExp(CONFIRM_FLAG));
  assert.equal(result.stdout,'');
  assert.deepEqual(readdirSync(dir),[]);
  const usage=spawnSync(process.execPath,[SCRIPT,'--nope'],{encoding:'utf8',env});
  assert.equal(usage.status,1);assert.match(usage.stderr,/Unknown argument/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('prepareXml keeps the fixture unless asked, and rewrites invoice number and payment address',()=>{
 assert.equal(prepareXml(F1),F1);
 const renamed=prepareXml(F1,{invoiceNumber:'RE-2026-0413'});
 assert.equal((renamed.match(/RE-2026-0413/g)??[]).length,2);
 assert.ok(!renamed.includes('RE-2026-0412'));
 assert.ok(renamed.includes('<ram:ID>RE-2026-0413</ram:ID>')&&renamed.includes('<ram:PaymentReference>RE-2026-0413</ram:PaymentReference>'));
 assert.notEqual(intakeIds(renamed).caseId,intakeIds(F1).caseId);
 const repaid=prepareXml(F1,{recipientAddress:ADDR});
 assert.ok(repaid.includes(`<ram:ProprietaryID>${ADDR}</ram:ProprietaryID>`));
 assert.equal(repaid.replace(ADDR,'X'),F1.replace(/addr_test1qqg3[0-9a-z]+/,'X'));
 assert.throws(()=>prepareXml('<x/>'),/not a CII invoice/);
 assert.throws(()=>prepareXml(F1,{invoiceNumber:'bad number'}),/Invalid invoice number/);
 assert.throws(()=>prepareXml(F1,{recipientAddress:'addr1mainnet'}),/Preprod/);
});

test('payout amount follows the backend formula floor(EUR * ADA_PER_EUR * 1e6)',()=>{
 assert.equal(duePayableCents(F1),119000n);
 assert.equal(payoutLovelace(119000n,'0.001'),1_190_000n);
 assert.equal(payoutLovelace(119000n,'0.04'),47_600_000n);
 assert.equal(payoutLovelace(119001n,'0.033333'),39_666_603n);
 assert.equal(payoutLovelace(null,'0.001'),null);
 assert.equal(payoutLovelace(119000n,'abc'),null);
 assert.equal(duePayableCents('<x/>'),null);
});

test('case id comes from the 202 body in the payOnce journal; the pay key is a valid payOnce key',()=>{
 assert.equal(caseIdFromJournal({response:{status:202,body:JSON.stringify({case_id:CASE,status:'accepted'})}}),CASE);
 assert.equal(caseIdFromJournal({response:{body:'not json'}}),null);
 assert.equal(caseIdFromJournal({response:{body:JSON.stringify({case_id:'../etc'})}}),null);
 assert.equal(caseIdFromJournal(null),null);
 assert.match(payKeyFor(intakeIds(F1).caseId),PAY_KEY_REGEX);
});

const fakeClock=()=>{let t=0;return {now:()=>t,sleep:async ms=>{t+=ms;},get t(){return t;}};};

test('pollCase stops at the first terminal status and reports every view',async()=>{
 const statuses=['accepted','initial_check','investigating','deciding','payout','completed','never'];
 let calls=0;const seen=[];
 const clock=fakeClock();
 const result=await pollCase({caseId:CASE,timeoutMs:600_000,pollMs:1000,clock,onUpdate:event=>seen.push(event.view?.status),
  fetchCase:async id=>{assert.equal(id,CASE);return {status:200,body:{case_id:id,status:statuses[calls++]}};}});
 assert.deepEqual(result,{done:true,view:{case_id:CASE,status:'completed'},timedOut:false,confirmTimedOut:false});
 assert.equal(calls,6);assert.equal(clock.t,5000);
 assert.deepEqual(seen,statuses.slice(0,6));
 for(const status of ['failed','needs_inspection']){
  const once=await pollCase({caseId:CASE,timeoutMs:1000,pollMs:10,clock:fakeClock(),fetchCase:async()=>({status:200,body:{status}})});
  assert.equal(once.done,true);assert.equal(once.view.status,status);
 }
});

test('pollCase retries transient errors, times out at the deadline, and stops on 404',async()=>{
 const clock=fakeClock();let calls=0;const errors=[];
 const result=await pollCase({caseId:CASE,timeoutMs:10_000,pollMs:3000,clock,onUpdate:event=>event.type==='error'&&errors.push(event.status),
  fetchCase:async()=>{calls++;if(calls===1)throw new Error('ECONNREFUSED');if(calls===2)return {status:503,body:null};return {status:200,body:{status:'investigating'}};}});
 assert.equal(result.timedOut,true);assert.equal(result.done,false);assert.equal(result.view.status,'investigating');
 assert.deepEqual(errors,[0,503]);
 assert.equal(clock.t,10_000); // never sleeps past the deadline
 assert.equal(calls,5);
 await assert.rejects(pollCase({caseId:CASE,timeoutMs:1000,pollMs:10,clock:fakeClock(),fetchCase:async()=>({status:404,body:{error:'not_found'}})}),/not found/);
});

const TX='ab'.repeat(32);
const view=(status,extra={})=>({case_id:CASE,status,intake:{tx_hash:TX,state:'submitted',paid_at:'2026-10-31T10:00:00.000Z',confirmed_at:null},decision:null,payout:null,inspection:null,...extra});
const approved={decision:'PAY',final_decision:'approved',decided_by:'initial_check'};
const intakeOk={tx_hash:TX,state:'confirmed',paid_at:'2026-10-31T10:00:00.000Z',confirmed_at:'2026-10-31T10:00:21.400Z'};
const scripted=(views,clock,{each=()=>{}}={})=>{let i=0;return async()=>{each(clock.t);return {status:200,body:views[Math.min(i++,views.length-1)]};};};

test('pollCase keeps polling a completed case until its submitted payout is confirmed',async()=>{
 const clock=fakeClock();const seen=[];
 const views=[view('initial_check'),view('payout',{intake:intakeOk,decision:approved,payout:{phase:'started',state:null}}),
  view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'submitted',tx_hash:TX}}),
  view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'submitted',tx_hash:TX}}),
  view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'confirmed',tx_hash:TX}})];
 const result=await pollCase({caseId:CASE,timeoutMs:600_000,pollMs:2000,clock,fetchCase:scripted(views,clock),onUpdate:event=>seen.push(event.view.payout?.state??null)});
 assert.deepEqual([result.done,result.timedOut,result.confirmTimedOut,result.view.payout.state],[true,false,false,'confirmed']);
 assert.deepEqual(seen,[null,null,'submitted','submitted','confirmed']);
 assert.equal(clock.t,8000);
 // Without waitConfirm the first completed view ends the loop.
 const quick=await pollCase({caseId:CASE,timeoutMs:600_000,pollMs:2000,clock:fakeClock(),fetchCase:scripted(views,fakeClock()),waitConfirm:false});
 assert.equal(quick.view.payout.state,'submitted');assert.equal(quick.confirmTimedOut,false);
 assert.ok(payoutUnconfirmed(quick.view));assert.ok(!payoutUnconfirmed(result.view));
});

test('pollCase bounds the confirmation wait separately from the case timeout',async()=>{
 const clock=fakeClock();let calls=0;
 const stuck=view('completed',{decision:approved,payout:{phase:'done',state:'submitted'}});
 const result=await pollCase({caseId:CASE,timeoutMs:1000,pollMs:2000,clock,confirmWaitMs:5000,
  fetchCase:async()=>{calls++;if(calls===2)return {status:503,body:null};return {status:200,body:stuck};}});
 assert.deepEqual([result.done,result.timedOut,result.confirmTimedOut],[true,false,true]);
 assert.equal(result.view,stuck);
 assert.equal(clock.t,5000); // case timeout 1 s no longer applies once completed; never sleeps past the confirm deadline
 assert.equal(calls,4);
 assert.equal(DEFAULT_CONFIRM_WAIT_MS,180_000);
});

test('formatElapsed, milestones and the timing summary',()=>{
 assert.deepEqual([0,1234,59_999,60_000,65_400,754_000,-5].map(formatElapsed),['0.0s','1.2s','59.9s','1m00s','1m05s','12m34s','0.0s']);
 const marks={intakePaid:4100};
 trackMilestones(marks,view('initial_check'),6000);
 assert.deepEqual(marks,{intakePaid:4100});
 trackMilestones(marks,view('deciding',{intake:intakeOk}),25_300);
 trackMilestones(marks,view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'submitted'}}),38_000);
 trackMilestones(marks,view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'confirmed'}}),62_500);
 trackMilestones(marks,view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'confirmed'}}),70_000);
 assert.deepEqual(marks,{intakePaid:4100,intakeConfirmed:25_300,decision:38_000,payoutSubmitted:38_000,payoutConfirmed:62_500});
 assert.deepEqual(timingLines(marks,view('completed',{intake:intakeOk})),[
  'Timing (first seen by this run, since the demo started):',
  '  intake paid (202 received)  +4.1s',
  '  intake confirmed            +25.3s',
  '  decision reached            +38.0s',
  '  payout submitted            +38.0s',
  '  payout confirmed            +1m02s',
  '  intake paid -> confirmed (Main clock): 21.4s']);
 // A confirmed payout seen first also marks it submitted; nothing seen, nothing printed.
 assert.deepEqual(trackMilestones({},view('completed',{payout:{state:'confirmed'}}),9000),{payoutSubmitted:9000,payoutConfirmed:9000});
 assert.deepEqual(timingLines({}),[]);
 assert.deepEqual(timingLines({decision:1000},null),['Timing (first seen by this run, since the demo started):','  decision reached  +1.0s']);
});

const followRun=async(views,{options={},confirmWaitMs}={})=>{
 const clock=fakeClock();const lines=[];const marks={intakePaid:4000}; // the demo started 5 s before polling, 202 after 4 s
 const opts={mainUrl:'http://main',timeoutMs:600_000,pollMs:2000,waitConfirm:true,...options};
 let result,error;
 try{result=await follow(opts,CASE,{fetchCase:scripted(views,clock),clock,started:-5000,marks,print:line=>lines.push(line),...(confirmWaitMs?{confirmWaitMs}:{})});}catch(e){error=e;}
 return {lines,result,error,marks,clock};
};

test('follow prints "approved, payout submitted", waits for the confirmation and ends with the timing summary',async()=>{
 const submitted=view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'submitted',tx_hash:TX}});
 const {lines,error}=await followRun([view('initial_check'),submitted,submitted,{...submitted,payout:{...submitted.payout,state:'confirmed'}}]);
 assert.equal(error,undefined);
 assert.match(lines.find(l=>l.includes('status=initial_check')),/^\[\d\d:\d\d:\d\d \+5\.0s\] status=initial_check intake=submitted$/);
 assert.match(lines.find(l=>l.includes('approved, payout submitted')),/^\[[0-9:]+ \+7\.0s\] approved, payout submitted \(waiting up to 3m00s for its confirmation\)$/);
 assert.match(lines.find(l=>l.endsWith('payout confirmed')),/^\[[0-9:]+ \+11\.0s\] payout confirmed$/);
 assert.ok(lines.includes(`Intake payment: https://preprod.cardanoscan.io/transaction/${TX}`));
 assert.ok(lines.includes('Decision: PAY (approved, decided by initial_check)'));
 const t=lines.indexOf('Timing (first seen by this run, since the demo started):');
 assert.ok(t>lines.indexOf('Decision: PAY (approved, decided by initial_check)'));
 assert.deepEqual(lines.slice(t+1),['  intake paid (202 received)  +4.0s','  intake confirmed            +7.0s','  decision reached            +7.0s','  payout submitted            +7.0s',
  '  payout confirmed            +11.0s','  intake paid -> confirmed (Main clock): 21.4s']);
});

test('follow --no-wait-confirm stops at the submitted payout; a confirmation timeout still exits 0 with a warning',async()=>{
 const submitted=view('completed',{intake:intakeOk,decision:approved,payout:{phase:'done',state:'submitted'}});
 const confirmed={...submitted,payout:{phase:'done',state:'confirmed'}};
 const quick=await followRun([submitted,confirmed],{options:{waitConfirm:false}});
 assert.equal(quick.error,undefined);assert.equal(quick.clock.t,0);
 assert.match(quick.lines.find(l=>l.includes('approved, payout submitted')),/\] approved, payout submitted$/);
 assert.ok(quick.lines.some(l=>l.startsWith('Payout submitted; not waiting for its confirmation (--no-wait-confirm)')));
 assert.ok(!quick.lines.some(l=>l.endsWith('payout confirmed')));
 const slow=await followRun([submitted],{confirmWaitMs:4000});
 assert.equal(slow.error,undefined);assert.equal(slow.result.confirmTimedOut,true);assert.equal(slow.clock.t,4000);
 assert.ok(slow.lines.some(l=>l.startsWith('Warning: the supplier payout is still submitted, not confirmed, after 4.0s.')));
 assert.deepEqual(slow.lines.slice(-2),['  payout submitted            +5.0s','  intake paid -> confirmed (Main clock): 21.4s']);
});

test('follow fails with a clear message for the intake stop codes and still prints the timing',async()=>{
 const notConfirmed=await followRun([view('failed',{intake:{...intakeOk,state:'failed',confirmed_at:null},inspection:{code:'intake_not_confirmed'}})]);
 assert.match(notConfirmed.error.message,/ended with status failed \(intake_not_confirmed\): the intake payment failed on chain, so Main paid no investigator and no supplier\. Intake: https:\/\/preprod\.cardanoscan\.io\/transaction\/(ab){32}\. Inspect /);
 assert.equal(notConfirmed.lines.at(-1),'  intake paid (202 received)  +4.0s');
 const unknown=await followRun([view('needs_inspection',{inspection:{code:'intake_unconfirmed'}})]);
 assert.match(unknown.error.message,/needs_inspection \(intake_unconfirmed\): the intake payment was not confirmed in time; Main paid no investigator and no supplier\. Check the intake transaction before any retry\. Intake: /);
 assert.equal(failureMessage(CASE,{status:'failed',inspection:{code:'initial_check_unreachable'}}),`Case ${CASE} ended with status failed (initial_check_unreachable). Inspect .local/main/cases/${CASE}/case.json.`);
 // A payout confirmation that fails in the background turns the completed case into needs_inspection: non-zero exit.
 const submitted=view('completed',{intake:intakeOk,decision:approved,payout:{phase:'submitted',state:'submitted'}});
 const flipped=await followRun([submitted,{...submitted,status:'needs_inspection',payout:{phase:'error',state:'unknown'},inspection:{code:'payout_invalid_response'}}]);
 assert.match(flipped.error.message,/ended with status needs_inspection \(payout_invalid_response\)\. Inspect /);
 assert.ok(flipped.lines.some(l=>l.includes('approved, payout submitted')));
 const timeout=await followRun([view('investigating')],{options:{timeoutMs:4000}});
 assert.match(timeout.error.message,/not finished after 4000 ms/);
});

test('intakeRefusal explains the 503 cap only for a refusal before signing',()=>{
 const refused={phase:'failed_before_signing',response:{status:503,body:JSON.stringify({error:'too_many_unconfirmed_intakes'})}};
 assert.match(intakeRefusal(refused),/^Main refused the intake with HTTP 503 too_many_unconfirmed_intakes: .*MAX_UNCONFIRMED_INTAKES, default 5\)\. No payment was signed\./);
 assert.equal(intakeRefusal({...refused,phase:'unknown'}),null);
 assert.equal(intakeRefusal({...refused,response:{status:503,body:'{"error":"other"}'}}),null);
 assert.equal(intakeRefusal({...refused,response:{status:500,body:refused.response.body}}),null);
 assert.equal(intakeRefusal({...refused,response:{status:503,body:'oops'}}),null);
 assert.equal(intakeRefusal(null),null);
});

test('progressLine summarizes the public case view',()=>{
 assert.equal(progressLine(view('payout',{band:'low',risk_score:0})),'status=payout intake=submitted band=low score=0');
 assert.equal(progressLine({status:'accepted',band:null,risk_score:null,investigators:null,decision:null,payout:null,inspection:null}),'status=accepted');
 const line=progressLine({status:'completed',band:'medium',risk_score:35,
  investigators:{invoice:{payment:'paid',report:'completed',verdict:'PAY'},wallet:{payment:'paid',report:'timeout',verdict:null},supplier:{payment:null,report:null,verdict:null}},
  decision:{decision:'PAY',final_decision:'approved'},payout:{phase:'done',state:'confirmed'},inspection:null});
 assert.equal(line,'status=completed band=medium score=35 invoice:paid/completed(PAY) wallet:paid/timeout supplier:-/- decision=PAY/approved payout=done/confirmed');
});

const KEY='000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

test('supplierHash matches the backend vector (hashing.rs) and its VAT normalization',()=>{
 const expected='hmac:d88e4971c52e43dbab3569644e7cfb90bc2ae7715d57e511402c0db713619060';
 assert.equal(supplierHash(KEY,'DE111111111'),expected);
 assert.equal(supplierHash(KEY,' de 111.111.111 '),expected);
 assert.equal(normalizeVat('gr-123456789'),'EL123456789');
 assert.notEqual(supplierHash(KEY,'DE222222222'),expected);
 for(const bad of ['',KEY.slice(0,62),`${KEY}a`,`${KEY.slice(0,62)}zz`,undefined])assert.throws(()=>supplierHash(bad,'DE111111111'),/SNIFFER_HMAC_KEY/);
});

test('prepareXml rewrites only the seller VAT (BT-31), seller name (BT-27) and order reference (BT-13)',()=>{
 const out=prepareXml(F1,{supplierVat:'DE222222222',supplierName:'Müller & Söhne GmbH',orderReference:'PO-2026-002'});
 assert.equal(sellerVat(F1),'DE111111111');
 assert.equal(sellerVat(out),'DE222222222');
 assert.ok(out.includes('<ram:SellerTradeParty>\n        <ram:Name>Müller &amp; Söhne GmbH</ram:Name>'));
 assert.ok(out.includes('<ram:ID schemeID="VA">DE999999999</ram:ID>'),'buyer VAT unchanged');
 assert.ok(out.includes('<ram:Name>Käufer Handels AG</ram:Name>'),'buyer name unchanged');
 assert.ok(out.includes('<ram:IssuerAssignedID>PO-2026-002</ram:IssuerAssignedID>'));
 const back=out.replace('DE222222222','DE111111111').replace('Müller &amp; Söhne GmbH','Alpha Consulting GmbH').replace('PO-2026-002','PO-2026-001');
 assert.equal(back,F1,'nothing else changes');
 assert.notEqual(intakeIds(out).caseId,intakeIds(F1).caseId);
 assert.equal(sellerVat(prepareXml(F1,{supplierName:'Beta GmbH'})),'DE111111111');
 assert.equal(prepareXml(F1,{supplierVat:'DE111111111'}),F1);
 assert.throws(()=>prepareXml(F1,{supplierVat:'de1'}),/Invalid supplier VAT/);
 assert.throws(()=>prepareXml(F1,{supplierName:'<b>'}),/Invalid supplier name/);
 assert.throws(()=>prepareXml(F1,{orderReference:'a b'}),/Invalid order reference/);
 assert.throws(()=>prepareXml(F1.replace(/<ram:SellerTradeParty>[\s\S]*?<\/ram:SellerTradeParty>/,''),{supplierVat:'DE222222222'}),/no seller/);
 assert.throws(()=>prepareXml(F1.replace(/<ram:BuyerOrderReferencedDocument>[\s\S]*?<\/ram:BuyerOrderReferencedDocument>/,''),{orderReference:'PO-1'}),/BT-13/);
});

test('supplier candidates come from the VIES mock; a new VAT takes its own open order and a name',()=>{
 const mock=readRepoJson(VIES_MOCK_FILE),orders=readRepoJson(OPEN_ORDERS_FILE);
 assert.deepEqual(validMockVats(mock),['DE111111111','DE222222222','DE333333333','DE555555555']);
 assert.deepEqual(validMockVats({A:false,B:'error',C:true}),['C']);
 assert.equal(openOrderFor('DE222222222',orders),'PO-2026-002');
 // Demo open orders for the --new-supplier VATs that follow DE111/DE222.
 assert.equal(openOrderFor('DE333333333',orders),'PO-2026-003');
 assert.equal(openOrderFor('DE555555555',orders),'PO-2026-005');
 for(const vat of ['DE333333333','DE555555555']){
  const order=orders.find(entry=>entry.supplier_vat_id===vat);
  assert.equal(order.currency,'EUR');assert.ok(Number(order.ordered_total)>=1190,vat);
  assert.match(prepareXml(F1,supplierRewrite(vat,{orders})),new RegExp(`<ram:IssuerAssignedID>${order.order_id}</ram:IssuerAssignedID>`));
 }
 assert.deepEqual(supplierRewrite('DE222222222',{orders}),{supplierVat:'DE222222222',supplierName:'Beta Beratung GmbH',orderReference:'PO-2026-002'});
 assert.deepEqual(supplierRewrite('DE777777777',{name:'X AG',orders}),{supplierVat:'DE777777777',supplierName:'X AG',orderReference:null});
 assert.equal(supplierRewrite('DE777777777').supplierName,'Lieferant DE777777777 GmbH');
});

const lookupsFor=({history={},journals={},statuses={}})=>{
 const calls=[];
 return {calls,lookups:{
  journalExists:async caseId=>{calls.push(['journal',caseId]);return Object.hasOwn(journals,caseId);},
  caseStatus:async caseId=>{calls.push(['case',caseId]);return statuses[caseId]??null;},
  history:async vat=>{calls.push(['history',vat]);return history[vat]??{status:404,body:null};},
 }};
};
const caseIdFor=vat=>`case-${vat}`;
const CANDIDATES=['DE111111111','DE222222222','DE333333333','DE555555555'];

test('pickFreshSupplier takes the first VAT without backend history, resumes an open demo case, skips finished ones',async()=>{
 let {lookups,calls}=lookupsFor({history:{DE111111111:{status:200,body:{approved_count:1}}}});
 assert.deepEqual(await pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups}),
  {vat:'DE222222222',caseId:'case-DE222222222',resume:false,skipped:[{vat:'DE111111111',reason:'backend has invoices (approved_count 1)'}]});
 assert.deepEqual(calls.map(c=>c[0]),['journal','history','journal','history']);
 // A paid but unfinished earlier run for DE222 is resumed even though the backend already knows the supplier: no second payment.
 ({lookups}=lookupsFor({history:{DE111111111:{status:200,body:{approved_count:0}},DE222222222:{status:200,body:{approved_count:0}}},
  journals:{'case-DE222222222':1},statuses:{'case-DE222222222':'investigating'}}));
 assert.deepEqual(await pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups}),
  {vat:'DE222222222',caseId:'case-DE222222222',resume:true,skipped:[{vat:'DE111111111',reason:'backend has invoices (approved_count 0)'}]});
 // Main unreachable (status null): resume rather than pay for another VAT.
 ({lookups}=lookupsFor({journals:{'case-DE111111111':1}}));
 assert.equal((await pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups})).resume,true);
 // A finished earlier demo case is skipped without asking the backend.
 ({lookups,calls}=lookupsFor({history:{DE111111111:{status:200,body:{}}},journals:{'case-DE222222222':1},statuses:{'case-DE222222222':'completed'}}));
 const pick=await pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups});
 assert.equal(pick.vat,'DE333333333');assert.equal(pick.skipped[1].reason,'earlier demo case case-DE222222222 is completed');
 assert.ok(!calls.some(([kind,arg])=>kind==='history'&&arg==='DE222222222'));
});

test('pickFreshSupplier fails when every candidate is used or the backend does not answer',async()=>{
 const used=Object.fromEntries(CANDIDATES.map(vat=>[vat,{status:200,body:{approved_count:1}}]));
 await assert.rejects(pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups:lookupsFor({history:used}).lookups}),
  error=>/No fresh supplier left/.test(error.message)&&error.message.includes(VIES_MOCK_FILE)&&error.message.includes('--supplier-vat'));
 await assert.rejects(pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups:lookupsFor({history:{DE111111111:{status:401}}}).lookups}),/HTTP 401 \(SNIFFER_API_TOKEN rejected\)/);
 await assert.rejects(pickFreshSupplier({candidates:CANDIDATES,caseIdFor,lookups:lookupsFor({history:{DE111111111:{status:0}}}).lookups}),/HTTP none/);
 await assert.rejects(pickFreshSupplier({candidates:[],caseIdFor,lookups:lookupsFor({}).lookups}),/No fresh supplier left/);
});

test('resolveSupplier builds the rewrite and the expected outcome for --new-supplier and --supplier-vat',async()=>{
 const xmlFor=rewrite=>prepareXml(F1,rewrite);
 const {lookups}=lookupsFor({history:{DE111111111:{status:200,body:{approved_count:1}}}});
 assert.equal(await resolveSupplier(parseArgs([]),{xmlFor,lookups}),null);
 const fresh=await resolveSupplier(parseArgs(['--new-supplier']),{xmlFor,lookups});
 assert.equal(fresh.vat,'DE222222222');assert.equal(fresh.fresh,true);assert.equal(fresh.openOrder,'PO-2026-002');
 assert.deepEqual(fresh.rewrite,{supplierVat:'DE222222222',supplierName:'Beta Beratung GmbH',orderReference:'PO-2026-002'});
 const lines=supplierLines(fresh);
 assert.equal(lines[0],'Skipping supplier DE111111111: backend has invoices (approved_count 1)');
 assert.equal(lines[1],'Supplier VAT DE222222222 (Beta Beratung GmbH), order PO-2026-002');
 assert.match(lines[2],/^expect medium: S-9 fires \(\+5\)\. .*score 20\. If the payment wallet was approved before, S-1/);
 const known=await resolveSupplier(parseArgs(['--supplier-vat','DE111111111']),{xmlFor,lookups});
 assert.equal(known.fresh,false);assert.match(supplierLines(known)[1],/^expect low: S-9 does not fire/);
 const invalid=await resolveSupplier(parseArgs(['--supplier-vat','DE444444444']),{xmlFor,lookups});
 assert.equal(invalid.viesValid,false);assert.match(supplierLines(invalid)[1],/^expect high: S-2 fires/);
 const noOrder=await resolveSupplier(parseArgs(['--supplier-vat','DE333333333','--supplier-name','Gamma AG']),{xmlFor,lookups,orders:[]});
 assert.deepEqual([noOrder.fresh,noOrder.viesValid,noOrder.rewrite.supplierName,noOrder.openOrder],[true,true,'Gamma AG',null]);
 assert.match(supplierLines(noOrder)[1],/^expect medium: S-9 fires \(\+5\); I-8 fires \(\+8\).*score 38/);
 const offline=await resolveSupplier(parseArgs(['--supplier-vat','DE333333333']),{xmlFor,lookups:{history:async()=>{throw new Error('no key');}}});
 assert.equal(offline.fresh,null);assert.match(supplierLines(offline)[1],/history of DE333333333 unknown/);
 const renamed=await resolveSupplier(parseArgs(['--supplier-name','Alpha AG']),{xmlFor,lookups});
 assert.deepEqual(supplierLines(renamed),['Seller name -> Alpha AG (VAT unchanged: supplier history unchanged)']);
 assert.match(supplierLines({...fresh,resume:true}).at(-1),/Resuming the earlier demo case for DE222222222/);
 assert.match(expectedOutcome({vat:'X',fresh:true,viesValid:true,openOrder:'PO'}),/^expect medium: S-9 fires/);
});

test('supplier history lookup needs the HMAC key and token and never calls the network without them',async()=>{
 const {history}=supplierLookups({SNIFFER_BASE_URL:'http://127.0.0.1:1'},{mainUrl:'http://127.0.0.1:1',journalDir:'/nonexistent'});
 await assert.rejects(history('DE222222222'),/SNIFFER_HMAC_KEY and SNIFFER_API_TOKEN/);
 const lookups=supplierLookups({SNIFFER_BASE_URL:'http://127.0.0.1:1',SNIFFER_HMAC_KEY:KEY,SNIFFER_API_TOKEN:'t'},{mainUrl:'http://127.0.0.1:1',journalDir:'/nonexistent'});
 assert.equal((await lookups.history('DE222222222')).status,0);
 assert.equal(await lookups.journalExists(CASE),false);
 assert.equal(await lookups.caseStatus(CASE),null);
});

test('--fresh-wallet creates a demo-recipient wallet through the injected creator and uses its address',()=>{
 assert.equal(parseArgs(['--fresh-wallet']).freshWallet,true);
 assert.equal(freshWalletName(1793433600123),'demo-recipient-1793433600123');
 assert.match(freshWalletName(1793433600123),/^[a-z][a-z0-9-]{0,31}$/,'x402 wallet name rule');
 const created=[];
 const deps={createWallet:name=>{created.push(name);return {address:ADDR};},walletAddress:()=>{throw new Error('not read');},now:()=>1793433600123};
 assert.deepEqual(resolveRecipient(parseArgs([CONFIRM_FLAG,'--fresh-wallet']),deps),{name:'demo-recipient-1793433600123',address:ADDR,fresh:true});
 assert.deepEqual(created,['demo-recipient-1793433600123']);
 assert.match(prepareXml(F1,{recipientAddress:ADDR}),new RegExp(`<ram:ProprietaryID>${ADDR}</ram:ProprietaryID>`));
 assert.throws(()=>resolveRecipient(parseArgs(['--fresh-wallet']),{...deps,createWallet:()=>({address:'addr1mainnet'})}),/no Preprod address/);
 // Without the flag nothing is created; --recipient-wallet still reads the named wallet.
 assert.equal(resolveRecipient(parseArgs([]),{...deps,createWallet:()=>assert.fail('created')}),null);
 assert.deepEqual(resolveRecipient(parseArgs(['--recipient-wallet','payee']),{createWallet:()=>assert.fail('created'),walletAddress:name=>name==='payee'?ADDR:null}),
  {name:'payee',address:ADDR,fresh:false});
 assert.match(expectedOutcome({vat:'DE333333333',fresh:true,viesValid:true,openOrder:'PO-2026-003',freshWallet:true}),
  /^expect medium: S-9 fires \(\+5\)\. Fresh recipient wallet .*T-3 -10, T-4 -5 -> score 20$/);
});
