import {test} from 'node:test';
import assert from 'node:assert/strict';

async function configFor(contextWindowTokens) {
 const previous=process.env.ZAI_CONTEXT_WINDOW_TOKENS;
 try {
  if(contextWindowTokens===undefined)delete process.env.ZAI_CONTEXT_WINDOW_TOKENS;
  else process.env.ZAI_CONTEXT_WINDOW_TOKENS=contextWindowTokens;
  return (await import(`./agent/agent.ts?test=${crypto.randomUUID()}`)).default;
 } finally {
  if(previous===undefined)delete process.env.ZAI_CONTEXT_WINDOW_TOKENS;
  else process.env.ZAI_CONTEXT_WINDOW_TOKENS=previous;
 }
}

test('custom model context window reaches Eve and rejects invalid token limits',async()=>{
 assert.equal((await configFor('32768')).modelContextWindowTokens,32768);
 for(const value of ['0','-1','1.5','invalid','9007199254740992']) {
  await assert.rejects(configFor(value),/ZAI_CONTEXT_WINDOW_TOKENS must be a positive integer/);
 }
 assert.equal((await configFor('')).modelContextWindowTokens,undefined);
 assert.equal((await configFor(undefined)).modelContextWindowTokens,undefined);
});
