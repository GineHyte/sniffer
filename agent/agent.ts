import { defineAgent } from 'eve';
import { createAnthropic } from '@ai-sdk/anthropic';
import { resolveRole } from './lib/role.ts';
resolveRole(process.env.AGENT_ROLE);
// Opus 5.5 rejects temperature/top_p/top_k and thinking budgets; send none of them.
if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is required');
const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5-5';
// Default: claude-opus-5-5's 1M window, so Eve skips its AI Gateway catalog lookup.
const contextWindow = process.env.MODEL_CONTEXT_WINDOW_TOKENS?.trim();
const modelContextWindowTokens = contextWindow ? Number(contextWindow) : 1_000_000;
if (!Number.isSafeInteger(modelContextWindowTokens) || modelContextWindowTokens <= 0) {
 throw new Error('MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer');
}
export default defineAgent({model:createAnthropic()(model),modelContextWindowTokens,defaultTools:false});
