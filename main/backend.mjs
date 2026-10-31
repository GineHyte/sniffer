// Bearer client for the Rust sniffer API used by Main (spec 5, §12.6). Error bodies are {error, message} (FR-09);
// only the `error` code is kept, never the message, so invoice data cannot leak into logs.

export class SnifferApiError extends Error{
 constructor(message,{status,code}){super(message);this.name='SnifferApiError';this.status=status;this.code=code;}
}

const CHECK_ID_RE=/^chk_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH_RE=/^hmac:[0-9a-f]{64}$/;
export const assertCheckId=id=>{if(typeof id!=='string'||!CHECK_ID_RE.test(id))throw new Error('check_id must be chk_ + ULID');return id;};

/** Minimal shape check of a CheckResult (spec 4). Main only routes on summary.band; it never recomputes it. */
export function assertCheckResult(result){
 if(!result||typeof result!=='object')throw new Error('Initial check returned no result object');
 assertCheckId(result.check_id);
 if(!['low','medium','high'].includes(result.summary?.band))throw new Error('Initial check result has no valid summary.band');
 const tasks=result.agent_tasks;
 if(!tasks||!['invoice','wallet','research'].every(key=>Array.isArray(tasks[key])))throw new Error('Initial check result has no agent_tasks');
 return result;
}

export function createSnifferClient({baseUrl=process.env.SNIFFER_BASE_URL||'http://127.0.0.1:8080',token=process.env.SNIFFER_API_TOKEN,fetchImpl=fetch,timeoutMs=120_000}={}){
 if(!token)throw new Error('SNIFFER_API_TOKEN is not set. Run with: node --env-file=.env ...');
 const base=String(baseUrl).replace(/\/+$/,'');
 async function call(label,method,path,{body,accept='application/json'}={}){
  let response;
  try{
   const headers={authorization:`Bearer ${token}`,accept};
   if(body!==undefined)headers['content-type']='application/json';
   response=await fetchImpl(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  }catch(error){throw new SnifferApiError(`Backend ${label} request failed (${error?.name||'Error'}).`,{status:0,code:'network_error'});}
  const text=await response.text().catch(()=>'');
  if(response.ok)return text;
  let code='http_error';
  try{const parsed=JSON.parse(text);if(typeof parsed?.error==='string'&&/^[a-z_]{1,64}$/.test(parsed.error))code=parsed.error;}catch{}
  throw new SnifferApiError(`Backend ${label} returned HTTP ${response.status} ${code}.`,{status:response.status,code});
 }
 const json=(label,text)=>{try{const value=JSON.parse(text);if(value&&typeof value==='object')return value;}catch{}throw new SnifferApiError(`Backend ${label} returned invalid JSON.`,{status:200,code:'invalid_response'});};
 return {
  async initialCheck(xml){return assertCheckResult(json('initial-check',await call('initial-check','POST','/v1/initial-check',{body:{xml}})));},
  async getCheck(checkId){return json('get-check',await call('get-check','GET',`/v1/checks/${encodeURIComponent(assertCheckId(checkId))}`));},
  async getXml(checkId){return call('get-xml','GET',`/v1/checks/${encodeURIComponent(assertCheckId(checkId))}/xml`,{accept:'application/xml'});},
  async supplierHistory(supplierHash){
   if(typeof supplierHash!=='string'||!HASH_RE.test(supplierHash))throw new Error('supplier_hash must be hmac: + 64 hex');
   return json('supplier-history',await call('supplier-history','GET',`/v1/suppliers/${encodeURIComponent(supplierHash)}/history`));
  },
  async postDecision(body){return json('decisions',await call('decisions','POST','/v1/decisions',{body}));},
 };
}
