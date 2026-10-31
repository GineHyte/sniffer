import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as evolution from '@evolution-sdk/evolution';
import {runPayout,recordSubmitted,createBackendClient,createEvolutionSigner,createMemoryJournal,createFileJournal,loadPayoutSecrets,
 parseIntent,redact,assertPreprodAddress,PayoutError,BackendError,BLOCKFROST_PREPROD_URL} from './transfer.mjs';

const CHECK='chk_01JC2M4N6P8Q0R2S4T6V8W0X2Y';
const PAYOUT='pay_01JC2M4N6P8Q0R2S4T6V8W0X2Y';
// Public Preprod test address already documented in docs/x402-notes.md (payee); never a real recipient here.
const TO='addr_test1qqsukwn3txs33kx4qh97g5suejsc6w78x994j7y6sefsk29vnt2urqy4t5rmhddtmprmhpfuueuupmd7kaez7ganq3xs5usuqq';
const TX='ab'.repeat(32);
// Fake key material: not a valid BIP-39 phrase, never touches a network.
const FAKE_MNEMONIC='zebra fake words only for tests never real seed alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';
const FAKE_PROJECT='preprodFAKEPROJECTID000000000000';
const ENV={EXPECTED_NETWORK:'preprod'};

const view=(state,extra={})=>({payout_id:PAYOUT,check_id:CHECK,state,to_address:TO,amount_eur:'1190.00',ada_per_eur:'0.040000',lovelace:47600000,tx_hash:null,...extra});
const clock=()=>{let t=0;const sleeps=[];return {now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},sleeps};};
const silent=()=>{const lines=[];return Object.assign(line=>lines.push(line),{lines});};

// Scripted fake backend: each method takes a queue of results (objects are returned, Errors thrown).
function fakeBackend(script){
 const calls=[];
 const next=async(name,args)=>{
  calls.push([name,...args]);
  const queue=script[name];
  if(!queue||queue.length===0)throw new Error(`unexpected backend call ${name}`);
  const item=queue.length>1?queue.shift():queue[0];
  if(item instanceof Error)throw item;
  return typeof item==='function'?item(...args):structuredClone(item);
 };
 return {calls,authorize:(...a)=>next('authorize',a),submitting:(...a)=>next('submitting',a),submitted:(...a)=>next('submitted',a),confirm:(...a)=>next('confirm',a)};
}
function fakeSigner({submitError,txHash=TX}={}){
 const stats={built:0,submitted:0};
 return {stats,network:'preprod',
  async preflight(){},
  async buildAndSign({toAddress,lovelace}){
   stats.built++;stats.last={toAddress,lovelace};
   return {txHash,async submit(){stats.submitted++;if(submitError)throw submitError;return txHash;}};
  }};
}
const run=(opts)=>runPayout({checkId:CHECK,clock:clock(),journal:createMemoryJournal(),log:silent(),env:ENV,pollIntervalMs:1000,confirmTimeoutMs:5000,...opts});
const notFound=()=>new BackendError('x',{status:409,code:'tx_not_found'});

test('authorized intent goes through submitting, submit, submitted and confirm polling to confirmed',async()=>{
 const backend=fakeBackend({authorize:[view('authorized')],submitting:[view('submitting')],submitted:[view('submitted',{tx_hash:TX})],
  confirm:[notFound(),new BackendError('x',{status:503,code:'dependency_unavailable'}),view('confirmed',{tx_hash:TX})]});
 const signer=fakeSigner();const c=clock();const journal=createMemoryJournal();
 const result=await run({backend,signer,clock:c,journal});
 assert.deepEqual(result,{payoutId:PAYOUT,state:'confirmed',txHash:TX,resumed:false});
 assert.deepEqual(backend.calls.map(call=>call[0]),['authorize','submitting','submitted','confirm','confirm','confirm']);
 assert.deepEqual(backend.calls[0],['authorize',CHECK]);
 assert.deepEqual(backend.calls[2],['submitted',PAYOUT,TX]);
 assert.equal(signer.stats.built,1);assert.equal(signer.stats.submitted,1);
 assert.deepEqual(signer.stats.last,{toAddress:TO,lovelace:47600000n});
 assert.deepEqual(c.sleeps,[1000,1000]);
 assert.deepEqual(journal.entries.get(PAYOUT),{phase:'confirmed',tx_hash:TX});
});

test('an existing submitted intent resumes confirm and builds no new transaction',async()=>{
 const backend=fakeBackend({authorize:[view('submitted',{tx_hash:TX})],confirm:[notFound(),view('confirmed',{tx_hash:TX})]});
 const signer=fakeSigner();
 const result=await run({backend,signer});
 assert.deepEqual(result,{payoutId:PAYOUT,state:'confirmed',txHash:TX,resumed:true});
 assert.deepEqual(backend.calls.map(call=>call[0]),['authorize','confirm','confirm']);
 assert.equal(signer.stats.built,0);assert.equal(signer.stats.submitted,0);
});

test('confirm timeout keeps the intent submitted and never resubmits',async()=>{
 const backend=fakeBackend({authorize:[view('submitted',{tx_hash:TX})],confirm:[notFound()]});
 const signer=fakeSigner();
 await assert.rejects(run({backend,signer,confirmTimeoutMs:3000}),error=>error.code==='confirm_timeout'&&error.state==='submitted'&&/builds no new transaction/.test(error.message));
 assert.equal(signer.stats.built,0);
});

for(const state of ['unknown','submitting']){
 test(`${state} intent throws with manual inspection steps and touches nothing`,async()=>{
  const backend=fakeBackend({authorize:[view(state)]});
  const signer=fakeSigner();
  await assert.rejects(run({backend,signer}),error=>error instanceof PayoutError&&error.manual===true&&error.state===state
   &&/MANUAL INSPECTION REQUIRED/.test(error.message)&&/No automatic retry/.test(error.message)&&/record-submitted/.test(error.message)&&!error.message.includes(TO));
  assert.deepEqual(backend.calls.map(call=>call[0]),['authorize']);
  assert.equal(signer.stats.built,0);
 });
}

test('a missing state is never treated as authorized',async()=>{
 const body=view('authorized');delete body.state;
 const backend=fakeBackend({authorize:[body]});const signer=fakeSigner();
 await assert.rejects(run({backend,signer}),error=>error.code==='invalid_response');
 assert.equal(signer.stats.built,0);
});

test('a submit failure after submitting throws once and never submits a second time',async()=>{
 const backend=fakeBackend({authorize:[view('authorized'),view('submitting')],submitting:[view('submitting')]});
 const signer=fakeSigner({submitError:new Error(`relay timeout while sending to ${TO}`)});
 const journal=createMemoryJournal();const log=silent();
 await assert.rejects(run({backend,signer,journal,log}),error=>error.code==='submit_failed'&&error.manual&&error.txHash===TX
  &&error.message.includes(TX)&&error.message.includes('may still have reached the network')&&!error.message.includes(TO));
 assert.equal(signer.stats.submitted,1);
 assert.ok(!backend.calls.some(call=>call[0]==='submitted'));
 assert.deepEqual(journal.entries.get(PAYOUT),{phase:'submit_failed',tx_hash:TX});
 // A rerun sees `submitting` from the backend and stops; still exactly one submit.
 await assert.rejects(run({backend,signer,journal}),error=>error.manual&&error.state==='submitting');
 assert.equal(signer.stats.submitted,1);assert.equal(signer.stats.built,1);
 assert.ok(log.lines.every(line=>!line.includes(TO)));
});

test('a failed /submitted after broadcast stops with the tx hash for manual recording',async()=>{
 const backend=fakeBackend({authorize:[view('authorized')],submitting:[view('submitting')],submitted:[new BackendError('x',{status:0,code:'network_error'})]});
 const signer=fakeSigner();
 await assert.rejects(run({backend,signer}),error=>error.code==='record_submitted_failed'&&error.message.includes(`record-submitted ${PAYOUT} <tx_hash>`)&&error.message.includes(TX));
 assert.equal(signer.stats.submitted,1);
});

test('tx_mismatch from confirm stops for manual inspection',async()=>{
 const backend=fakeBackend({authorize:[view('submitted',{tx_hash:TX})],confirm:[new BackendError('x',{status:409,code:'tx_mismatch'})]});
 await assert.rejects(run({backend,signer:fakeSigner()}),error=>error.code==='tx_mismatch'&&error.state==='unknown'&&error.manual);
});

test('a refusal before signing releases the local claim and does not sign',async()=>{
 const backend=fakeBackend({authorize:[view('authorized')],submitting:[new BackendError('x',{status:409,code:'wallet_blocked'})]});
 const signer=fakeSigner();const journal=createMemoryJournal();
 await assert.rejects(run({backend,signer,journal}),error=>error.code==='wallet_blocked'&&error.status===409);
 assert.equal(signer.stats.built,0);assert.equal(journal.entries.size,0);
});

test('a 409 reason code from authorize is surfaced through the real backend client',async()=>{
 const requests=[];
 const fetchImpl=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({error:'over_daily_cap',message:'Tageslimit überschritten.'}),{status:409,headers:{'content-type':'application/json'}});};
 const backend=createBackendClient({baseUrl:'http://backend.test/',token:'tok-123',fetchImpl});
 const signer=fakeSigner();
 await assert.rejects(run({backend,signer}),error=>error instanceof PayoutError&&error.code==='over_daily_cap'&&error.status===409&&/over_daily_cap/.test(error.message));
 assert.equal(requests.length,1);
 assert.equal(requests[0].url,'http://backend.test/v1/payouts/authorize');
 assert.equal(requests[0].init.method,'POST');
 assert.equal(requests[0].init.headers.authorization,'Bearer tok-123');
 assert.deepEqual(JSON.parse(requests[0].init.body),{check_id:CHECK});
 assert.equal(signer.stats.built,0);
});

test('backend client posts to the §12.5 transition paths and validates ids before sending',async()=>{
 const seen=[];
 const fetchImpl=async(url,init)=>{seen.push([url,JSON.parse(init.body)]);return new Response(JSON.stringify(view('submitted',{tx_hash:TX})),{status:200});};
 const backend=createBackendClient({baseUrl:'http://b',token:'t',fetchImpl});
 await backend.submitting(PAYOUT);await backend.submitted(PAYOUT,TX);await backend.confirm(PAYOUT);
 assert.deepEqual(seen,[[`http://b/v1/payouts/${PAYOUT}/submitting`,{}],[`http://b/v1/payouts/${PAYOUT}/submitted`,{tx_hash:TX}],[`http://b/v1/payouts/${PAYOUT}/confirm`,{}]]);
 await assert.rejects(()=>backend.submitting('pay_../../x'),/payout_id/);
 await assert.rejects(()=>backend.submitted(PAYOUT,'ABC'),/tx_hash/);
 assert.equal(seen.length,3);
 const down=createBackendClient({baseUrl:'http://b',token:'t',fetchImpl:async()=>{throw new TypeError('fetch failed');}});
 await assert.rejects(down.confirm(PAYOUT),error=>error instanceof BackendError&&error.status===0&&error.code==='network_error');
 assert.throws(()=>createBackendClient({token:''}),/SNIFFER_API_TOKEN/);
});

test('network guard: Preprod only',async()=>{
 const backend=fakeBackend({authorize:[view('authorized',{to_address:'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x'})]});
 await assert.rejects(run({backend,signer:fakeSigner(),env:{EXPECTED_NETWORK:'mainnet'}}),error=>error.code==='network_not_allowed');
 await assert.rejects(run({backend,signer:{...fakeSigner(),network:'mainnet'}}),error=>error.code==='network_not_allowed');
 assert.equal(backend.calls.length,0);
 const signer=fakeSigner();
 await assert.rejects(run({backend,signer}),error=>error.code==='network_not_allowed'&&!error.message.includes('addr1'));
 assert.equal(signer.stats.built,0);
 assert.equal(assertPreprodAddress(TO),TO);
 assert.throws(()=>assertPreprodAddress(`${TO.slice(0,-1)}x`),error=>!error.message.includes(TO.slice(0,40)));
});

test('a local cap above the policy cap is refused before submitting',async()=>{
 const backend=fakeBackend({authorize:[view('authorized',{lovelace:60_000_000})]});const signer=fakeSigner();
 await assert.rejects(run({backend,signer}),error=>error.code==='over_local_cap');
 assert.deepEqual(backend.calls.map(call=>call[0]),['authorize']);
});

test('the file journal claim is exclusive so a second local run cannot sign',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'payout-journal-'));
 try{
  const journal=createFileJournal(dir);
  journal.claim(PAYOUT);
  assert.throws(()=>journal.claim(PAYOUT),error=>error.code==='journal_exists'&&error.manual);
  journal.record(PAYOUT,{phase:'signed',tx_hash:TX});
  assert.equal(JSON.parse(readFileSync(join(dir,`${PAYOUT}.json`),'utf8')).tx_hash,TX);
  journal.release(PAYOUT);assert.equal(existsSync(join(dir,`${PAYOUT}.json`)),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// Fake Evolution SDK surface used by createEvolutionSigner; build() can be made to fail with secrets in the message.
function fakeSdk({buildError}={}){
 const seen={};
 const submitted=[];
 const sdk={
  preprod:evolution.preprod,
  PrivateKey:{validateMnemonic:value=>{seen.validated=value;return true;}},
  Address:{toBech32:value=>value,fromBech32:value=>({bech32:value})},
  Assets:{fromLovelace:value=>({lovelace:value}),lovelaceOf:assets=>assets.lovelace},
  TransactionHash:{toHex:value=>value.hex},
  Client:{make:chain=>({withBlockfrost:config=>{seen.blockfrost=config;return {withSeed:wallet=>{seen.wallet=wallet;return {
   chain,
   address:async()=>'addr_test1qzpayoutwalletfakeaddressxxxxxxxxxxxxxxxxxxxxx',
   getWalletUtxos:async()=>[{assets:{lovelace:100_000_000n}}],
   newTx:()=>{const ops={};const builder={
    payToAddress:params=>{ops.pay=params;return builder;},
    setValidity:params=>{ops.validity=params;return builder;},
    build:async()=>{
     seen.ops=ops;
     if(buildError)throw new Error(buildError);
     return {chainResult:()=>({txHash:TX}),sign:async()=>({submit:async()=>{submitted.push(TX);return {hex:TX};}})};
    }};return builder;},
  };}};}})},
 };
 return {sdk,seen,submitted};
}
function captureConsole(){
 const out=[];const original={};
 for(const name of ['log','error','warn','info','debug']){original[name]=console[name];console[name]=(...args)=>out.push(args.map(String).join(' '));}
 return {out,restore(){Object.assign(console,original);}};
}
const leaks=(text)=>[FAKE_MNEMONIC,FAKE_PROJECT,TO,'zebra fake words'].filter(secret=>text.includes(secret));

test('the Evolution signer builds a Preprod payment, and neither key nor address reaches any log output',async()=>{
 const {sdk,seen,submitted}=fakeSdk();
 const capture=captureConsole();
 try{
  const signer=createEvolutionSigner({mnemonic:FAKE_MNEMONIC,projectId:FAKE_PROJECT,sdk,now:()=>1_000});
  const backend=fakeBackend({authorize:[view('authorized')],submitting:[view('submitting')],submitted:[view('submitted',{tx_hash:TX})],confirm:[view('confirmed',{tx_hash:TX})]});
  // default logger (console) on purpose
  const result=await runPayout({checkId:CHECK,backend,signer,clock:clock(),journal:createMemoryJournal(),env:ENV});
  assert.equal(result.state,'confirmed');
 }finally{capture.restore();}
 assert.ok(capture.out.length>=4,'flow should log progress');
 assert.deepEqual(leaks(capture.out.join('\n')),[]);
 assert.deepEqual(seen.blockfrost,{baseUrl:BLOCKFROST_PREPROD_URL,projectId:FAKE_PROJECT});
 assert.deepEqual(seen.wallet,{mnemonic:FAKE_MNEMONIC,accountIndex:0});
 assert.deepEqual(seen.ops.pay,{address:{bech32:TO},assets:{lovelace:47600000n}});
 assert.deepEqual(seen.ops.validity,{to:1_000n+15n*60_000n});
 assert.deepEqual(submitted,[TX]);
});

test('signer errors that echo the key or address are redacted in the thrown error and in logs',async()=>{
 const {sdk}=fakeSdk({buildError:`bad input mnemonic=${FAKE_MNEMONIC} project=${FAKE_PROJECT} to=${TO}`});
 const capture=captureConsole();let thrown;
 try{
  const signer=createEvolutionSigner({mnemonic:`  ${FAKE_MNEMONIC.toUpperCase()}  `,projectId:FAKE_PROJECT,sdk});
  const backend=fakeBackend({authorize:[view('authorized')],submitting:[view('submitting')]});
  await runPayout({checkId:CHECK,backend,signer,clock:clock(),journal:createMemoryJournal(),env:ENV}).catch(error=>{thrown=error;console.error(error);console.error(error.message);});
 }finally{capture.restore();}
 assert.equal(thrown?.code,'build_or_sign_failed');
 assert.match(thrown.message,/\[redacted\]/);
 assert.deepEqual(leaks(capture.out.join('\n')),[]);
 assert.deepEqual(leaks(`${thrown.message}\n${thrown.stack}\n${JSON.stringify(thrown)}`),[]);
});

test('the real Evolution SDK derives a Preprod address offline from an in-memory mnemonic',async()=>{
 const mnemonic=evolution.PrivateKey.generateMnemonic(256);
 const signer=createEvolutionSigner({mnemonic,projectId:FAKE_PROJECT});
 assert.equal(signer.network,'preprod');
 assert.match(await signer.address(),/^addr_test1/);
 assert.throws(()=>createEvolutionSigner({mnemonic:FAKE_MNEMONIC,projectId:FAKE_PROJECT}),error=>error.code==='config_invalid'&&!error.message.includes('zebra'));
 assert.throws(()=>createEvolutionSigner({mnemonic,projectId:''}),/BLOCKFROST_API_KEY_PREPROD/);
});

test('loadPayoutSecrets reads PAYOUT_MNEMONIC and never quotes file content in errors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'payout-env-'));
 try{
  const file=join(dir,'payout.env');
  writeFileSync(file,`# test only\nPAYOUT_MNEMONIC="${FAKE_MNEMONIC.toUpperCase()}"\nPAYOUT_ACCOUNT_INDEX=2\n`);
  assert.deepEqual(loadPayoutSecrets(file),{mnemonic:FAKE_MNEMONIC,accountIndex:2});
  writeFileSync(file,`PAYOUT_ACCOUNT_INDEX=x\nPAYOUT_MNEMONIC=${FAKE_MNEMONIC}\n`);
  assert.throws(()=>loadPayoutSecrets(file),error=>error.code==='config_invalid'&&!error.message.includes('zebra'));
  writeFileSync(file,`OTHER=${FAKE_MNEMONIC}\n`);
  assert.throws(()=>loadPayoutSecrets(file),error=>error.code==='config_missing'&&!error.message.includes('zebra'));
  assert.throws(()=>loadPayoutSecrets(join(dir,'missing.env')),error=>error.code==='config_missing'&&/ENOENT/.test(error.message));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('recordSubmitted only records a tx hash and validates its inputs',async()=>{
 const backend=fakeBackend({submitted:[view('submitted',{tx_hash:TX})]});
 assert.deepEqual(await recordSubmitted({payoutId:PAYOUT,txHash:TX,backend,log:silent()}),{payoutId:PAYOUT,state:'submitted',txHash:TX});
 await assert.rejects(recordSubmitted({payoutId:PAYOUT,txHash:'xyz',backend,log:silent()}),/tx_hash/);
 assert.equal(backend.calls.length,1);
});

test('parseIntent and redact helpers',()=>{
 assert.throws(()=>parseIntent(view('authorized',{lovelace:0})),/lovelace/);
 assert.throws(()=>parseIntent(view('authorized',{lovelace:'47600000'})),/lovelace/);
 assert.throws(()=>parseIntent(view('weird')),/state/);
 assert.equal(parseIntent(view('authorized')).lovelace,47600000n);
 assert.equal(redact(`x ${TO} y`),'x [address] y');
 assert.equal(redact('secret-value-123 ok',['secret-value-123']),'[redacted] ok');
});
