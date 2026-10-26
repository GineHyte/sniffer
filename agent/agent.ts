import { defineAgent } from 'eve';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
const provider = createOpenAICompatible({name:'zai',baseURL:process.env.ZAI_BASE_URL!,apiKey:process.env.ZAI_API_KEY!});
export default defineAgent({model:provider.chatModel(process.env.ZAI_MODEL!),defaultTools:false});
