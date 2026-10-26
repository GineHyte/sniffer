import {openSync,writeFileSync,closeSync,readFileSync,unlinkSync,mkdirSync,chmodSync,fstatSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
function owner(path){
 const text=readFileSync(path,'utf8');
 if(!/^[1-9][0-9]*$/.test(text)||!Number.isSafeInteger(Number(text)))throw new Error('Worker lock owner is invalid. Inspect the lock before recovery.');
 return Number(text);
}
export function acquireWorkerLock(path='.local/worker.lock'){
 const directory=dirname(path);mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const recovery=`${path}.recovery`;
 let guard;
 try{guard=openSync(recovery,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw new Error('Worker lock recovery is in progress. Inspect its owner before retry.');throw error;}
 let fd;
 try{
  writeFileSync(guard,String(process.pid));
  try{fd=openSync(path,'wx',0o600)}catch(error){
   if(error.code!=='EEXIST')throw error;
   const pid=owner(path);
   try{process.kill(pid,0)}catch(check){if(check.code!=='ESRCH')throw check;unlinkSync(path);fd=openSync(path,'wx',0o600);}
   if(fd===undefined)throw new Error(`Worker already running: ${pid}`);
  }
  writeFileSync(fd,String(process.pid));
  const identity=fstatSync(fd);closeSync(fd);fd=undefined;
  let released=false;
  return ()=>{
   if(released)return;released=true;
   try{
    const current=statSync(path);
    if(current.dev===identity.dev&&current.ino===identity.ino&&owner(path)===process.pid)unlinkSync(path);
   }catch(error){if(error.code!=='ENOENT')throw error;}
  };
 }finally{if(fd!==undefined)closeSync(fd);closeSync(guard);unlinkSync(recovery);}
}
