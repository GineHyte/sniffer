import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';

// Eve compiles `?raw` asset imports to UTF-8 strings; mirror that so Node can load the instruction module.
registerHooks({load(url,context,nextLoad){
 if(!url.startsWith('file:')||new URL(url).search!=='?raw')return nextLoad(url,context);
 const path=fileURLToPath(url.slice(0,url.indexOf('?')));
 return {format:'module',shortCircuit:true,source:`export default ${JSON.stringify(readFileSync(path,'utf8'))};`};
}});

async function withEnv(values,load) {
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 const set=(key,value)=>{if(value===undefined)delete process.env[key];else process.env[key]=value;};
 try {
  for(const [key,value] of Object.entries(values))set(key,value);
  return await load();
 } finally {
  for(const [key,value] of Object.entries(previous))set(key,value);
 }
}
const fresh=path=>import(`${path}?test=${crypto.randomUUID()}`);
const agentFor=env=>withEnv({ANTHROPIC_API_KEY:'test-key',ANTHROPIC_MODEL:undefined,MODEL_CONTEXT_WINDOW_TOKENS:undefined,AGENT_ROLE:'invoice',...env},async()=>(await fresh('./agent/agent.ts')).default);
const configFor=(contextWindowTokens,...roleArg)=>agentFor({MODEL_CONTEXT_WINDOW_TOKENS:contextWindowTokens,AGENT_ROLE:roleArg.length?roleArg[0]:'invoice'});
const instructionsFor=role=>withEnv({AGENT_ROLE:role},async()=>(await fresh('./agent/instructions/role.ts')).default);

test('custom model context window reaches Eve and rejects invalid token limits',async()=>{
 assert.equal((await configFor('32768')).modelContextWindowTokens,32768);
 for(const value of ['0','-1','1.5','invalid','9007199254740992']) {
  await assert.rejects(configFor(value),/MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer/);
 }
 assert.equal((await configFor('')).modelContextWindowTokens,1_000_000);
 assert.equal((await configFor(undefined)).modelContextWindowTokens,1_000_000);
});

test('agent uses the native Anthropic provider and requires an API key',async()=>{
 const {model}=await configFor(undefined);
 assert.equal(model.provider,'anthropic.messages');
 assert.equal(model.modelId,'claude-opus-5-5');
 assert.equal((await agentFor({ANTHROPIC_MODEL:' claude-fable-5-1 '})).model.modelId,'claude-fable-5-1');
 for(const key of [undefined,'','  ']) await assert.rejects(agentFor({ANTHROPIC_API_KEY:key}),/ANTHROPIC_API_KEY is required/);
});

test('each role maps to its prompt file',async()=>{
 const {rolePromptFiles,resolveRole}=await import('./agent/lib/role.ts');
 assert.deepEqual({...rolePromptFiles},{invoice:'invoice_investigator.txt',wallet:'wallet_investigator.txt',supplier:'supplier_investigator.txt',main:'main_agent_prompt.txt'});
 assert.equal(resolveRole(' wallet '),'wallet');
});

test('each role loads its non-empty prompt as system instructions',async()=>{
 const {rolePromptFiles}=await import('./agent/lib/role.ts');
 for(const [role,file] of Object.entries(rolePromptFiles)) {
  const instructions=await instructionsFor(role);
  assert.ok(instructions.content.trim().length>0,role);
  assert.equal(instructions.content,readFileSync(new URL(`./promts/${file}`,import.meta.url),'utf8'),role);
  assert.notEqual(instructions.role,'user');
  assert.ok((await configFor(undefined,role)).model,role);
 }
});

test('missing or unknown AGENT_ROLE is rejected',async()=>{
 for(const role of [undefined,'','  ']) {
  await assert.rejects(configFor(undefined,role),/AGENT_ROLE is required/);
  await assert.rejects(instructionsFor(role),/AGENT_ROLE is required/);
 }
 for(const role of ['bogus','Invoice','research','__proto__','toString']) {
  await assert.rejects(configFor(undefined,role),/AGENT_ROLE must be one of invoice, wallet, supplier, main/);
  await assert.rejects(instructionsFor(role),/AGENT_ROLE must be one of invoice, wallet, supplier, main/);
 }
});
