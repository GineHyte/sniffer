// ONE measured x402 payment on Cardano Preprod: payer -> payee, 1 tADA, via an in-process facilitator.
// Run only with explicit user approval:
//   node --env-file=.env x402/live-test.mjs --confirm-live-payment
// Guards: payer balance >= 3 tADA; refuses if any earlier live-test journal is not a clean pre-signing failure;
// at most one payment payload is created per run; no automatic retry.
import {openSync,writeFileSync,closeSync,readFileSync,readdirSync,renameSync,mkdirSync,chmodSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {x402ResourceServer} from '@x402/core/server';
import {x402HTTPResourceServer,decodePaymentRequiredHeader} from '@x402/core/http';
import {wrapFetchWithPayment,x402Client,decodePaymentResponseHeader} from '@x402/fetch';
import {toClientCardanoSigner,decodeCardanoPayload,decodeCardanoTransaction} from '@x402/cardano';
import {ExactCardanoScheme as ExactCardanoServer} from '@x402/cardano/exact/server';
import {ExactCardanoScheme as ExactCardanoClient} from '@x402/cardano/exact/client';
import {NETWORK,BLOCKFROST_PREPROD_URL,stateDir,readWallet,walletAddress,fetchBalance,formatAda} from './wallets.mjs';
import {createInProcessFacilitator,blockfrostProvider} from './facilitator.mjs';

export const PRICE_LOVELACE='1000000';
export const MAX_SPEND_LOVELACE='2000000';
export const MIN_PAYER_LOVELACE=3000000n;
export const CONFIRM_TIMEOUT_MS=10*60*1000;
export const POLL_INTERVAL_MS=15000;
export const CONFIRM_FLAG='--confirm-live-payment';
export const ROUTE='/paid-test';
// The only journal phase that proves no payment can have left this machine.
export const SAFE_PHASE='failed_before_signing';

const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item,1);

export function listRunFiles(dir){
 try{return readdirSync(dir).filter(name=>/^live-test-.+\.json$/.test(name)).sort();}
 catch(error){if(error.code==='ENOENT')return [];throw error;}
}

// Any earlier run blocks unless it cleanly failed before a payment payload was signed. Unreadable files block (fail closed).
export function findBlockingRuns(dir){
 const blocking=[];
 for(const name of listRunFiles(dir)){
  const file=join(dir,name);
  let run;
  try{run=JSON.parse(readFileSync(file,'utf8'));}catch{blocking.push({file,reason:'unreadable'});continue;}
  if(run?.txHash||run?.server?.settleCalled||run?.phase!==SAFE_PHASE)blocking.push({file,phase:run?.phase,txHash:run?.txHash});
 }
 return blocking;
}

export function inspectionSteps(blocking){
 const lines=['Refusing to run: an earlier live test may have submitted a payment. No automatic retry.','Inspect each run before deciding anything:'];
 for(const run of blocking){
  lines.push(`- ${run.file} (phase: ${run.phase??run.reason??'unknown'}${run.txHash?`, txHash: ${run.txHash}`:''})`);
  if(run.txHash){
   lines.push(`  GET ${BLOCKFROST_PREPROD_URL}/txs/${run.txHash} with header project_id (404 = not on chain yet)`);
   lines.push(`  GET ${BLOCKFROST_PREPROD_URL}/txs/${run.txHash}/utxos  -> look for the payee output`);
   lines.push(`  Explorer: https://preprod.cardanoscan.io/transaction/${run.txHash}`);
  }
 }
 lines.push('- Check balances: node --env-file=.env x402/wallets.mjs balance payer   (and: balance payee)');
 lines.push('- Only after a human confirms no payment is pending may a run file be moved out of the state directory.');
 return lines.join('\n');
}

export function assertNoBlockingRun(dir){
 const blocking=findBlockingRuns(dir);
 if(blocking.length)throw new Error(inspectionSteps(blocking));
}

export function assertPayerBalance(balance){
 if(!balance?.used)throw new Error('Payer address is unused on Preprod (Blockfrost 404). Fund it from the faucet first.');
 if(BigInt(balance.lovelace)<MIN_PAYER_LOVELACE)throw new Error(`Payer balance ${formatAda(balance.lovelace)} tADA is below the required ${formatAda(MIN_PAYER_LOVELACE)} tADA.`);
}

// Defence in depth on top of spendControls: only the exact requirement this test serves may be paid.
export function assertRequirementsSafe(requirements,{payTo}){
 if(requirements?.scheme!=='exact')throw new Error('Refusing payment: scheme is not "exact".');
 if(requirements.network!==NETWORK)throw new Error(`Refusing payment: network is not ${NETWORK}.`);
 if(requirements.asset!=='lovelace')throw new Error('Refusing payment: asset is not lovelace.');
 if(typeof requirements.amount!=='string'||!/^[0-9]+$/.test(requirements.amount)||BigInt(requirements.amount)>BigInt(MAX_SPEND_LOVELACE))throw new Error(`Refusing payment: amount exceeds ${MAX_SPEND_LOVELACE} lovelace.`);
 if(requirements.payTo!==payTo)throw new Error('Refusing payment: payTo is not the payee wallet.');
}

export function lovelaceOf(output){
 const entry=Array.isArray(output?.amount)?output.amount.find(item=>item?.unit==='lovelace'):undefined;
 return entry&&/^[0-9]+$/.test(String(entry.quantity))?BigInt(entry.quantity):0n;
}

export function findPayeeOutput(utxos,payTo,minLovelace){
 return (Array.isArray(utxos?.outputs)?utxos.outputs:[]).find(output=>output?.address===payTo&&lovelaceOf(output)>=BigInt(minLovelace));
}

export function createJournal(dir,now=new Date()){
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
 const path=join(dir,`live-test-${now.toISOString().replace(/[:.]/g,'-')}.json`);
 const state={};
 const fd=openSync(path,'wx',0o600);
 try{writeFileSync(fd,json(state));}finally{closeSync(fd);}
 const update=patch=>{
  Object.assign(state,patch,{updatedAt:new Date().toISOString()});
  const tmp=`${path}.tmp`;writeFileSync(tmp,json(state),{mode:0o600});renameSync(tmp,path);
 };
 return {path,state,update};
}

function headerOf(headers,name){
 const key=Object.keys(headers||{}).find(item=>item.toLowerCase()===name.toLowerCase());
 return key===undefined?undefined:headers[key];
}

function adapterFor(req,url){
 return {
  getHeader:name=>{const value=req.headers[name.toLowerCase()];return Array.isArray(value)?value[0]:value;},
  getMethod:()=>req.method,
  getPath:()=>url.pathname,
  getUrl:()=>url.href,
  getAcceptHeader:()=>req.headers.accept||'',
  getUserAgent:()=>req.headers['user-agent']||'',
  getQueryParams:()=>Object.fromEntries(url.searchParams),
  getQueryParam:name=>url.searchParams.get(name)??undefined,
 };
}

function sendInstructions(res,response){
 res.statusCode=response.status;
 for(const [key,value] of Object.entries(response.headers||{}))res.setHeader(key,value);
 if(response.isHtml){res.setHeader('content-type','text/html');res.end(String(response.body??''));return;}
 if(!headerOf(response.headers,'content-type'))res.setHeader('content-type','application/json');
 res.end(JSON.stringify(response.body??{}));
}

export async function startResourceServer({payTo,projectId,journal}){
 const routes={[`GET ${ROUTE}`]:{
  accepts:{scheme:'exact',network:NETWORK,payTo,price:{amount:PRICE_LOVELACE,asset:'lovelace'},maxTimeoutSeconds:600,
   extra:{assetTransferMethod:'default',areFeesSponsored:false,confirmationPolicy:{l1Confirmations:0}}},
  description:'Sniffer x402 Preprod live test',mimeType:'application/json',
 }};
 const resourceServer=new x402ResourceServer(createInProcessFacilitator({projectId})).register(NETWORK,new ExactCardanoServer());
 const httpServer=new x402HTTPResourceServer(resourceServer,routes);
 await httpServer.initialize();
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  const adapter=adapterFor(req,url);
  const context={adapter,path:url.pathname,method:req.method};
  const events=journal.state.server?.events||[];
  try{
   const result=await httpServer.processHTTPRequest(context);
   if(result.type==='no-payment-required'){res.statusCode=404;res.end();return;}
   if(result.type==='payment-error'){
    const header=headerOf(result.response.headers,'PAYMENT-REQUIRED');
    const paymentRequired=header?decodePaymentRequiredHeader(header):undefined;
    events.push({at:new Date().toISOString(),type:'payment-error',status:result.response.status,hadPaymentSignature:Boolean(adapter.getHeader('payment-signature')),error:paymentRequired?.error});
    journal.update({server:{...journal.state.server,events},...(paymentRequired&&!journal.state.paymentRequired?{paymentRequired}:{})});
    sendInstructions(res,result.response);return;
   }
   // Authorization flow: verified, handler "runs" (no side effects), then settle broadcasts.
   events.push({at:new Date().toISOString(),type:'payment-verified'});
   journal.update({server:{...journal.state.server,events,settleCalled:true}});
   const body=Buffer.from(JSON.stringify({ok:true,resource:'paid-test'}));
   const settle=await httpServer.processSettlement(result.paymentPayload,result.paymentRequirements,result.declaredExtensions,{request:context,responseBody:body});
   const {headers:_headers,response:_response,...settlement}=settle;
   journal.update({server:{...journal.state.server,events,settleCalled:true,settlement}});
   if(!settle.success){sendInstructions(res,settle.response);return;}
   res.statusCode=200;
   for(const [key,value] of Object.entries(settle.headers||{}))res.setHeader(key,value);
   res.setHeader('content-type','application/json');res.end(body);
  }catch(error){
   events.push({at:new Date().toISOString(),type:'server-error',message:error.message});
   journal.update({server:{...journal.state.server,events}});
   if(!res.headersSent){res.statusCode=500;res.end();}
  }
 });
 await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
 return server;
}

async function blockfrost(path,projectId){
 const response=await fetch(`${BLOCKFROST_PREPROD_URL}${path}`,{headers:{project_id:projectId},signal:AbortSignal.timeout(20000)});
 if(response.status===404)return null;
 if(!response.ok)throw new Error(`Blockfrost ${path.split('/').slice(0,2).join('/')} returned HTTP ${response.status}.`);
 return response.json();
}

async function awaitOnChain(txHash,{projectId,deadline,journal}){
 const errors=[];
 while(Date.now()<deadline){
  try{
   const tx=await blockfrost(`/txs/${txHash}`,projectId);
   if(tx&&tx.block_height!=null)return {tx,errors};
  }catch(error){errors.push({at:new Date().toISOString(),message:error.message});journal.update({pollErrors:errors});}
  await sleep(Math.min(POLL_INTERVAL_MS,Math.max(0,deadline-Date.now())));
 }
 return {tx:null,errors};
}

async function run(){
 const dir=stateDir();
 assertNoBlockingRun(dir);
 const projectId=process.env.BLOCKFROST_API_KEY_PREPROD;
 if(!projectId)throw new Error('BLOCKFROST_API_KEY_PREPROD is not set. Run with: node --env-file=.env x402/live-test.mjs '+CONFIRM_FLAG);
 const payer=readWallet('payer',dir);
 const payee=walletAddress('payee',dir);
 if(payer.address===payee)throw new Error('Payer and payee must be different wallets.');
 const balance=await fetchBalance(payer.address,{projectId});
 assertPayerBalance(balance);

 const journal=createJournal(dir);
 journal.update({phase:'started',startedAt:new Date().toISOString(),network:NETWORK,priceLovelace:PRICE_LOVELACE,payer:payer.address,payee,payerBalanceBefore:balance.lovelace,server:{events:[],settleCalled:false}});
 process.stdout.write(`Journal: ${journal.path}\n`);

 let server;
 try{
  server=await startResourceServer({payTo:payee,projectId,journal});
  const url=`http://127.0.0.1:${server.address().port}${ROUTE}`;
  const signer=toClientCardanoSigner({mnemonic:payer.mnemonic,network:NETWORK,provider:blockfrostProvider(projectId)});
  if(signer.getAddress()!==payer.address)throw new Error('Payer signer address does not match the stored payer address.');
  let created=0;
  const client=new x402Client()
   .register(NETWORK,new ExactCardanoClient(signer))
   .setSpendControls({allowedAssets:[{network:NETWORK,asset:'lovelace',maxAmountPerPayment:MAX_SPEND_LOVELACE}]});
  client.onBeforePaymentCreation(async({selectedRequirements})=>{
   if(created>0)return {abort:true,reason:'Only one payment per live-test run.'};
   try{assertRequirementsSafe(selectedRequirements,{payTo:payee});}catch(error){return {abort:true,reason:error.message};}
   created+=1;
   journal.update({phase:'signing',selectedRequirements});
  });
  client.onAfterPaymentCreation(async({paymentPayload})=>{
   const payload=decodeCardanoPayload(paymentPayload.payload);
   const {txHash}=decodeCardanoTransaction(payload.transaction);
   // Persisted before the signed payload is sent to the server, which is the only party that broadcasts.
   journal.update({phase:'signed',signedAt:new Date().toISOString(),txHash,nonce:payload.nonce});
  });
  journal.update({request:{method:'GET',url}});
  const response=await wrapFetchWithPayment(fetch,client)(url);
  const paymentResponseHeader=response.headers.get('PAYMENT-RESPONSE')??undefined;
  let paymentResponse;
  if(paymentResponseHeader){try{paymentResponse=decodePaymentResponseHeader(paymentResponseHeader);}catch(error){paymentResponse={decodeError:error.message};}}
  const bodyText=(await response.text()).slice(0,2000);
  journal.update({phase:'response_received',response:{status:response.status,body:bodyText,paymentResponseHeader,paymentResponse}});
 }catch(error){
  const safe=!journal.state.txHash&&!journal.state.server?.settleCalled;
  journal.update({phase:safe?SAFE_PHASE:'unknown_after_signing',error:error.message});
  if(!safe)throw new Error(`${error.message}\nA payment may have been submitted. Inspect ${journal.path} before doing anything else.`);
  throw error;
 }finally{
  if(server)await new Promise(resolveClose=>server.close(()=>resolveClose()));
 }

 const txHash=journal.state.txHash;
 if(!txHash){journal.update({phase:SAFE_PHASE,error:'No payment payload was created.'});throw new Error('No payment payload was created. Inspect the journal.');}
 if(!journal.state.server.settleCalled){
  journal.update({phase:'not_broadcast_verify_rejected'});
  throw new Error(`Server rejected the payment before settlement; the tx was never broadcast by this process. Inspect ${journal.path}.`);
 }
 const deadline=Date.parse(journal.state.signedAt)+CONFIRM_TIMEOUT_MS;
 journal.update({phase:'awaiting_confirmation'});
 process.stdout.write(`txHash: ${txHash}\nPolling Blockfrost until ${new Date(deadline).toISOString()} ...\n`);
 const {tx}=await awaitOnChain(txHash,{projectId,deadline,journal});
 if(!tx){
  journal.update({phase:'unconfirmed_timeout'});
  throw new Error(`Tx ${txHash} not seen on chain within 10 minutes. Do not retry. Inspect ${journal.path}.`);
 }
 const utxos=await blockfrost(`/txs/${txHash}/utxos`,projectId);
 const payeeOutput=findPayeeOutput(utxos,payee,PRICE_LOVELACE);
 const latest=await blockfrost('/blocks/latest',projectId).catch(()=>null);
 const verification={block:tx.block,block_height:tx.block_height,block_time:tx.block_time,valid_contract:tx.valid_contract,fees:tx.fees,
  confirmations:latest?.height!=null?latest.height-tx.block_height:undefined,
  payeeOutput:payeeOutput?{address:payeeOutput.address,lovelace:lovelaceOf(payeeOutput),output_index:payeeOutput.output_index}:null};
 const ok=tx.valid_contract!==false&&Boolean(payeeOutput);
 const after=await fetchBalance(payer.address,{projectId}).catch(()=>null);
 journal.update({phase:ok?'confirmed':'verification_failed',verifiedAt:new Date().toISOString(),verification,payerBalanceAfter:after?.lovelace});
 process.stdout.write(json({phase:journal.state.phase,txHash,verification,journal:journal.path})+'\n');
 if(!ok)throw new Error(`Tx ${txHash} is on chain but the payee output check failed. Inspect ${journal.path}.`);
}

export async function main(argv){
 if(!argv.includes(CONFIRM_FLAG))throw new Error(`Refusing to run: this sends ${formatAda(PRICE_LOVELACE)} tADA on Preprod. Re-run with ${CONFIRM_FLAG} only after user approval.`);
 await run();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
