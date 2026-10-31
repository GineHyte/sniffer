import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,assertConfirmed,prepareXml,duePayableCents,payoutLovelace,caseIdFromJournal,pollCase,progressLine,payKeyFor,
 normalizeVat,supplierHash,sellerVat,validMockVats,openOrderFor,supplierRewrite,pickFreshSupplier,resolveSupplier,expectedOutcome,supplierLines,
 supplierLookups,readRepoJson,VIES_MOCK_FILE,OPEN_ORDERS_FILE,CONFIRM_FLAG,DEFAULT_FIXTURE,DEFAULT_TIMEOUT_MS,DEFAULT_POLL_MS} from './demo-case.mjs';
import {intakeIds} from '../main/case-store.mjs';
import {PAY_KEY_REGEX} from '../x402/pay.mjs';

const SCRIPT=fileURLToPath(new URL('./demo-case.mjs',import.meta.url));
const F1=readFileSync(fileURLToPath(new URL('../docs/fixtures/f1.xml',import.meta.url)),'utf8');
const CASE='case-'+'a'.repeat(32);
const ADDR='addr_test1qqsukwn3txs33kx4qh97g5suejsc6w78x994j7y6sefsk29vnt2urqy4t5rmhddtmprmhpfuueuupmd7kaez7ganq3xs5usuqq';

test('parseArgs: defaults, every option, and invalid input',()=>{
 const defaults=parseArgs([]);
 assert.deepEqual(defaults,{confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:'payer',
  mainUrl:'http://127.0.0.1:21951',timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null,newSupplier:false,supplierVat:null,supplierName:null});
 assert.equal(parseArgs([],{MAIN_PORT:'22000'}).mainUrl,'http://127.0.0.1:22000');
 const all=parseArgs([CONFIRM_FLAG,'--fixture','docs/fixtures/f11.xml','--invoice-number','RE-2026-0413','--recipient-wallet','payee','--wallet','payer2',
  '--main-url','http://localhost:1234/','--timeout-ms','60000','--poll-ms','500','--case',CASE,'--supplier-vat','DE222222222','--supplier-name','Müller & Söhne GmbH']);
 assert.deepEqual(all,{confirm:true,help:false,fixture:'docs/fixtures/f11.xml',invoiceNumber:'RE-2026-0413',recipientWallet:'payee',wallet:'payer2',
  mainUrl:'http://localhost:1234',timeoutMs:60000,pollMs:500,caseId:CASE,newSupplier:false,supplierVat:'DE222222222',supplierName:'Müller & Söhne GmbH'});
 assert.equal(parseArgs(['--new-supplier','--supplier-name','Beta GmbH']).newSupplier,true);
 assert.equal(parseArgs(['-h']).help,true);
 for(const [argv,reason] of [[['--bogus'],/Unknown argument/],[['--fixture'],/needs a value/],[['--fixture','--poll-ms'],/needs a value/],
  [['--timeout-ms','0'],/timeout-ms/],[['--poll-ms','1.5'],/poll-ms/],[['--case','case-123'],/--case/],[['--invoice-number','a b'],/invoice-number/],
  [['--wallet','Payer'],/--wallet/],[['--recipient-wallet','../x'],/recipient-wallet/],[['--main-url','ftp://x'],/main-url/],
  [['--supplier-vat','de222222222'],/supplier-vat/],[['--supplier-vat','D1'],/supplier-vat/],[['--supplier-name','<x>'],/supplier-name/],
  [['--supplier-name','a'.repeat(101)],/supplier-name/],[['--new-supplier','--supplier-vat','DE222222222'],/either --new-supplier or --supplier-vat/]]){
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
 assert.deepEqual(result,{done:true,view:{case_id:CASE,status:'completed'},timedOut:false});
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

test('progressLine summarizes the public case view',()=>{
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
 assert.equal(openOrderFor('DE333333333',orders),null);
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
 const noOrder=await resolveSupplier(parseArgs(['--supplier-vat','DE333333333','--supplier-name','Gamma AG']),{xmlFor,lookups});
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
