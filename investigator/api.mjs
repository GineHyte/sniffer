// Investigator x402 API for one role (Task 25). `POST /pay/{taskId}` only records a confirmed payment for that
// Sokosumi task ID in the gate journal; it starts no work. The role's worker starts the task once it sees `paid`
// (Cardano runs the handler before settlement, docs/x402-notes.md §3.2 and §4).
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {x402Gate} from '../x402/gate.mjs';
import {TASK_ID_REGEX,INVESTIGATOR_ROLES} from './contract.mjs';

export const MAX_BODY_BYTES=64*1024;
const PAY_PATH=/^\/pay\/([^/]+)$/;

// Returns the validated Sokosumi task ID, or null for anything that is not exactly /pay/{taskId}.
export function taskIdFromPath(pathname){
 const match=PAY_PATH.exec(pathname);
 if(!match)return null;
 let taskId;
 try{taskId=decodeURIComponent(match[1]);}catch{return null;}
 return TASK_ID_REGEX.test(taskId)?taskId:null;
}

const pathOf=req=>new URL(req.url??'/','http://localhost').pathname;

export function createInvestigatorGate({priceLovelace,payTo,facilitator,facilitatorUrl,journalPath,l1Confirmations=0,onError}){
 return x402Gate({priceLovelace,payTo,facilitator,facilitatorUrl,journalPath,l1Confirmations,onError,
  description:'Sniffer investigator task',
  resourceId:req=>taskIdFromPath(pathOf(req))??''});
}

function send(res,status,body,headers={}){
 if(res.headersSent)return;
 res.statusCode=status;
 for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
 res.setHeader('content-type','application/json');
 res.setHeader('cache-control','no-store');
 res.end(JSON.stringify(body));
}

/**
 * @param {{role:string, gate:(req,res)=>Promise<{paid:true,txHash:string}|null>, log?:{error:Function}}} options
 * @returns {import('node:http').Server}
 */
export function createInvestigatorServer({role,gate,log=console}){
 if(!INVESTIGATOR_ROLES.includes(role))throw new Error(`role must be one of ${INVESTIGATOR_ROLES.join(', ')}`);
 if(typeof gate!=='function')throw new Error('gate is required');
 return createServer(async(req,res)=>{
  try{
   if(Number(req.headers['content-length']??0)>MAX_BODY_BYTES){send(res,413,{error:'body_too_large'},{connection:'close'});req.destroy();return;}
   // The payment travels in headers; any body is discarded.
   req.resume();
   const pathname=pathOf(req);
   if(pathname==='/health'){
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'method_not_allowed'},{allow:'GET, HEAD'});
    return send(res,200,{ok:true,role});
   }
   if(pathname.startsWith('/pay/')){
    if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'},{allow:'POST'});
    const taskId=taskIdFromPath(pathname);
    if(!taskId)return send(res,400,{error:'invalid_task_id'});
    const paid=await gate(req,res);
    if(!paid)return;
    return send(res,200,{task_id:taskId,paid:true,tx_hash:paid.txHash});
   }
   send(res,404,{error:'not_found'});
  }catch(error){
   log.error('Investigator API request failed',String(error?.message??error).slice(0,200));
   send(res,500,{error:'internal_error'});
  }
 });
}

// Usage: node --env-file=.env investigator/api.mjs <role>   (or AGENT_ROLE=<role>)
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {apiConfig,envWithRole}=await import('./config.mjs');
 const {acquireWorkerLock}=await import('../worker-lock.mjs');
 const {createInProcessFacilitator}=await import('../x402/facilitator.mjs');
 const config=apiConfig(envWithRole());
 const release=acquireWorkerLock(config.paths.apiLock);
 process.once('exit',release);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{release();process.exit(0);});
 const gate=createInvestigatorGate({priceLovelace:config.priceLovelace,payTo:config.payTo,facilitator:createInProcessFacilitator(),
  journalPath:config.paths.gateJournal,onError:error=>console.error('Payment gate error',String(error?.message??error).slice(0,200))});
 const server=createInvestigatorServer({role:config.role,gate});
 server.listen(config.port,'127.0.0.1',()=>console.log(`Investigator ${config.role} API on http://127.0.0.1:${config.port}`));
}
