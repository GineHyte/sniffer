// Test customer for one paid end-to-end Sniffer case on Cardano Preprod (T29).
// Pays the Main intake (POST /v1/invoices, x402 gate) from the `payer` wallet with payOnce, then polls
// GET /v1/cases/{id} until the case is completed, failed or needs inspection, and prints the decision.
// Main answers the intake 202 once the payment is submitted (confirmation follows in the background) and may complete a case
// with payout.state 'submitted'; the demo then keeps polling (up to 3 min, --no-wait-confirm skips it) for 'confirmed'.
// Every status line shows the time since the demo started; a timing summary closes the run.
// Run only with explicit user approval (Main must be running: npm run main -- --confirm-live-payments):
//   npm run demo -- --confirm-live-payment [--fixture docs/fixtures/f1.xml] [--invoice-number RE-2026-0413] [--recipient-wallet payee] [--new-supplier] [--fresh-wallet]
// Poll an existing case without paying: npm run demo -- --case case-<32 hex>
// One payment per submitted XML: the payOnce key is derived from the XML hash, so a rerun returns the earlier
// payment and only polls. Use --invoice-number for a new case (the backend rejects an exact duplicate with KO-3).
// --new-supplier swaps the seller (BT-31 VAT, BT-27 name with its contact and e-mails, BT-13 open order) for the first VIES-mock-valid VAT the backend has no
// invoice for (GET /v1/suppliers/{supplier_hash}/history = 404), so S-9 fires again and the case reaches the investigators.
// --fresh-wallet creates a new local x402 wallet demo-recipient-<ms> (x402/wallets.mjs createWallet, mnemonic stays in
// .local/x402/) and pays the supplier to its never-used address, so S-1 (address approved for another supplier) cannot fire.
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
export const DEFAULT_POLL_MS=2_000;
export const DEFAULT_CONFIRM_WAIT_MS=3*60_000; // completed with payout.state 'submitted': poll this long for 'confirmed'
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
  --fresh-wallet              create a new local x402 wallet demo-recipient-<ms> and use its never-used address as BT-84
  --new-supplier              replace the seller with the first VIES-mock-valid VAT the backend has no invoice for (S-9 fires again)
  --supplier-vat <VAT>        replace the seller VAT ID (BT-31) with this one (supplier identity = VAT)
  --supplier-name <name>      replace the seller name (BT-27); default for a new VAT: a name per mock VAT
  --wallet <name>             paying x402 wallet (default ${DEFAULT_WALLET})
  --main-url <url>            Main API (default http://127.0.0.1:$MAIN_PORT or :21951)
  --timeout-ms <n>            polling timeout (default ${DEFAULT_TIMEOUT_MS})
  --poll-ms <n>               polling interval (default ${DEFAULT_POLL_MS})
  --no-wait-confirm           stop when the case is completed with the payout only submitted (default: wait up to ${DEFAULT_CONFIRM_WAIT_MS/60_000} min for confirmed)`;

const VALUE_FLAGS={'--fixture':'fixture','--invoice-number':'invoiceNumber','--recipient-wallet':'recipientWallet','--wallet':'wallet','--main-url':'mainUrl',
 '--timeout-ms':'timeoutMs','--poll-ms':'pollMs','--case':'caseId','--supplier-vat':'supplierVat','--supplier-name':'supplierName'};

/** Parses CLI arguments. Throws on unknown flags, missing values and invalid values. */
export function parseArgs(argv,env={}){
 const options={confirm:false,help:false,fixture:DEFAULT_FIXTURE,invoiceNumber:null,recipientWallet:null,wallet:DEFAULT_WALLET,
  mainUrl:`http://127.0.0.1:${env.MAIN_PORT?.trim()||21951}`,timeoutMs:DEFAULT_TIMEOUT_MS,pollMs:DEFAULT_POLL_MS,caseId:null,
  newSupplier:false,supplierVat:null,supplierName:null,waitConfirm:true,freshWallet:false};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg===CONFIRM_FLAG){options.confirm=true;continue;}
  if(arg==='--help'||arg==='-h'){options.help=true;continue;}
  if(arg==='--new-supplier'){options.newSupplier=true;continue;}
  if(arg==='--no-wait-confirm'){options.waitConfirm=false;continue;}
  if(arg==='--fresh-wallet'){options.freshWallet=true;continue;}
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
 if(options.freshWallet&&options.recipientWallet!==null)throw new Error('Use either --fresh-wallet or --recipient-wallet, not both.');
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
 * seller name (BT-27, with a matching seller contact BT-41 and e-mails BT-43/BT-34) and order reference (BT-13). Pure.
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
   // The seller contact (BT-41) and e-mails (BT-43, BT-34) follow the name, or the supplier investigator flags the mismatch.
   const contact=sellerContact(supplierName);
   block=block.replace(/(<ram:DefinedTradeContact>\s*<ram:PersonName>)[^<]*(<\/ram:PersonName>)/,(_,open,close)=>`${open}${escapeXml(contact.person)}${close}`)
    .replace(/(<ram:URIID\b[^>]*>)[^<@]*@[^<]*(<\/ram:URIID>)/g,(_,open,close)=>`${open}${contact.email}${close}`);
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

const GIVEN_NAMES=Object.freeze({A:'Anna',B:'Bernd',C:'Clara',D:'David',E:'Emil',F:'Frieda',G:'Greta',H:'Hanna',I:'Ida',J:'Jonas',K:'Karl',L:'Lena',M:'Maria',
 N:'Nina',O:'Otto',P:'Paula',Q:'Quirin',R:'Rosa',S:'Sophie',T:'Theo',U:'Uwe',V:'Vera',W:'Willi',X:'Xaver',Y:'Yvonne',Z:'Zoe'});
const LEGAL_FORMS=/\b(?:gmbh|mbh|ag|kg|kgaa|ohg|gbr|ug|se|ek|e\s*k|ev|e\s*v|co|haftungsbeschraenkt|ltd|llc|inc|sarl|bv|nv|srl|spa|sa)\b/gu;
const ascii=value=>value.replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/Ä/g,'Ae').replace(/Ö/g,'Oe').replace(/Ü/g,'Ue').replace(/ß/g,'ss')
 .normalize('NFD').replace(/[\u0300-\u036f]/g,'');

/** Seller contact for a supplier name, deterministic: 'Alpha Consulting GmbH' -> Anna Alpha, rechnung@alpha-consulting.example. */
export function sellerContact(name){
 const word=String(name).split(/\s+/).map(w=>w.replace(/[^\p{L}\p{N}-]/gu,'')).find(w=>/\p{L}/u.test(w))??'Lieferant';
 const person=`${GIVEN_NAMES[ascii(word)[0]?.toUpperCase()]??'Kim'} ${word}`;
 const slug=ascii(String(name).toLowerCase()).replace(/[^a-z0-9]+/g,' ').replace(LEGAL_FORMS,' ').trim().replace(/\s+/g,'-').slice(0,63).replace(/-+$/,'')||'lieferant';
 return {person,email:`rechnung@${slug}.example`};
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

export const FRESH_WALLET_PREFIX='demo-recipient-';
/** Name for a --fresh-wallet recipient: demo-recipient-<epoch ms> (28 characters, fits the x402 wallet name rule). */
export const freshWalletName=(nowMs=Date.now())=>`${FRESH_WALLET_PREFIX}${Math.trunc(nowMs)}`;

/**
 * Recipient for BT-84: --fresh-wallet creates a new wallet with createWallet(name) (x402/wallets.mjs, prints nothing secret),
 * --recipient-wallet reads an existing one. Returns {name, address, fresh} or null (fixture address unchanged).
 */
export function resolveRecipient(options,{createWallet,walletAddress,now=Date.now}){
 if(options.freshWallet){
  const name=freshWalletName(now());
  const {address}=createWallet(name);
  if(typeof address!=='string'||!ADDRESS_RE.test(address))throw new Error(`New wallet ${name} has no Preprod address.`);
  return {name,address,fresh:true};
 }
 if(options.recipientWallet)return {name:options.recipientWallet,address:walletAddress(options.recipientWallet),fresh:false};
 return null;
}

/** Expected band for a seller, as far as the demo can know it (wallet history is not readable). fresh: true/false/null. */
export function expectedOutcome({vat,fresh,viesValid,openOrder,freshWallet=false}){
 if(viesValid===false)return `expect high: S-2 fires (+35), the VIES mock marks ${vat} invalid`;
 if(fresh===false)return `expect low: S-9 does not fire, ${vat} already has invoices in the backend; the case may auto-approve without investigators (use --new-supplier)`;
 const order=openOrder?'':`; I-8 fires (+8): BT-13 is not an open order of ${vat}`;
 if(fresh===null)return `supplier history of ${vat} unknown${order}`;
 const sum=openOrder?'I-2 +20, W-4 +10, S-9 +5, T-3 -10, T-4 -5 -> score 20':'I-2 +20, W-4 +10, S-9 +5, I-8 +8, T-4 -5 -> score 38';
 if(freshWallet)return `expect medium: S-9 fires (+5)${order}. Fresh recipient wallet (never used, so S-1 cannot fire): ${sum}`;
 return `expect medium: S-9 fires (+5)${order}. With a wallet the backend has not seen: ${sum}. If the payment wallet was approved before, S-1 (+35) fires too (score >= 40, still medium unless the wallet also has a risk rejection)`;
}

/** Lines describing the resolved seller rewrite and the expected outcome. */
export function supplierLines(supplier,{freshWallet=false}={}){
 if(!supplier)return [];
 const lines=supplier.skipped.map(s=>`Skipping supplier ${s.vat}: ${s.reason}`);
 const {supplierVat,supplierName,orderReference}=supplier.rewrite;
 if(supplierVat===undefined){lines.push(`Seller name -> ${supplierName} (VAT unchanged: supplier history unchanged)`);return lines;}
 lines.push(`Supplier VAT ${supplierVat} (${supplierName})${orderReference?`, order ${orderReference}`:''}`);
 lines.push(supplier.resume?`Resuming the earlier demo case for ${supplierVat} (no new payment)`:expectedOutcome({...supplier,freshWallet}));
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

/** Completed, but the supplier payout is only submitted (Main confirms it in the background). */
export const payoutUnconfirmed=view=>view?.status==='completed'&&view.payout?.state==='submitted';

/**
 * Polls fetchCase(caseId) until a terminal status or the deadline. Network errors and 5xx are retried until the deadline;
 * 404 stops at once (the case is created before the 202, so it should always exist).
 * With waitConfirm, a completed case whose payout is only submitted is polled on until payout.state is no longer 'submitted'
 * or confirmWaitMs after it was first seen (then confirmTimedOut; the overall deadline no longer applies).
 * @param {object} options {caseId, fetchCase:(id)=>Promise<{status:number,body:any}>, timeoutMs, pollMs, clock:{now,sleep}, onUpdate, waitConfirm, confirmWaitMs}
 * @returns {Promise<{done:boolean,view:object|null,timedOut:boolean,confirmTimedOut:boolean}>}
 */
export async function pollCase({caseId,fetchCase,timeoutMs,pollMs,clock,onUpdate=()=>{},waitConfirm=true,confirmWaitMs=DEFAULT_CONFIRM_WAIT_MS}){
 const deadline=clock.now()+timeoutMs;
 let view=null,confirmDeadline=null;
 for(;;){
  let result;
  try{result=await fetchCase(caseId);}catch(error){result={status:0,error};}
  if(result.status===200&&result.body&&typeof result.body==='object'){
   view=result.body;
   onUpdate({type:'view',view});
   if(TERMINAL_STATUSES.has(view.status)){
    if(!waitConfirm||!payoutUnconfirmed(view))return {done:true,view,timedOut:false,confirmTimedOut:false};
    confirmDeadline??=clock.now()+confirmWaitMs;
   }
  }else if(result.status===404){
   throw new Error(`Case ${caseId} not found at the Main API. Check --main-url and MAIN_STATE_DIR.`);
  }else onUpdate({type:'error',status:result.status,error:result.error});
  const now=clock.now(),until=confirmDeadline??deadline;
  if(now>=until)return confirmDeadline===null?{done:false,view,timedOut:true,confirmTimedOut:false}:{done:true,view,timedOut:false,confirmTimedOut:true};
  await clock.sleep(Math.max(1,Math.min(pollMs,until-now)));
 }
}

/** Elapsed time for status lines: 12.3s below a minute, else 4m05s. */
export function formatElapsed(ms){
 const tenths=Math.floor(Math.max(0,ms)/100);
 if(tenths<600)return `${(tenths/10).toFixed(1)}s`;
 const s=Math.floor(tenths/10);
 return `${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`;
}

export const MILESTONES=Object.freeze([['intakePaid','intake paid (202 received)'],['intakeConfirmed','intake confirmed'],['decision','decision reached'],
 ['payoutSubmitted','payout submitted'],['payoutConfirmed','payout confirmed']]);

/** Records the first elapsed time (ms since the demo started) each milestone is seen in a case view. intakePaid is set by the pay path. */
export function trackMilestones(marks,view,at){
 const set=(key,on)=>{if(on&&marks[key]===undefined)marks[key]=at;};
 const payout=view?.payout?.state;
 set('intakeConfirmed',view?.intake?.state==='confirmed');
 set('decision',Boolean(view?.decision));
 set('payoutSubmitted',payout==='submitted'||payout==='confirmed');
 set('payoutConfirmed',payout==='confirmed');
 return marks;
}

/** Timing summary lines in time order, plus Main's own paid_at -> confirmed_at for the intake when the view has both. */
export function timingLines(marks,view=null){
 const rows=MILESTONES.filter(([key])=>Number.isFinite(marks[key])).map(([key,label])=>[marks[key],label]).sort((a,b)=>a[0]-b[0]);
 const paid=Date.parse(view?.intake?.paid_at??''),confirmed=Date.parse(view?.intake?.confirmed_at??'');
 const server=Number.isFinite(paid)&&Number.isFinite(confirmed)&&confirmed>=paid?`  intake paid -> confirmed (Main clock): ${formatElapsed(confirmed-paid)}`:null;
 if(!rows.length&&!server)return [];
 const width=Math.max(0,...rows.map(([,label])=>label.length));
 return ['Timing (first seen by this run, since the demo started):',...rows.map(([at,label])=>`  ${label.padEnd(width)}  +${formatElapsed(at)}`),...(server?[server]:[])];
}

const STOP_HINTS=Object.freeze({
 intake_not_confirmed:'the intake payment failed on chain, so Main paid no investigator and no supplier',
 intake_unconfirmed:'the intake payment was not confirmed in time; Main paid no investigator and no supplier. Check the intake transaction before any retry',
});

/** Final error message for a case that ended failed or needs_inspection. */
export function failureMessage(caseId,view){
 const code=view?.inspection?.code??null,hint=STOP_HINTS[code],tx=view?.intake?.tx_hash;
 return `Case ${caseId} ended with status ${view?.status}${code?` (${code})`:''}${hint?`: ${hint}`:''}.${hint&&tx?` Intake: ${EXPLORER}${tx}.`:''} Inspect .local/main/cases/${caseId}/case.json.`;
}

/** Message for an intake Main refused before any payment (503 too_many_unconfirmed_intakes in the payOnce journal), or null. */
export function intakeRefusal(journal){
 if(journal?.phase!=='failed_before_signing'||journal.response?.status!==503)return null;
 let code=null;try{code=JSON.parse(journal.response.body??'').error;}catch{}
 if(code!=='too_many_unconfirmed_intakes')return null;
 return 'Main refused the intake with HTTP 503 too_many_unconfirmed_intakes: too many earlier intake payments are not confirmed yet (MAX_UNCONFIRMED_INTAKES, default 5). No payment was signed. Wait a minute and rerun the same command.';
}

/** One status line per change (status, intake, investigators, decision, payout). */
export function progressLine(view){
 const inv=view.investigators?Object.entries(view.investigators).map(([role,entry])=>`${role}:${entry.payment??'-'}/${entry.report??'-'}${entry.verdict?`(${entry.verdict})`:''}`).join(' '):'';
 return [`status=${view.status}`,view.intake?.state?`intake=${view.intake.state}`:'',view.band?`band=${view.band}`:'',view.risk_score!==null&&view.risk_score!==undefined?`score=${view.risk_score}`:'',inv,
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

/** Status line prefix: wall-clock time (UTC) and the time since the demo started. */
const stampFor=(clock,started)=>()=>`[${new Date(clock.now()).toISOString().slice(11,19)} +${formatElapsed(clock.now()-started)}]`;

/**
 * Follows a case to its end and prints status lines, links, the decision and the timing summary.
 * Resolves for completed (also when the payout confirmation wait timed out, with a warning); throws otherwise.
 */
export async function follow(options,caseId,{fetchCase=id=>getJson(`${options.mainUrl}/v1/cases/${id}`),clock=systemClock,started=clock.now(),marks={},
 confirmWaitMs=DEFAULT_CONFIRM_WAIT_MS,print=out}={}){
 const stamp=stampFor(clock,started);
 print(`Case ${caseId}: ${options.mainUrl}/v1/cases/${caseId}`);
 let last='',submittedNoted=false,confirmedNoted=false;
 const result=await pollCase({caseId,timeoutMs:options.timeoutMs,pollMs:options.pollMs,clock,fetchCase,waitConfirm:options.waitConfirm!==false,confirmWaitMs,
  onUpdate:event=>{
   if(event.type!=='view'){print(`${stamp()} Main API not answering (HTTP ${event.status||'none'}); retrying`);return;}
   const view=event.view;
   trackMilestones(marks,view,clock.now()-started);
   const line=progressLine(view);
   if(line!==last){print(`${stamp()} ${line}`);last=line;}
   if(payoutUnconfirmed(view)&&!submittedNoted){
    submittedNoted=true;
    print(`${stamp()} approved, payout submitted${options.waitConfirm!==false?` (waiting up to ${formatElapsed(confirmWaitMs)} for its confirmation)`:''}`);
   }else if(submittedNoted&&!confirmedNoted&&view.payout?.state==='confirmed'){confirmedNoted=true;print(`${stamp()} payout confirmed`);}
  }});
 const view=result.view;
 if(view){
  print(JSON.stringify(view,null,1));
  if(view.intake?.tx_hash)print(`Intake payment: ${EXPLORER}${view.intake.tx_hash}`);
  for(const [role,entry] of Object.entries(view.investigators??{}))if(entry.payment_tx_hash)print(`${role} payment: ${EXPLORER}${entry.payment_tx_hash}`);
  if(view.payout?.tx_hash)print(`Supplier payout: ${EXPLORER}${view.payout.tx_hash}`);
 }
 let failure=null;
 if(result.timedOut)failure=`Case ${caseId} is not finished after ${options.timeoutMs} ms. Follow it later with: npm run demo -- --case ${caseId}`;
 else if(view.status!=='completed')failure=failureMessage(caseId,view);
 else{
  print(`Decision: ${view.decision?.decision??'none'} (${view.decision?.final_decision??'-'}, decided by ${view.decision?.decided_by??'-'})`);
  if(payoutUnconfirmed(view))print(result.confirmTimedOut
   ?`Warning: the supplier payout is still submitted, not confirmed, after ${formatElapsed(confirmWaitMs)}. Main keeps confirming it; follow it with: npm run demo -- --case ${caseId}`
   :`Payout submitted; not waiting for its confirmation (--no-wait-confirm). Follow it with: npm run demo -- --case ${caseId}`);
 }
 for(const line of timingLines(marks,view))print(line);
 if(failure)throw new Error(failure);
 return result;
}

async function payIntake(options,{clock,started,marks}){
 const env=process.env;
 const [{payOnce,lovelaceString,readPayJournal,payJournalPath},{readWallet,walletAddress,createWallet,fetchBalance,formatAda,NETWORK},{blockfrostProvider},{toClientCardanoSigner}]=await Promise.all([
  import('../x402/pay.mjs'),import('../x402/wallets.mjs'),import('../x402/facilitator.mjs'),import('@x402/cardano')]);
 const price=lovelaceString(env.INTAKE_PRICE_LOVELACE?.trim(),'INTAKE_PRICE_LOVELACE');
 const payTo=env.INTAKE_PAY_TO?.trim();
 if(!payTo||!ADDRESS_RE.test(payTo))throw new Error('INTAKE_PAY_TO is not set to a Preprod address. Run with: npm run demo (loads .local/live.env).');
 const projectId=env.BLOCKFROST_API_KEY_PREPROD;
 const raw=readFileSync(resolve(ROOT,options.fixture),'utf8');
 // Before --fresh-wallet creates a wallet file: no new wallet when Main is down.
 const health=await getJson(`${options.mainUrl}/health`,{timeoutMs:5000}).catch(()=>({status:0}));
 if(health.status!==200)throw new Error(`Main API is not healthy at ${options.mainUrl} (HTTP ${health.status||'none'}). Start it with: npm run main -- --confirm-live-payments`);
 const recipient=resolveRecipient(options,{createWallet,walletAddress,now:()=>clock.now()});
 if(recipient?.fresh)out(`Fresh recipient wallet ${recipient.name}: ${recipient.address}`);
 const base={invoiceNumber:options.invoiceNumber,recipientAddress:recipient?.address??null};
 const xmlFor=rewrite=>prepareXml(raw,{...base,...rewrite});
 const journalDir=env.DEMO_STATE_DIR?.trim()||join(ROOT,'.local','demo');
 const supplier=await resolveSupplier(options,{xmlFor,lookups:supplierLookups(env,{mainUrl:options.mainUrl,journalDir})});
 for(const line of supplierLines(supplier,{freshWallet:Boolean(recipient?.fresh)}))out(line);
 const xml=xmlFor(supplier?.rewrite??{});
 const {caseId}=intakeIds(xml);
 const key=payKeyFor(caseId);
 out(`Fixture ${options.fixture}${options.invoiceNumber?` as ${options.invoiceNumber}`:''}${recipient?` paying ${recipient.name}`:''}${supplier?.vat?` from ${supplier.vat}`:''} -> ${caseId}`);

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
 let journal;
 try{
  journal=await payOnce({url:`${options.mainUrl}/v1/invoices`,key,journalDir,signer,payTo,maxLovelace:price,
   init:{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({xml})}});
 }catch(error){
  let after=null;try{after=readPayJournal(payJournalPath(journalDir,key));}catch{}
  const refusal=intakeRefusal(after);
  throw refusal?new Error(refusal):error;
 }
 // A 202 this run (Main answers once the payment is submitted; it confirms in the background), not a journal replay.
 if(!earlier||!['paid','no_payment_required'].includes(earlier.phase))marks.intakePaid=clock.now()-started;
 out(`${stampFor(clock,started)()} Intake ${journal.phase}${journal.paymentMade===false?' (no new payment)':''}${journal.txHash?`: ${EXPLORER}${journal.txHash}`:''}`);
 const fromBody=caseIdFromJournal(journal);
 if(fromBody&&fromBody!==caseId)out(`Warning: Main answered case ${fromBody}, expected ${caseId}; following Main's case.`);
 return fromBody??caseId;
}

export async function main(argv,{clock=systemClock}={}){
 const started=clock.now(),marks={};
 const options=parseArgs(argv,process.env);
 if(options.help){out(USAGE);return;}
 assertConfirmed(options);
 const caseId=options.caseId??await payIntake(options,{clock,started,marks});
 await follow(options,caseId,{clock,started,marks});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
