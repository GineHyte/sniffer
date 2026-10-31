// Main Sniffer intake API (Task 26, plan §2, port 21951).
//   POST /v1/invoices   behind x402 (customer pays INTAKE_PRICE_LOVELACE to INTAKE_PAY_TO), body {xml} as JSON
//                       (same shape as Rust POST /v1/initial-check) or raw application/xml. 202 → {case_id, status_url}.
//   GET  /v1/cases/{id} public status view (no raw invoice data).
//   GET  /health
// One paid resource and one case per XML (SHA-256). The case runs asynchronously; see main/orchestrate.mjs.
// Start: node --env-file=.env main/api.mjs --confirm-live-payments
import {createServer} from 'node:http';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {lovelaceString} from '../x402/pay.mjs';
import {INVESTIGATOR_ROLES} from '../investigator/contract.mjs';
import {createCaseStore,intakeIds,CASE_ID_RE,TERMINAL_STATUSES} from './case-store.mjs';
import {runCase,caseView,DEFAULT_INVESTIGATION_TIMEOUT_MS,DEFAULT_POLL_MS,DEFAULT_LLM_TIMEOUT_MS} from './orchestrate.mjs';
import {orgArgs} from './sokosumi-tasks.mjs';

export const CONFIRM_FLAG='--confirm-live-payments';
export const DEFAULT_PORT=21951;
export const DEFAULT_MAX_XML_BYTES=500_000;
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ADDRESS_RE=/^addr_test1[0-9a-z]{20,}$/;

const positiveInt=(env,name,fallback)=>{
 const raw=env[name]?.trim();
 if(!raw)return fallback;
 if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Error(`${name} must be a positive integer`);
 return Number(raw);
};
const required=(env,name)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is not set`);return value;};
const address=(env,name)=>{const value=required(env,name);if(!ADDRESS_RE.test(value))throw new Error(`${name} must be a Preprod (addr_test1…) address`);return value;};
const httpUrl=(env,name)=>{const value=required(env,name);if(!/^https?:\/\/[^\s]+$/.test(value))throw new Error(`${name} must be an http(s) URL`);return value.replace(/\/+$/,'');};
const singleId=(env,name)=>{const value=required(env,name);if(/\s/.test(value))throw new Error(`${name} must be a single ID`);return value;};

/** Reads and validates the Main configuration. Never reads secrets: tokens and mnemonics are loaded by their own modules. */
export function loadConfig(env=process.env){
 const investigators={};
 for(const role of INVESTIGATOR_ROLES){
  const key=role.toUpperCase();
  investigators[role]={coworkerId:singleId(env,`COWORKER_ID_${key}`),url:httpUrl(env,`INVESTIGATOR_${key}_URL`),payTo:address(env,`INVESTIGATOR_${key}_PAY_TO`)};
 }
 return {
  host:env.MAIN_HOST?.trim()||'127.0.0.1',
  port:positiveInt(env,'MAIN_PORT',DEFAULT_PORT),
  stateDir:env.MAIN_STATE_DIR?.trim()||join(ROOT,'.local','main'),
  maxXmlBytes:positiveInt(env,'MAX_XML_BYTES',DEFAULT_MAX_XML_BYTES),
  intake:{priceLovelace:lovelaceString(required(env,'INTAKE_PRICE_LOVELACE'),'INTAKE_PRICE_LOVELACE'),payTo:address(env,'INTAKE_PAY_TO')},
  investigators,
  investigatorPriceLovelace:lovelaceString(required(env,'INVESTIGATOR_PRICE_LOVELACE'),'INVESTIGATOR_PRICE_LOVELACE'),
  investigationTimeoutMs:positiveInt(env,'INVESTIGATION_TIMEOUT_MS',DEFAULT_INVESTIGATION_TIMEOUT_MS),
  pollMs:positiveInt(env,'INVESTIGATION_POLL_MS',DEFAULT_POLL_MS),
  llmTimeoutMs:positiveInt(env,'MAIN_LLM_TIMEOUT_MS',DEFAULT_LLM_TIMEOUT_MS),
  taskArgs:orgArgs(env.SOKOSUMI_ORGANIZATION_SLUG),
  payerWallet:env.MAIN_PAYER_WALLET?.trim()||'main-payer',
  eveUrl:env.MAIN_EVE_URL?.trim()||env.EVE_URL?.trim()||undefined,
 };
}

/** Runs each case at most once at a time in this process. */
export function createCaseRunner(deps,{run=runCase}={}){
 const running=new Map();
 function start(caseId){
  if(running.has(caseId))return running.get(caseId);
  const promise=run(caseId,deps).catch(error=>{deps.log?.(`case=${caseId} event=runner_error error=${String(error?.message).slice(0,200)}`);}).finally(()=>running.delete(caseId));
  running.set(caseId,promise);
  return promise;
 }
 function resumeAll(){
  const started=[];
  for(const caseId of deps.store.list()){
   let state;
   try{state=deps.store.read(caseId);}catch(error){deps.log?.(`case=${caseId} event=journal_unreadable`);continue;}
   if(state&&!TERMINAL_STATUSES.has(state.status))started.push(start(caseId));
  }
  return Promise.all(started);
 }
 return {start,resumeAll,running};
}

class HttpError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}

function send(res,status,body){
 if(res.headersSent)return;
 res.statusCode=status;
 res.setHeader('content-type','application/json');
 res.setHeader('cache-control','no-store');
 res.end(JSON.stringify(body));
}

async function readBody(req,limit){
 const chunks=[];let size=0;
 for await(const chunk of req){
  size+=chunk.length;
  if(size>limit)throw new HttpError(413,'payload_too_large');
  chunks.push(chunk);
 }
 return Buffer.concat(chunks);
}

function parseIntake(req,body,maxXmlBytes){
 const type=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
 let xml;
 if(type==='application/json'){
  let value;
  try{value=JSON.parse(body.toString('utf8'));}catch{throw new HttpError(400,'invalid_request');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='xml')||typeof value.xml!=='string')throw new HttpError(400,'invalid_request');
  xml=value.xml;
 }else if(type==='application/xml'||type==='text/xml'){
  try{xml=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new HttpError(400,'invalid_request');}
 }else throw new HttpError(415,'unsupported_media_type');
 if(!xml.trim())throw new HttpError(400,'invalid_request');
 if(Buffer.byteLength(xml,'utf8')>maxXmlBytes)throw new HttpError(413,'xml_too_large');
 return xml;
}

/**
 * HTTP handler for the intake API.
 * @param {object} options {config, store, gate, runner, now, log}. `gate` is an x402Gate whose resourceId reads req.snifferResourceId.
 */
export function createMainApi({config,store,gate,runner,now=()=>new Date(),log=()=>{}}){
 async function intake(req,res){
  const xml=parseIntake(req,await readBody(req,6*config.maxXmlBytes+4096),config.maxXmlBytes);
  const ids=intakeIds(xml);
  req.snifferResourceId=ids.resourceId;
  const paid=await gate(req,res);
  if(!paid)return; // the gate already answered (402 payment required, 409 replay, …)
  let state=store.read(ids.caseId);
  if(!state){
   state=store.create({caseId:ids.caseId,xml,intake:{resource_id:ids.resourceId,xml_sha256:ids.xmlSha256,tx_hash:paid.txHash,paid_at:now().toISOString()},now:now()});
   log(`case=${ids.caseId} event=accepted tx_hash=${paid.txHash}`);
  }
  runner.start(ids.caseId);
  send(res,202,{case_id:ids.caseId,status:state.status,status_url:`/v1/cases/${ids.caseId}`,payment_tx_hash:paid.txHash});
 }
 return async function handler(req,res){
  try{
   const url=new URL(req.url??'/','http://localhost');
   if(url.pathname==='/health'){if(req.method!=='GET')throw new HttpError(405,'method_not_allowed');return send(res,200,{status:'ok'});}
   if(url.pathname==='/v1/invoices'){if(req.method!=='POST')throw new HttpError(405,'method_not_allowed');return await intake(req,res);}
   const match=/^\/v1\/cases\/([^/]+)$/.exec(url.pathname);
   if(match){
    if(req.method!=='GET')throw new HttpError(405,'method_not_allowed');
    const caseId=match[1];
    const state=CASE_ID_RE.test(caseId)?store.read(caseId):null;
    if(!state)throw new HttpError(404,'not_found');
    return send(res,200,caseView(state));
   }
   throw new HttpError(404,'not_found');
  }catch(error){
   if(error instanceof HttpError)return send(res,error.status,{error:error.code});
   log(`event=api_error error=${String(error?.message).slice(0,200)}`);
   send(res,500,{error:'internal_error'});
  }
 };
}

const log=line=>console.error(`[main] ${line}`);

async function main(argv){
 if(!argv.includes(CONFIRM_FLAG))throw new Error(`Refusing to start without ${CONFIRM_FLAG}. This API pays investigators and suppliers with real Preprod tADA.`);
 const config=loadConfig();
 const [{x402Gate},{createInProcessFacilitator,blockfrostProvider},{readWallet,NETWORK},{toClientCardanoSigner},{payOnce},{sokosumi},client,{Client},payoutModule,{createSnifferClient},{loadCustomerTexts}]=await Promise.all([
  import('../x402/gate.mjs'),import('../x402/facilitator.mjs'),import('../x402/wallets.mjs'),import('@x402/cardano'),import('../x402/pay.mjs'),
  import('../sokosumi-cli.mjs'),import('../client.mjs'),import('eve/client'),import('../payout/transfer.mjs'),import('./backend.mjs'),import('./decide.mjs')]);
 const store=createCaseStore(config.stateDir);
 const gate=x402Gate({priceLovelace:config.intake.priceLovelace,payTo:config.intake.payTo,facilitator:createInProcessFacilitator(),
  resourceId:req=>req.snifferResourceId,journalPath:join(config.stateDir,'intake-gate.json'),description:'Sniffer invoice check',onError:error=>log(`event=gate_error error=${String(error?.message).slice(0,200)}`)});
 const wallet=readWallet(config.payerWallet);
 const payer=toClientCardanoSigner({mnemonic:wallet.mnemonic,network:NETWORK,provider:blockfrostProvider(process.env.BLOCKFROST_API_KEY_PREPROD)});
 const eve=new Client({host:config.eveUrl});
 const payoutBackend=payoutModule.createBackendClient();
 const {mnemonic,accountIndex}=payoutModule.loadPayoutSecrets();
 const payoutSigner=payoutModule.createEvolutionSigner({mnemonic,accountIndex});
 const deps={
  config,store,log,
  backend:createSnifferClient(),
  sokosumi:args=>sokosumi(args),
  payOnce,payer,
  answerReport:(role,input,journal,deadline)=>client.answerReport(role,input,journal,deadline,{client:eve}),
  validateReport:client.validateReport,
  runPayout:({checkId})=>payoutModule.runPayout({checkId,backend:payoutBackend,signer:payoutSigner}),
  customerTexts:loadCustomerTexts(),
 };
 const runner=createCaseRunner(deps);
 const server=createServer(createMainApi({config,store,gate,runner,log}));
 await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolveListen);});
 log(`listening on http://${config.host}:${config.port}`);
 runner.resumeAll();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${String(error?.message)}\n`);process.exitCode=1;});
}
