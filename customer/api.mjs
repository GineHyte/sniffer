// Customer gateway for the upload frontend (frontend/, port 21952). The browser talks only to this server (via the Next.js
// rewrite /api/* → here); it never sees a wallet, a token or the Main API directly.
//   GET  /api/config           price, network, paying wallet name, Main reachability, mode (live|mock)
//   POST /api/invoices         body {xml}. Pays the Main intake (x402) from the server demo wallet with payOnce, exactly like
//                              `npm run demo` (same journal dir, same key intake-<case_id>), so one XML is never paid twice.
//                              An XML whose case already exists is not paid again. 503 too_many_unconfirmed_intakes passes
//                              through (no payment signed); the frontend queue waits and retries.
//   GET  /api/cases/{case_id}  Main case view + the fired criteria/reducers of the backend check (Bearer token stays here).
// Live start (pays real Preprod tADA per invoice): npm run customer -- --confirm-live-payments
// Mock start (no Main, no wallet, no payment; scripted cases from customer/mock.mjs): npm run customer -- --mock
import {createServer} from 'node:http';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {intakeIds,CASE_ID_RE} from '../main/case-store.mjs';

export const CONFIRM_FLAG='--confirm-live-payments';
export const MOCK_FLAG='--mock';
export const DEFAULT_PORT=21952;
export const DEFAULT_MAX_XML_BYTES=500_000;
export const DEFAULT_WALLET='payer';
export const NETWORK='cardano:preprod';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const LOVELACE_RE=/^[1-9][0-9]*$/;
const TX_HASH_RE=/^[0-9a-f]{64}$/;

export class HttpError extends Error{constructor(status,code,message=code){super(message);this.status=status;this.code=code;}}

const positiveInt=(env,name,fallback)=>{
 const raw=env[name]?.trim();
 if(!raw)return fallback;
 if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Error(`${name} must be a positive integer`);
 return Number(raw);
};

/** Reads the gateway configuration. Never reads secrets: the mnemonic and the backend token are loaded by their own modules. */
export function loadConfig(env=process.env,{mock=false}={}){
 const price=env.INTAKE_PRICE_LOVELACE?.trim()||(mock?'1000000':'');
 if(!LOVELACE_RE.test(price))throw new Error('INTAKE_PRICE_LOVELACE is not set. Run with: npm run customer (loads .local/live.env).');
 return {
  mode:mock?'mock':'live',
  host:env.CUSTOMER_HOST?.trim()||'127.0.0.1',
  port:positiveInt(env,'CUSTOMER_PORT',DEFAULT_PORT),
  mainUrl:(env.MAIN_URL?.trim()||`http://127.0.0.1:${positiveInt(env,'MAIN_PORT',21951)}`).replace(/\/+$/,''),
  maxXmlBytes:positiveInt(env,'MAX_XML_BYTES',DEFAULT_MAX_XML_BYTES),
  priceLovelace:price,
  wallet:env.CUSTOMER_WALLET?.trim()||DEFAULT_WALLET,
  journalDir:env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo'),
 };
}

/** True when the first element is a CII CrossIndustryInvoice or a UBL Invoice (any prefix). Cheap guard before paying. */
export function looksLikeEInvoice(xml){
 const body=xml.replace(/^﻿/,'').replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g,'').trimStart();
 return /^<(?:[A-Za-z_][\w.-]*:)?(?:CrossIndustryInvoice|Invoice)[\s/>]/.test(body);
}

/** Customer-facing part of a backend CheckResult: score, band and every fired criterion and reducer with its evidence. */
export function checkProjection(result){
 const s=result?.summary;
 if(!s)return null;
 const pick=list=>(Array.isArray(list)?list:[]).map(({id,name,points,evidence,agent})=>({id,name,points,evidence,...(agent?{agent}:{})}));
 return {check_id:result.check_id,checked_at:result.checked_at,band:s.band,decision:s.decision,risk_score:s.risk_score,ko_triggered:s.ko_triggered,
  checks_incomplete:s.checks_incomplete??[],criteria:pick(result.criteria),reducers:pick(result.reducers)};
}

function send(res,status,body){
 if(res.headersSent)return;
 res.statusCode=status;
 res.setHeader('content-type','application/json');
 res.setHeader('cache-control','no-store');
 res.end(JSON.stringify(body));
}

async function readJson(req,limit){
 const type=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')throw new HttpError(415,'unsupported_media_type');
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>limit)throw new HttpError(413,'payload_too_large');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'invalid_request');}
}

/**
 * HTTP handler of the customer gateway.
 * @param {object} options {config, main:{health(),getCase(id)→{status,body}}, pay:(xml,caseId)→{caseId,txHash}, backend:{getCheck(id)}, log}
 */
export function createCustomerApi({config,main,pay,backend,log=()=>{}}){
 const checks=new Map(); // check_id → projection; a stored check result never changes
 async function submit(req,res){
  const value=await readJson(req,6*config.maxXmlBytes+4096);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='xml')||typeof value.xml!=='string'||!value.xml.trim())
   throw new HttpError(400,'invalid_request');
  const xml=value.xml;
  if(Buffer.byteLength(xml,'utf8')>config.maxXmlBytes)throw new HttpError(413,'xml_too_large');
  if(!looksLikeEInvoice(xml))throw new HttpError(422,'not_an_einvoice');
  const {caseId}=intakeIds(xml);
  const existing=await main.getCase(caseId);
  if(existing.status===200)return send(res,200,{case_id:caseId,existing:true,payment_tx_hash:existing.body?.intake?.tx_hash??null});
  const paid=await pay(xml,caseId);
  log(`case=${paid.caseId} event=intake_paid tx_hash=${paid.txHash??'-'}`);
  send(res,202,{case_id:paid.caseId,existing:false,payment_tx_hash:paid.txHash??null});
 }
 async function caseWithCheck(caseId){
  const view=await main.getCase(caseId);
  if(view.status===404)throw new HttpError(404,'not_found');
  if(view.status!==200)throw new HttpError(502,'main_unavailable');
  const checkId=view.body?.check_id;
  let check=checkId?checks.get(checkId)??null:null,checkError=null;
  if(checkId&&!check){
   try{check=checkProjection((await backend.getCheck(checkId))?.result);if(check)checks.set(checkId,check);}
   catch(error){checkError=error?.code??'backend_unavailable';log(`case=${caseId} event=check_unavailable code=${checkError}`);}
  }
  return {case:view.body,check,check_error:checkError};
 }
 return async function handler(req,res){
  try{
   const url=new URL(req.url??'/','http://localhost');
   if(url.pathname==='/api/config'){
    if(req.method!=='GET')throw new HttpError(405,'method_not_allowed');
    return send(res,200,{mode:config.mode,network:NETWORK,price_lovelace:config.priceLovelace,wallet:config.wallet,max_xml_bytes:config.maxXmlBytes,
     main_ok:await main.health().catch(()=>false)});
   }
   if(url.pathname==='/api/invoices'){if(req.method!=='POST')throw new HttpError(405,'method_not_allowed');return await submit(req,res);}
   const match=/^\/api\/cases\/([^/]+)$/.exec(url.pathname);
   if(match){
    if(req.method!=='GET')throw new HttpError(405,'method_not_allowed');
    if(!CASE_ID_RE.test(match[1]))throw new HttpError(404,'not_found');
    return send(res,200,await caseWithCheck(match[1]));
   }
   throw new HttpError(404,'not_found');
  }catch(error){
   if(error instanceof HttpError)return send(res,error.status,{error:error.code,...(error.message!==error.code?{message:error.message}:{})});
   log(`event=api_error error=${String(error?.message).slice(0,200)}`);
   send(res,500,{error:'internal_error'});
  }
 };
}

/** Main API client: health and the public case view. Network errors answer {status:0}. */
export function mainClient(baseUrl,{fetchImpl=fetch}={}){
 const get=async(path,timeoutMs)=>{
  try{
   const response=await fetchImpl(`${baseUrl}${path}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
   let body=null;try{body=await response.json();}catch{}
   return {status:response.status,body};
  }catch{return {status:0,body:null};}
 };
 return {health:async()=>(await get('/health',3000)).status===200,getCase:id=>get(`/v1/cases/${id}`,10_000)};
}

/**
 * Live payer: payOnce from the demo wallet to Main's intake, sharing `npm run demo`'s journal (DEMO_STATE_DIR or .local/demo),
 * so the inputs of earlier demo payments are never signed again. Maps a refused intake to an HttpError without paying.
 */
export async function livePayer(config,env=process.env){
 const [{payOnce,readPayJournal,payJournalPath},{readWallet,fetchBalance,formatAda,NETWORK:walletNetwork},{blockfrostProvider},{toClientCardanoSigner},{blockfrostChain},
  {intakeRefusal,caseIdFromJournal,payKeyFor,PAYER_MARGIN_LOVELACE}]=await Promise.all([
  import('../x402/pay.mjs'),import('../x402/wallets.mjs'),import('../x402/facilitator.mjs'),import('@x402/cardano'),import('../x402/chain.mjs'),import('../scripts/demo-case.mjs')]);
 const payTo=env.INTAKE_PAY_TO?.trim();
 if(!payTo||!/^addr_test1[0-9a-z]{20,}$/.test(payTo))throw new Error('INTAKE_PAY_TO is not set to a Preprod address. Run with: npm run customer (loads .local/live.env).');
 const projectId=env.BLOCKFROST_API_KEY_PREPROD;
 const wallet=readWallet(config.wallet);
 const signer=toClientCardanoSigner({mnemonic:wallet.mnemonic,network:walletNetwork,provider:blockfrostProvider(projectId)});
 if(signer.getAddress()!==wallet.address)throw new Error(`Signer address does not match wallet ${config.wallet}.`);
 const chain=blockfrostChain({projectId});
 return async(xml,caseId)=>{
  const key=payKeyFor(caseId);
  const path=payJournalPath(config.journalDir,key);
  if(!readPayJournal(path)){
   const balance=await fetchBalance(wallet.address,{projectId});
   const need=BigInt(config.priceLovelace)+PAYER_MARGIN_LOVELACE;
   if(!balance.used||balance.lovelace<need)
    throw new HttpError(409,'payer_balance_too_low',`Wallet ${config.wallet} has ${formatAda(balance.lovelace)} tADA; one check needs at least ${formatAda(need)} tADA.`);
  }
  let journal;
  try{
   journal=await payOnce({url:`${config.mainUrl}/v1/invoices`,key,journalDir:config.journalDir,signer,payTo,maxLovelace:config.priceLovelace,chain,
    init:{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({xml})}});
  }catch(error){
   let after=null;try{after=readPayJournal(path);}catch{}
   if(intakeRefusal(after))throw new HttpError(503,'too_many_unconfirmed_intakes');
   if(after?.phase==='failed_before_signing'&&after.response?.status>=400&&after.response.status<500){
    let code='intake_refused';try{code=JSON.parse(after.response.body).error??code;}catch{}
    throw new HttpError(422,code,`Main refused the invoice (HTTP ${after.response.status} ${code}); no payment was signed.`);
   }
   throw new HttpError(502,'payment_failed',String(error?.message??error).slice(0,600));
  }
  const txHash=TX_HASH_RE.test(journal.txHash??'')?journal.txHash:null;
  return {caseId:caseIdFromJournal(journal)??caseId,txHash};
 };
}

const log=line=>console.error(`[customer] ${line}`);

async function main(argv){
 const mock=argv.includes(MOCK_FLAG);
 if(!mock&&!argv.includes(CONFIRM_FLAG))
  throw new Error(`Refusing to start without ${CONFIRM_FLAG}: every new invoice is paid with real Preprod tADA. Use ${MOCK_FLAG} for a run without payments.`);
 const config=loadConfig(process.env,{mock});
 let deps;
 if(mock){
  const {createMockDeps}=await import('./mock.mjs');
  deps=createMockDeps();
 }else{
  const {createSnifferClient}=await import('../main/backend.mjs');
  deps={main:mainClient(config.mainUrl),pay:await livePayer(config),backend:createSnifferClient()};
 }
 const server=createServer(createCustomerApi({config,...deps,log}));
 await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolveListen);});
 log(`listening on http://${config.host}:${config.port} mode=${config.mode} main=${config.mainUrl} wallet=${config.wallet}`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
