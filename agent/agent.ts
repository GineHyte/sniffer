import { defineAgent } from 'eve';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
const provider = createOpenAICompatible({name:'zai',baseURL:process.env.ZAI_BASE_URL!,apiKey:process.env.ZAI_API_KEY!});
const contextWindow = process.env.ZAI_CONTEXT_WINDOW_TOKENS?.trim();
const modelContextWindowTokens = contextWindow ? Number(contextWindow) : undefined;
if (modelContextWindowTokens !== undefined && (!Number.isSafeInteger(modelContextWindowTokens) || modelContextWindowTokens <= 0)) {
 throw new Error('ZAI_CONTEXT_WINDOW_TOKENS must be a positive integer');
}
export default defineAgent({model:provider.chatModel(process.env.ZAI_MODEL!),modelContextWindowTokens,defaultTools:false});
