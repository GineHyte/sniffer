import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {client} from './client.mjs';
import {loadSokosumiRuntime} from './sokosumi-runtime.mjs';
const {readRuntimeCredential,createCoworkerHttpClient,fetchTaskEvents,createTaskEvent}=await loadSokosumiRuntime();
const runtime=createCoworkerHttpClient({apiKey:readRuntimeCredential(process.env.COWORKER_ID)});
export async function reply(taskId){
 const p=`.local/${taskId}-comments.json`;
 const state=existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{};
 const {events}=await fetchTaskEvents(runtime,taskId,AbortSignal.timeout(30000));
 const sessionFile=`.local/${taskId}-session.json`;
 if(!existsSync(sessionFile))return;
 const {sessionId}=JSON.parse(readFileSync(sessionFile,'utf8'));
 for(const event of events.filter(e=>e.actor?.type==='user'&&typeof e.comment==='string'&&e.comment.trim())){
 if(state[event.id])continue;
 state[event.id]='model-pending';writeFileSync(p,JSON.stringify(state),{mode:0o600});
 const response=await(await client.sessions.attach(sessionId).send(event.comment.slice(0,16000))).result();
 if(response.status==='failed'||response.inputRequests.length||!response.message?.trim())continue;
 state[event.id]='post-pending';writeFileSync(p,JSON.stringify(state),{mode:0o600});
 await createTaskEvent(runtime,taskId,{comment:response.message},AbortSignal.timeout(30000));
 state[event.id]='posted';writeFileSync(p,JSON.stringify(state),{mode:0o600});
 }
}
