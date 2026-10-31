import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWallet,readWallet,walletPath,deriveAddress,fetchBalance,validateName} from './wallets.mjs';

const SCRIPT=fileURLToPath(new URL('./wallets.mjs',import.meta.url));
const temp=()=>mkdtempSync(join(tmpdir(),'x402-wallets-'));
const cli=(dir,...args)=>spawnSync(process.execPath,[SCRIPT,...args],{encoding:'utf8',env:{...process.env,X402_STATE_DIR:dir}});

test('create writes a valid preprod wallet whose address matches the reference signer',()=>{
 const dir=temp();
 try{
  const {address}=createWallet('payer',{dir,now:()=>new Date('2026-10-31T00:00:00Z')});
  const wallet=JSON.parse(readFileSync(walletPath('payer',dir),'utf8'));
  assert.equal(wallet.network,'preprod');assert.equal(wallet.createdAt,'2026-10-31T00:00:00.000Z');
  assert.equal(wallet.mnemonic.split(' ').length,24);
  assert.match(address,/^addr_test1/);assert.equal(wallet.address,address);assert.equal(deriveAddress(wallet.mnemonic),address);
  if(process.platform!=='win32'){assert.equal(statSync(dir).mode&0o777,0o700);assert.equal(statSync(walletPath('payer',dir)).mode&0o777,0o600);}
 }finally{rmSync(dir,{recursive:true});}
});

test('create refuses to overwrite an existing wallet',()=>{
 const dir=temp();
 try{
  createWallet('payee',{dir});
  const before=readFileSync(walletPath('payee',dir),'utf8');
  assert.throws(()=>createWallet('payee',{dir}),/already exists/);
  assert.equal(readFileSync(walletPath('payee',dir),'utf8'),before);
 }finally{rmSync(dir,{recursive:true});}
});

test('wallet names cannot escape the state directory',()=>{
 for(const name of ['','../payer','Payer','a/b','a\\b',undefined])assert.throws(()=>validateName(name),/Wallet name/);
});

test('CLI create and address print only the address, never the mnemonic',()=>{
 const dir=temp();
 try{
  const created=cli(dir,'create','payer');
  assert.equal(created.status,0,created.stderr);
  const {mnemonic,address}=JSON.parse(readFileSync(walletPath('payer',dir),'utf8'));
  assert.equal(created.stdout,`${address}\n`);
  const shown=cli(dir,'address','payer');
  assert.equal(shown.stdout,`${address}\n`);
  const again=cli(dir,'create','payer');
  assert.equal(again.status,1);assert.match(again.stderr,/already exists/);
  const words=mnemonic.split(' ');
  for(const output of [created.stdout,created.stderr,shown.stdout,shown.stderr,again.stdout,again.stderr]){
   for(let i=0;i+3<=words.length;i++)assert.equal(output.includes(words.slice(i,i+3).join(' ')),false);
  }
 }finally{rmSync(dir,{recursive:true});}
});

test('a corrupt wallet file error never echoes file content',()=>{
 const dir=temp();
 try{
  const secret='abandon ability able about above absent absorb abstract absurd abuse access accident';
  writeFileSync(walletPath('payer',dir),`{"mnemonic":"${secret}"`);
  assert.throws(()=>readWallet('payer',dir),error=>!error.message.includes('abandon')&&/not valid JSON/.test(error.message));
  const result=cli(dir,'address','payer');
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('abandon'),false);
 }finally{rmSync(dir,{recursive:true});}
});

test('balance treats Blockfrost 404 as unused and reads lovelace otherwise',async()=>{
 const calls=[];
 const fake=status=>async(url,init)=>{calls.push({url,init});return new Response(status===200?JSON.stringify({amount:[{unit:'lovelace',quantity:'3500000'}]}):'{}',{status});};
 assert.deepEqual(await fetchBalance('addr_test1x',{projectId:'k',fetchImpl:fake(404)}),{address:'addr_test1x',used:false,lovelace:0n});
 assert.deepEqual(await fetchBalance('addr_test1x',{projectId:'k',fetchImpl:fake(200)}),{address:'addr_test1x',used:true,lovelace:3500000n});
 assert.equal(calls[0].init.headers.project_id,'k');assert.match(calls[0].url,/\/addresses\/addr_test1x$/);
 await assert.rejects(fetchBalance('addr_test1x',{projectId:'k',fetchImpl:fake(500)}),/HTTP 500/);
 await assert.rejects(fetchBalance('addr_test1x',{projectId:'',fetchImpl:fake(200)}),/BLOCKFROST_API_KEY_PREPROD/);
});
