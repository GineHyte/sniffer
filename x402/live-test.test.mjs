import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,rmSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findBlockingRuns,assertNoBlockingRun,assertPayerBalance,assertRequirementsSafe,findPayeeOutput,createJournal,CONFIRM_FLAG,SAFE_PHASE} from './live-test.mjs';

const SCRIPT=fileURLToPath(new URL('./live-test.mjs',import.meta.url));
const temp=()=>mkdtempSync(join(tmpdir(),'x402-live-'));
const PAYEE='addr_test1payee';
const good={scheme:'exact',network:'cardano:preprod',asset:'lovelace',amount:'1000000',payTo:PAYEE,maxTimeoutSeconds:600};
// Empty Blockfrost key: if a guard ever failed to stop the run, no network call could authenticate.
const cli=(dir,...args)=>spawnSync(process.execPath,[SCRIPT,...args],{encoding:'utf8',env:{...process.env,X402_STATE_DIR:dir,BLOCKFROST_API_KEY_PREPROD:''}});

test('refuses to run without the explicit confirmation flag',()=>{
 const dir=temp();
 try{
  const result=cli(dir);
  assert.equal(result.status,1);assert.match(result.stderr,/Refusing to run/);assert.match(result.stderr,new RegExp(CONFIRM_FLAG));
  assert.deepEqual(readdirSync(dir),[]);
 }finally{rmSync(dir,{recursive:true});}
});

test('any earlier run that is not a clean pre-signing failure blocks a second run',()=>{
 const dir=temp();
 try{
  assert.deepEqual(findBlockingRuns(dir),[]);
  assert.deepEqual(findBlockingRuns(join(dir,'missing')),[]);
  writeFileSync(join(dir,'live-test-a.json'),JSON.stringify({phase:SAFE_PHASE,server:{settleCalled:false}}));
  writeFileSync(join(dir,'live-test-a.json.tmp'),'partial');
  assert.deepEqual(findBlockingRuns(dir),[]);
  writeFileSync(join(dir,'live-test-b.json'),JSON.stringify({phase:'confirmed',txHash:'ab'.repeat(32)}));
  writeFileSync(join(dir,'live-test-c.json'),JSON.stringify({phase:'started'}));
  writeFileSync(join(dir,'live-test-d.json'),'{not json');
  writeFileSync(join(dir,'live-test-e.json'),JSON.stringify({phase:SAFE_PHASE,txHash:'cd'.repeat(32)}));
  writeFileSync(join(dir,'live-test-f.json'),JSON.stringify({phase:SAFE_PHASE,server:{settleCalled:true}}));
  assert.deepEqual(findBlockingRuns(dir).map(run=>run.file.slice(-16)),['live-test-b.json','live-test-c.json','live-test-d.json','live-test-e.json','live-test-f.json']);
  assert.throws(()=>assertNoBlockingRun(dir),error=>/No automatic retry/.test(error.message)&&error.message.includes('ab'.repeat(32))&&/wallets\.mjs balance payer/.test(error.message));
 }finally{rmSync(dir,{recursive:true});}
});

test('CLI refuses a second run before touching wallets or the network',()=>{
 const dir=temp();
 try{
  writeFileSync(join(dir,'live-test-x.json'),JSON.stringify({phase:'awaiting_confirmation',txHash:'ef'.repeat(32)}));
  const result=cli(dir,CONFIRM_FLAG);
  assert.equal(result.status,1);assert.match(result.stderr,/Refusing to run/);assert.match(result.stderr,/efef/);
  assert.deepEqual(readdirSync(dir),['live-test-x.json']);
 }finally{rmSync(dir,{recursive:true});}
});

test('payer balance must be at least 3 tADA on a used address',()=>{
 assert.throws(()=>assertPayerBalance({used:false,lovelace:0n}),/unused/);
 assert.throws(()=>assertPayerBalance({used:true,lovelace:2999999n}),/below the required 3\.000000/);
 assert.doesNotThrow(()=>assertPayerBalance({used:true,lovelace:3000000n}));
});

test('only the served 1 tADA requirement to the payee can be paid',()=>{
 assert.doesNotThrow(()=>assertRequirementsSafe(good,{payTo:PAYEE}));
 assert.doesNotThrow(()=>assertRequirementsSafe({...good,amount:'2000000'},{payTo:PAYEE}));
 for(const [patch,reason] of [[{amount:'2000001'},/amount/],[{amount:'1e6'},/amount/],[{payTo:'addr_test1other'},/payTo/],[{asset:'abc.def'},/asset/],[{network:'cardano:mainnet'},/network/],[{scheme:'upto'},/scheme/]]){
  assert.throws(()=>assertRequirementsSafe({...good,...patch},{payTo:PAYEE}),reason);
 }
});

test('payee output check needs the payee address with enough lovelace',()=>{
 const utxos={outputs:[{address:'addr_test1payer',amount:[{unit:'lovelace',quantity:'9000000'}]},{address:PAYEE,amount:[{unit:'lovelace',quantity:'999999'}]}]};
 assert.equal(findPayeeOutput(utxos,PAYEE,'1000000'),undefined);
 utxos.outputs.push({address:PAYEE,output_index:2,amount:[{unit:'lovelace',quantity:'1000000'}]});
 assert.equal(findPayeeOutput(utxos,PAYEE,'1000000').output_index,2);
 assert.equal(findPayeeOutput(null,PAYEE,'1'),undefined);
});

test('journal is private, never overwritten, and serializes bigint',()=>{
 const dir=temp();
 try{
  const now=new Date('2026-10-31T12:00:00Z');
  const journal=createJournal(dir,now);
  journal.update({phase:'started',payerBalanceBefore:3000000n});
  assert.equal(JSON.parse(readFileSync(journal.path,'utf8')).payerBalanceBefore,'3000000');
  assert.throws(()=>createJournal(dir,now),/EEXIST/);
  if(process.platform!=='win32'){assert.equal(statSync(dir).mode&0o777,0o700);assert.equal(statSync(journal.path).mode&0o777,0o600);}
 }finally{rmSync(dir,{recursive:true});}
});
