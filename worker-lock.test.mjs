import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireWorkerLock} from './worker-lock.mjs';
function temp(){return mkdtempSync(join(tmpdir(),'worker-lock-'));}
function deadPid(){const child=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'});return child.stdout.trim();}
async function contenders(path,count=4){
 const module=new URL('./worker-lock.mjs',import.meta.url).href;
 const code=`import {acquireWorkerLock} from ${JSON.stringify(module)};let release;try{release=acquireWorkerLock(process.argv[1]);process.send({ok:true});}catch(e){process.send({ok:false,error:e.message});}process.on('message',()=>{release?.();process.exit(0)});`;
 const children=Array.from({length:count},()=>fork('-e',[code,path],{execArgv:['--input-type=module'],stdio:['ignore','ignore','ignore','ipc']}));
 try{
  const results=await Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Child exited before lock result')));})));
  assert.equal(results.filter(result=>result.ok).length,1);
 }finally{await Promise.all(children.map(child=>new Promise(resolve=>{child.once('exit',resolve);child.send('release');})));}
}
test('missing private directory is created and owned lock released',()=>{const dir=temp(),path=join(dir,'.local/worker.lock');try{const release=acquireWorkerLock(path);assert.equal(statSync(join(dir,'.local')).mode&0o777,0o700);assert.equal(statSync(path).mode&0o777,0o600);release();assert.equal(existsSync(path),false);}finally{rmSync(dir,{recursive:true});}});
test('live owner is never removed',()=>{const dir=temp(),path=join(dir,'worker.lock');try{writeFileSync(path,String(process.pid));assert.throws(()=>acquireWorkerLock(path),/already running/);assert.equal(readFileSync(path,'utf8'),String(process.pid));}finally{rmSync(dir,{recursive:true});}});
test('empty and zero owner need inspection',()=>{const dir=temp(),path=join(dir,'worker.lock');try{for(const text of ['','0','not-a-pid']){writeFileSync(path,text);assert.throws(()=>acquireWorkerLock(path),/owner is invalid/);assert.equal(readFileSync(path,'utf8'),text);}}finally{rmSync(dir,{recursive:true});}});
test('concurrent starts admit exactly one owner',async()=>{const dir=temp();try{await contenders(join(dir,'worker.lock'));}finally{rmSync(dir,{recursive:true});}});
test('concurrent stale recovery admits exactly one owner',async()=>{const dir=temp(),path=join(dir,'worker.lock');try{writeFileSync(path,deadPid());await contenders(path);}finally{rmSync(dir,{recursive:true});}});
test('release preserves replacement lock',()=>{const dir=temp(),path=join(dir,'worker.lock');try{const release=acquireWorkerLock(path);unlinkSync(path);writeFileSync(path,'123');release();assert.equal(readFileSync(path,'utf8'),'123');}finally{rmSync(dir,{recursive:true});}});
