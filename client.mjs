import { Client } from 'eve/client';
import { writeFileSync } from 'node:fs';
export const client=new Client({host:process.env.EVE_URL});
export async function answer(input,journal,deadline) {
 if(typeof input!=='string'||!input.trim()||input.length>16000) throw new Error('Input must contain 1 to 16000 characters');
 const {session}=await client.sessions.create();
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'sending'}),{mode:0o600});
 if(deadline!==undefined&&Date.now()>=deadline)throw new Error('Result deadline expired before model send');
 const result=await (await session.send(input)).result();
 if(result.status==='failed'||result.inputRequests.length||!result.message?.trim()) throw new Error('Turn did not return a final answer');
 writeFileSync(journal,JSON.stringify({sessionId:session.state.sessionId,phase:'answered',result:result.message}),{mode:0o600});
 return result.message;
}
