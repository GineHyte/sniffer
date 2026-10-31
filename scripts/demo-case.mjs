// Test customer for one paid end-to-end Sniffer case on Cardano Preprod (T29).
// Pays the Main intake (POST /v1/invoices, x402 gate) from the `payer` wallet with payOnce, then polls
// GET /v1/cases/{id} until the case is completed, failed or needs inspection, and prints the decision.
// Run only with explicit user approval (Main must be running: npm run main -- --confirm-live-payments):
//   npm run demo -- --confirm-live-payment [--fixture docs/fixtures/f1.xml] [--invoice-number RE-2026-0413] [--recipient-wallet payee] [--new-supplier]
// Poll an existing case without paying: npm run demo -- --case case-<32 hex>
// One payment per submitted XML: the payOnce key is derived from the XML hash, so a rerun returns the earlier
// payment and only polls. Use --invoice-number for a new case (the backend rejects an exact duplicate with KO-3).
// --new-supplier swaps the seller (BT-31 VAT, BT-27 name, BT-13 open order) for the first VIES-mock-valid VAT the backend has no
// invoice for (GET /v1/suppliers/{supplier_hash}/history = 404), so S-9 fires again and the case reaches the investigators.
import {createHmac} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {intakeIds,CASE_ID_RE,TERMINAL_STATUSES} from '../main/case-store.mjs';

export const CONFIRM_FLAG='--confirm-live-payment';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const DEFAULT_FIXTURE='docs/fixtures/f1.xml';
export const DEFAULT_WALLET='payer';
export const DEFAULT_TIMEOUT_MS=45*60_000; // investigation 15 min + Main LLM 5 min + payout confirm 10 min + payments
export const DEFAULT_POLL_MS=15_000;
export const PAYER_MARGIN_LOVELACE=2_000_000n; // fee + min-UTxO change above the intake price
const INVOICE_NUMBER_RE=/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
const ADDRESS_RE=/^addr_test1[0-9a-z]{20,}$/;
const EXPLORER='https://preprod.cardanoscan.io/transaction/';
const VAT_RE=/^[A-Z]{2}[A-Z0-9]{2,14}$/; // backend parse.rs VAT_RE on the normalized value
const SUPPLIER_NAME_RE=/^[^\u0000-\u001f\u007f<>]{1,100}$/; // & is escaped
export const VIES_MOCK_FILE='backend/data/vies-mock.json';
export const OPEN_ORDERS_FILE='backend/data/open-orders.json';
export const SUPPLIER_NAMES=Object.freeze({DE111111111:'Alpha Consulting GmbH',DE222222222:'Beta Beratung GmbH',DE333333333:'Gamma Services GmbH',DE555555555:'Epsilon Technik GmbH'});

export const USAGE=`Usage:
  npm run demo -- ${CONFIRM_FLAG} [options]   pay the intake once and follow the case
  npm run demo -- --case <case_id>             follow an existing case (no payment)
Options:
  --fixture <path>            invoice XML (default ${DEFAULT_FIXTURE})
  --invoice-number <id>       replace the invoice number (BT-1 and payment reference) for a fresh case
  --recipient-wallet <name>   replace the payment address (BT-84) with this x402 wallet's address
  --new-supplier              replace the seller with the first VIES-mock-valid VAT the backend has no invoice for (S-9 fires again)
  --supplier-vat <VAT>        replace the seller VAT ID (BT-31) with this one (supplier identity = VAT)
  --supplier-name <name>      replace the seller name (BT-27); default for a new VAT: a name per mock VAT
  --wallet <name>             paying x402 wallet (default ${DEFAULT_WALLET})
  --main-url <url>            Main API (default http://127.0.0.1:$MAIN_PORT or :21951)
  --timeout-ms <n>            polling timeout (default ${DEFAULT_TIMEOUT_MS})
  --poll-ms <n>               polling interval (default ${DEFAULT_POLL_MS})`;

const VALUE_FLAGS={'--fixture':'fixture','--invoice-number':'invoiceNumber','--recipient-wallet':'recipientWallet','--wallet':'wallet','--main-url':'mainUrl',
 '--timeout-ms':'timeoutMs','--poll-ms':'pollMs','--case':'caseId','--supplier-vat':'supplierVat','--supplier-name':'supplierName'};

/** Parses CLI arguments. Throws on unknown flags, missing values and invalid values. */
export function parseArgs(argv,env={}){
 const options={confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:DEFAULT_WALLET,
  mainUrl:`http://127.0.0.1:${env.MAIN_PORT?.trim()||21951}`,timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null,
  newSupplier:false,supplierVat:null,supplierName:null};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg===CONFIRM_FLAG){options.confirm=true;continue;}
  if(arg==='--help'||arg==='-h'){options.help=true;continue;}
  if(arg==='--new-supplier'){options.newSupplier=true;continue;}
  const key=VALUE_FLAGS[arg];
  if(!key)throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  const value=argv[++i];
  if(value===undefined||value.startsWith('--'))throw new Error(`${arg} needs a value.`);
  options[key]=value;
 }
 for(const key of ['timeoutMs','pollMs']){
  const value=String(options[key]);
  if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(`--${key==='timeoutMs'?'timeout-ms':'poll-ms'} must be a positive integer.`);
  options[key]=Number(value);
 }
 if(options.caseId!==null&&!CASE_ID_RE.test(options.caseId))throw new Error('--case must be case-<32 hex>.');
 if(options.invoiceNumber!==null&&!INVOICE_NUMBER_RE.test(options.invoiceNumber))throw new Error('--invoice-number must be 1-64 characters [A-Za-z0-9._/-].');
 for(const key of ['wallet','recipientWallet'])if(options[key]!==null&&!/^[a-z][a-z0-9-]{0,31}$/.test(options[key]))throw new Error(`--${key==='wallet'?'wallet':'recipient-wallet'} must be an x402 wallet name.`);
 if(options.supplierVat!==null&&!VAT_RE.test(options.supplierVat))throw new Error('--supplier-vat must be an uppercase VAT ID like DE222222222 (country prefix + 2-14 A-Z0-9).');
 if(options.supplierName!==null&&!SUPPLIER_NAME_RE.test(options.supplierName))throw new Error('--supplier-name must be 1-100 characters without control characters, < or >.');
 if(options.newSupplier&&options.supplierVat!==null)throw new Error('Use either --new-supplier or --supplier-vat, not both.');
 if(!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(options.mainUrl))throw new Error('--main-url must be an http(s) URL.');
 options.mainUrl=options.mainUrl.replace(/\/+$/,'');
 return options;
}

/** The pay path needs the explicit flag; following an existing case does not pay and needs none. */
export function assertConfirmed(options){
 if(options.caseId||options.confirm)return;
 throw new Error(`Refusing to run: this pays the Sniffer intake with real Preprod tADA and starts a case that pays 3 investigators and possibly a supplier. Re-run with ${CONFIRM_FLAG} only after user approval.`);
}

/**
 * Returns the XML to submit: the fixture, optionally with a new invoice number, payment address, seller VAT ID (BT-31),
 * seller name (BT-27) and order reference (BT-13). Pure.
 */
export function prepareXml(xml,{invoiceNumber=null,recipientAddress=null,supplierVat=null,supplierName=null,orderReference=null}={}){
 if(typeof xml!=='string'||!xml.includes('<rsm:CrossIndustryInvoice'))throw new Error('Fixture is not a CII invoice.');
 let out=xml;
 if(invoiceNumber!==null){
  if(!INVOICE_NUMBER_RE.test(invoiceNumber))throw new Error('Invalid invoice number.');
  const match=/<rsm:ExchangedDocument>\s*<ram:ID>([^<]+)<\/ram:ID>/.exec(out);
  if(!match)throw new Error('Fixture has no invoice number (BT-1).');
  const old=match[1];
  out=out.split(`<ram:ID>${old}</ram:ID>`).join(`<ram:ID>${invoiceNumber}</ram:ID>`)
   .split(`<ram:PaymentReference>${old}</ram:PaymentReference>`).join(`<ram:PaymentReference>${invoiceNumber}</ram:PaymentReference>`);
 }
 if(recipientAddress!==null){
  if(!ADDRESS_RE.test(recipientAddress))throw new Error('Recipient must be a Preprod addr_test1… address.');
  const re=/(<ram:PayeePartyCreditorFinancialAccount>\s*<ram:ProprietaryID>)[^<]*(<\/ram:ProprietaryID>)/;
  if(!re.test(out))throw new Error('Fixture has no payment address (BT-84).');
  out=out.replace(re,`$1${recipientAddress}$2`);
 }
 if(supplierVat!==null||supplierName!==null){
  const seller=/<ram:SellerTradeParty>[\s\S]*?<\/ram:SellerTradeParty>/.exec(out);
  if(!seller)throw new Error('Fixture has no seller (SellerTradeParty).');
  let block=seller[0];
  if(supplierVat!==null){
   if(!VAT_RE.test(supplierVat))throw new Error('Invalid supplier VAT ID.');
   const re=/(<ram:SpecifiedTaxRegistration>\s*<ram:ID schemeID="VA">)[^<]*(<\/ram:ID>)/;
   if(!re.test(block))throw new Error('Fixture has no seller VAT ID (BT-31).');
   block=block.replace(re,(_,open,close)=>`${open}${supplierVat}${close}`);
  }
  if(supplierName!==null){
   if(!SUPPLIER_NAME_RE.test(supplierName))throw new Error('Invalid supplier name.');
   const re=/(<ram:SellerTradeParty>\s*<ram:Name>)[^<]*(<\/ram:Name>)/;
   if(!re.test(block))throw new Error('Fixture has no seller name (BT-27).');
   block=block.replace(re,(_,open,close)=>`${open}${escapeXml(supplierName)}${close}`);
  }
  out=out.slice(0,seller.index)+block+out.slice(seller.index+seller[0].length);
 }
 if(orderReference!==null){
  if(!INVOICE_NUMBER_RE.test(orderReference))throw new Error('Invalid order reference.');
  const re=/(<ram:BuyerOrderReferencedDocument>\s*<ram:IssuerAssignedID>)[^<]*(<\/ram:IssuerAssignedID>)/;
  if(!re.test(out))throw new Error('Fixture has no order reference (BT-13).');
  out=out.replace(re,(_,open,close)=>`${open}${orderReference}${close}`);
 }
 return out;
}

const escapeXml=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);

/** Backend normalize::vat: uppercase, keep A-Z0-9, GR -> EL. */
export function normalizeVat(value){
 const v=String(value).toUpperCase().replace(/[^A-Z0-9]/g,'');
 return v.startsWith('GR')?`EL${v.slice(2)}`:v;
}

/** Backend hashing::supplier_hash: "hmac:" + hex HMAC-SHA256(hex-decoded SNIFFER_HMAC_KEY, "supplier:" + normalized VAT). */
export function supplierHash(keyHex,vat){
 if(typeof keyHex!=='string'||keyHex.length<64||!/^(?:[0-9a-fA-F]{2})+$/.test(keyHex))throw new Error('SNIFFER_HMAC_KEY must be at least 64 hex characters.');
 return `hmac:${createHmac('sha256',Buffer.from(keyHex,'hex')).update(`supplier:${normalizeVat(vat)}`,'utf8').digest('hex')}`;
}

/** Seller VAT ID (BT-31) of a CII invoice, or null. */
export function sellerVat(xml){
 const seller=/<ram:SellerTradeParty>[\s\S]*?<\/ram:SellerTradeParty>/.exec(xml)?.[0]??'';
 return /<ram:SpecifiedTaxRegistration>\s*<ram:ID schemeID="VA">([^<]+)<\/ram:ID>/.exec(seller)?.[1]?.trim()??null;
}

/** VAT IDs the VIES mock marks valid, in file order. */
export const validMockVats=mock=>Object.entries(mock??{}).filter(([,valid])=>valid===true).map(([vat])=>vat);

/** Open order id of this supplier in open-orders.json, or null. */
export const openOrderFor=(vat,orders)=>(orders??[]).find(order=>normalizeVat(order.supplier_vat_id)===normalizeVat(vat))?.order_id??null;

/** XML rewrite options for a seller VAT: the VAT, a name (given or per mock VAT) and its open order (keeps T-3, avoids I-8). */
export function supplierRewrite(vat,{name=null,orders=[]}={}){
 return {supplierVat:vat,supplierName:name??SUPPLIER_NAMES[vat]??`Lieferant ${vat} GmbH`,orderReference:openOrderFor(vat,orders)};
}

export const readRepoJson=file=>JSON.parse(readFileSync(join(ROOT,file),'utf8'));

/**
 * Picks the seller VAT for --new-supplier: the first candidate whose earlier demo case is still open (resume, no new payment),
 * else the first one the backend has no invoice for. Skips VATs with backend history or a finished earlier demo case.
 * @param {object} p {candidates:string[], caseIdFor:(vat)=>string, lookups:{journalExists(caseId), caseStatus(caseId), history(vat)->{status,body}}}
 * @returns {Promise<{vat:string,caseId:string,resume:boolean,skipped:{vat:string,reason:string}[]}>}
 */
export async function pickFreshSupplier({candidates,caseIdFor,lookups}){
 const skipped=[];
 for(const vat of candidates){
  const caseId=caseIdFor(vat);
  if(await lookups.journalExists(caseId)){
   const status=await lookups.caseStatus(caseId);
   if(status&&TERMINAL_STATUSES.has(status)){skipped.push({vat,reason:`earlier demo case ${caseId} is ${status}`});continue;}
   return {vat,caseId,resume:true,skipped};
  }
  const history=await lookups.history(vat);
  if(history.status===404)return {vat,caseId,resume:false,skipped};
  if(history.status===200){skipped.push({vat,reason:`backend has invoices (approved_count ${history.body?.approved_count??'?'})`});continue;}
  throw new Error(`Supplier history for ${vat}: HTTP ${history.status||'none'}${history.status===401?' (SNIFFER_API_TOKEN rejected)':''}. Pass --supplier-vat <VAT> instead.`);
 }
 throw new Error(`No fresh supplier left: every VIES-mock-valid VAT (${candidates.join(', ')||'none'}) is used${skipped.length?` (${skipped.map(s=>`${s.vat}: ${s.reason}`).join('; ')})`:''}. Add a new valid VAT to ${VIES_MOCK_FILE}, rebuild the backend (npm run stack) and rerun, or pass --supplier-vat <VAT>.`);
}

/** Expected band for a seller, as far as the demo can know it (wallet history is not readable). fresh: true/false/null. */
export function expectedOutcome({vat,fresh,viesValid,openOrder}){
 if(viesValid===false)return `expect high: S-2 fires (+35), the VIES mock marks ${vat} invalid`;
 if(fresh===false)return `expect low: S-9 does not fire, ${vat} already has invoices in the backend; the case may auto-approve without investigators (use --new-supplier)`;
 const order=openOrder?'':`; I-8 fires (+8): BT-13 is not an open order of ${vat}`;
 if(fresh===null)return `supplier history of ${vat} unknown${order}`;
 return `expect medium: S-9 fires (+5)${order}. With a wallet the backend has not seen: I-2 + W-4 + S-9 -> score ${openOrder?20:38}. If the payment wallet was approved before, S-1 (+35) fires too (score >= 40, still medium unless the wallet also has a risk rejection)`;
}

/** Lines describing the resolved seller rewrite and the expected outcome. */
export function supplierLines(supplier){
 if(!supplier)return [];
 const lines=supplier.skipped.map(s=>`Skipping supplier ${s.vat}: ${s.reason}`);
 const {supplierVat,supplierName,orderReference}=supplier.rewrite;
 if(supplierVat===undefined){lines.push(`Seller name -> ${supplierName} (VAT unchanged: supplier history unchanged)`);return lines;}
 lines.push(`Supplier VAT ${supplierVat} (${supplierName})${orderReference?`, order ${orderReference}`:''}`);
 lines.push(supplier.resume?`Resuming the earlier demo case for ${supplierVat} (no new payment)`:expectedOutcome(supplier));
 return lines;
}

/** Backend supplier history and Main case status lookups for pickFreshSupplier. Reads only. */
export function supplierLookups(env,{mainUrl,journalDir}){
 const base=(env.SNIFFER_BASE_URL?.trim()||'http://127.0.0.1:8080').replace(/\/+$/,'');
 const token=env.SNIFFER_API_TOKEN?.trim();
 const key=env.SNIFFER_HMAC_KEY?.trim();
 return {
  journalExists:async caseId=>existsSync(join(journalDir,`pay-${payKeyFor(caseId)}.json`)),
  caseStatus:async caseId=>{try{const r=await getJson(`${mainUrl}/v1/cases/${caseId}`,{timeoutMs:5000});return r.status===200?r.body?.status??null:null;}catch{return null;}},
  history:async vat=>{
   if(!key||!token)throw new Error('SNIFFER_HMAC_KEY and SNIFFER_API_TOKEN are needed to read supplier history (npm run demo loads .local/sniffer-secrets.env). Pass --supplier-vat <VAT> instead.');
   try{
    const response=await fetch(`${base}/v1/suppliers/${encodeURIComponent(supplierHash(key,vat))}/history`,{headers:{authorization:`Bearer ${token}`,accept:'application/json'},signal:AbortSignal.timeout(10_000)});
    let body=null;try{body=await response.json();}catch{}
    return {status:response.status,body};
   }catch(error){return {status:0,error};}
  },
 };
}

/**
 * Resolves the seller rewrite for the options: --new-supplier picks a fresh VAT, --supplier-vat/--supplier-name use the given values.
 * Returns {rewrite, vat, fresh, viesValid, openOrder, resume, skipped} or null when the seller stays unchanged.
 * xmlFor(rewrite) builds the full XML (invoice number, recipient, seller) for a candidate.
 */
export async function resolveSupplier(options,{xmlFor,lookups,viesMock=readRepoJson(VIES_MOCK_FILE),orders=readRepoJson(OPEN_ORDERS_FILE)}){
 if(!options.newSupplier&&options.supplierVat===null&&options.supplierName===null)return null;
 if(options.newSupplier){
  const rewriteFor=vat=>supplierRewrite(vat,{name:options.supplierName,orders});
  const pick=await pickFreshSupplier({candidates:validMockVats(viesMock),caseIdFor:vat=>intakeIds(xmlFor(rewriteFor(vat))).caseId,lookups});
  const rewrite=rewriteFor(pick.vat);
  return {rewrite,vat:pick.vat,fresh:pick.resume?null:true,viesValid:true,openOrder:rewrite.orderReference,resume:pick.resume,skipped:pick.skipped};
 }
 if(options.supplierVat===null)return {rewrite:{supplierName:options.supplierName},vat:null,fresh:null,viesValid:null,openOrder:null,resume:false,skipped:[]};
 const rewrite=supplierRewrite(options.supplierVat,{name:options.supplierName,orders});
 let fresh=null;
 try{const history=await lookups.history(options.supplierVat);fresh=history.status===404?true:history.status===200?false:null;}catch{}
 const entry=viesMock[normalizeVat(options.supplierVat)];
 const viesValid=entry===true?true:entry==='error'?null:false; // the mock treats an unknown VAT as invalid
 return {rewrite,vat:options.supplierVat,fresh,viesValid,openOrder:rewrite.orderReference,resume:false,skipped:[]};
}

/** Due amount in EUR cents from the fixture (BT-115), or null. */
export function duePayableCents(xml){
 const match=/<ram:DuePayableAmount[^>]*>\s*([0-9]+)(?:\.([0-9]{1,2}))?\s*</.exec(xml);
 return match?BigInt(match[1])*100n+BigInt((match[2]??'0').padEnd(2,'0')):null;
}

/** Supplier payout in lovelace as the backend computes it: floor(amount_eur * ADA_PER_EUR * 1e6). */
export function payoutLovelace(cents,adaPerEur){
 if(cents===null||typeof adaPerEur!=='string'||!/^[0-9]+(\.[0-9]{1,6})?$/.test(adaPerEur.trim()))return null;
 const [whole,frac='']=adaPerEur.trim().split('.');
 const micro=BigInt(whole)*1_000_000n+BigInt(frac.padEnd(6,'0')); // ADA per EUR in micro-ADA (= lovelace per EUR)
 return cents*micro/100n;
}

export const payKeyFor=caseId=>`intake-${caseId}`;

/** case_id from the 202 body payOnce keeps in its journal. */
export function caseIdFromJournal(journal){
 try{const body=JSON.parse(journal?.response?.body??'');return typeof body?.case_id==='string'&&CASE_ID_RE.test(body.case_id)?body.case_id:null;}catch{return null;}
}

/**
 * Polls fetchCase(caseId) until a terminal status or the deadline. Network errors and 5xx are retried until the deadline;
 * 404 stops at once (the case is created before the 202, so it should always exist).
 * @param {object} options {caseId, fetchCase:(id)=>Promise<{status:number,body:any}>, timeoutMs, pollMs, clock:{now,sleep}, onUpdate}
 * @returns {Promise<{done:boolean,view:object|null,timedOut:boolean}>}
 */
export async function pollCase({caseId,fetchCase,timeoutMs,pollMs,clock,onUpdate=()=>{}}){
 const deadline=clock.now()+timeoutMs;
 let view=null;
 for(;;){
  let result;
  try{result=await fetchCase(caseId);}catch(error){result={status:0,error};}
  if(result.status===200&&result.body&&typeof result.body==='object'){
   view=result.body;
   onUpdate({type:'view',view});
   if(TERMINAL_STATUSES.has(view.status))return {done:true,view,timedOut:false};
  }else if(result.status===404){
   throw new Error(`Case ${caseId} not found at the Main API. Check --main-url and MAIN_STATE_DIR.`);
  }else onUpdate({type:'error',status:result.status,error:result.error});
  const now=clock.now();
  if(now>=deadline)return {done:false,view,timedOut:true};
  await clock.sleep(Math.max(1,Math.min(pollMs,deadline-now)));
 }
}

/** One status line per change (status, investigators, decision, payout). */
export function progressLine(view){
 const inv=view.investigators?Object.entries(view.investigators).map(([role,entry])=>`${role}:${entry.payment??'-'}/${entry.report??'-'}${entry.verdict?`(${entry.verdict})`:''}`).join(' '):'';
 return [`status=${view.status}`,view.band?`band=${view.band}`:'',view.risk_score!==null&&view.risk_score!==undefined?`score=${view.risk_score}`:'',inv,
  view.decision?`decision=${view.decision.decision}/${view.decision.final_decision}`:'',view.payout?`payout=${view.payout.phase}${view.payout.state?`/${view.payout.state}`:''}`:'',
  view.inspection?`inspection=${view.inspection.code}`:''].filter(Boolean).join(' ');
}

const systemClock={now:()=>Date.now(),sleep:ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms))};
const out=line=>process.stdout.write(`${line}\n`);

async function getJson(url,{timeoutMs=20_000}={}){
 const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
 let body=null;try{body=await response.json();}catch{}
 return {status:response.status,body};
}

async function follow(options,caseId){
 out(`Case ${caseId}: ${options.mainUrl}/v1/cases/${caseId}`);
 let last='';
 const result=await pollCase({caseId,timeoutMs:options.timeoutMs,pollMs:options.pollMs,clock:systemClock,
  fetchCase:id=>getJson(`${options.mainUrl}/v1/cases/${id}`),
  onUpdate:event=>{
   if(event.type==='view'){const line=progressLine(event.view);if(line!==last){out(`[${new Date().toISOString()}] ${line}`);last=line;}}
   else out(`[${new Date().toISOString()}] Main API not answering (HTTP ${event.status||'none'}); retrying`);
  }});
 if(result.view){
  out(JSON.stringify(result.view,null,1));
  for(const [role,entry] of Object.entries(result.view.investigators??{}))if(entry.payment_tx_hash)out(`${role} payment: ${EXPLORER}${entry.payment_tx_hash}`);
  if(result.view.payout?.tx_hash)out(`Supplier payout: ${EXPLORER}${result.view.payout.tx_hash}`);
 }
 if(result.timedOut)throw new Error(`Case ${caseId} is not finished after ${options.timeoutMs} ms. Follow it later with: npm run demo -- --case ${caseId}`);
 if(result.view.status!=='completed')throw new Error(`Case ${caseId} ended with status ${result.view.status}${result.view.inspection?` (${result.view.inspection.code})`:''}. Inspect .local/main/cases/${caseId}/case.json.`);
 out(`Decision: ${result.view.decision?.decision??'none'} (${result.view.decision?.final_decision??'-'}, decided by ${result.view.decision?.decided_by??'-'})`);
}

async function payIntake(options){
 const env=process.env;
 const [{payOnce,lovelaceString,readPayJournal,payJournalPath},{readWallet,walletAddress,fetchBalance,formatAda,NETWORK},{blockfrostProvider},{toClientCardanoSigner}]=await Promise.all([
  import('../x402/pay.mjs'),import('../x402/wallets.mjs'),import('../x402/facilitator.mjs'),import('@x402/cardano')]);
 const price=lovelaceString(env.INTAKE_PRICE_LOVELACE?.trim(),'INTAKE_PRICE_LOVELACE');
 const payTo=env.INTAKE_PAY_TO?.trim();
 if(!payTo||!ADDRESS_RE.test(payTo))throw new Error('INTAKE_PAY_TO is not set to a Preprod address. Run with: npm run demo (loads .local/live.env).');
 const projectId=env.BLOCKFROST_API_KEY_PREPROD;
 const raw=readFileSync(resolve(ROOT,options.fixture),'utf8');
 const base={invoiceNumber:options.invoiceNumber,recipientAddress:options.recipientWallet?walletAddress(options.recipientWallet):null};
 const xmlFor=rewrite=>prepareXml(raw,{...base,...rewrite});
 const journalDir=env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo');
 const supplier=await resolveSupplier(options,{xmlFor,lookups:supplierLookups(env,{mainUrl:options.mainUrl,journalDir})});
 for(const line of supplierLines(supplier))out(line);
 const xml=xmlFor(supplier?.rewrite??{});
 const {caseId}=intakeIds(xml);
 const key=payKeyFor(caseId);
 out(`Fixture ${options.fixture}${options.invoiceNumber?` as ${options.invoiceNumber}`:''}${options.recipientWallet?` paying ${options.recipientWallet}`:''}${supplier?.vat?` from ${supplier.vat}`:''} -> ${caseId}`);

 const health=await getJson(`${options.mainUrl}/health`,{timeoutMs:5000}).catch(()=>({status:0}));
 if(health.status!==200)throw new Error(`Main API is not healthy at ${options.mainUrl} (HTTP ${health.status||'none'}). Start it with: npm run main -- --confirm-live-payments`);

 const earlier=readPayJournal(payJournalPath(journalDir,key));
 const wallet=readWallet(options.wallet);
 if(!earlier){
  const balance=await fetchBalance(wallet.address,{projectId});
  const need=BigInt(price)+PAYER_MARGIN_LOVELACE;
  if(!balance.used||balance.lovelace<need)throw new Error(`Wallet ${options.wallet} has ${formatAda(balance.lovelace)} tADA; the intake needs at least ${formatAda(need)} tADA.`);
  out(`Paying ${formatAda(price)} tADA from ${options.wallet} (balance ${formatAda(balance.lovelace)} tADA) to the intake ...`);
 }else out(`Payment journal exists (phase ${earlier.phase}); payOnce returns it or refuses for inspection.`);
 const signer=toClientCardanoSigner({mnemonic:wallet.mnemonic,network:NETWORK,provider:blockfrostProvider(projectId)});
 if(signer.getAddress()!==wallet.address)throw new Error(`Signer address does not match wallet ${options.wallet}.`);
 const journal=await payOnce({url:`${options.mainUrl}/v1/invoices`,key,journalDir,signer,payTo,maxLovelace:price,
  init:{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({xml})}});
 out(`Intake ${journal.phase}${journal.paymentMade===false?' (no new payment)':''}${journal.txHash?`: ${EXPLORER}${journal.txHash}`:''}`);
 const fromBody=caseIdFromJournal(journal);
 if(fromBody&&fromBody!==caseId)out(`Warning: Main answered case ${fromBody}, expected ${caseId}; following Main's case.`);
 return fromBody??caseId;
}

export async function main(argv){
 const options=parseArgs(argv,process.env);
 if(options.help){out(USAGE);return;}
 assertConfirmed(options);
 const caseId=options.caseId??await payIntake(options);
 await follow(options,caseId);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
