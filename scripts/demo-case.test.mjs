import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,assertConfirmed,prepareXml,duePayableCents,payoutLovelace,caseIdFromJournal,pollCase,progressLine,payKeyFor,
 CONFIRM_FLAG,DEFAULT_FIXTURE,DEFAULT_TIMEOUT_MS,DEFAULT_POLL_MS} from './demo-case.mjs';
import {intakeIds} from '../main/case-store.mjs';
import {PAY_KEY_REGEX} from '../x402/pay.mjs';

const SCRIPT=fileURLToPath(new URL('./demo-case.mjs',import.meta.url));
const F1=readFileSync(fileURLToPath(new URL('../docs/fixtures/f1.xml',import.meta.url)),'utf8');
const CASE='case-'+'a'.repeat(32);
const ADDR='addr_test1qqsukwn3txs33kx4qh97g5suejsc6w78x994j7y6sefsk29vnt2urqy4t5rmhddtmprmhpfuueuupmd7kaez7ganq3xs5usuqq';

test('parseArgs: defaults, every option, and invalid input',()=>{
 const defaults=parseArgs([]);
 assert.deepEqual(defaults,{confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:'payer',
  mainUrl:'http://127.0.0.1:21951',timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null});
 assert.equal(parseArgs([],{MAIN_PORT:'22000'}).mainUrl,'http://127.0.0.1:22000');
 const all=parseArgs([CONFIRM_FLAG,'--fixture','docs/fixtures/f11.xml','--invoice-number','RE-2026-0413','--recipient-wallet','payee','--wallet','payer2',
  '--main-url','http://localhost:1234/','--timeout-ms','60000','--poll-ms','500','--case',CASE]);
 assert.deepEqual(all,{confirm:true,help:false,fixture:'docs/fixtures/f11.xml',invoiceNumber:'RE-2026-0413',recipientWallet:'payee',wallet:'payer2',
  mainUrl:'http://localhost:1234',timeoutMs:60000,pollMs:500,caseId:CASE});
 assert.equal(parseArgs(['-h']).help,true);
 for(const [argv,reason] of [[['--bogus'],/Unknown argument/],[['--fixture'],/needs a value/],[['--fixture','--poll-ms'],/needs a value/],
  [['--timeout-ms','0'],/timeout-ms/],[['--poll-ms','1.5'],/poll-ms/],[['--case','case-123'],/--case/],[['--invoice-number','a b'],/invoice-number/],
  [['--wallet','Payer'],/--wallet/],[['--recipient-wallet','../x'],/recipient-wallet/],[['--main-url','ftp://x'],/main-url/]]){
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
