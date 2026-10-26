import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
export function eveAddress(env){
 const url=env.EVE_URL?new URL(env.EVE_URL):null;
 const port=Number(env.EVE_PORT??url?.port);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('EVE_PORT must be an integer from 1 to 65535');
 if(url&&(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||Number(url.port)!==port||url.username||url.password||url.pathname!=='/'||url.search||url.hash))throw new Error('EVE_URL must match http://127.0.0.1:EVE_PORT');
 return {port,url:`http://127.0.0.1:${port}`};
}
export function eveBinary(resolveModule=createRequire(import.meta.url).resolve){
 const manifest=resolveModule('eve/package.json');
 const pkg=JSON.parse(readFileSync(manifest,'utf8'));
 if(typeof pkg.bin?.eve!=='string')throw new Error('Installed eve package has no eve executable');
 return resolve(dirname(manifest),pkg.bin.eve);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {port,url}=eveAddress(process.env);
 const child=spawn(process.execPath,[eveBinary(),'dev','--no-ui','--no-default-extensions','--host','127.0.0.1','--port',String(port)],{stdio:'inherit',env:{...process.env,EVE_PORT:String(port),EVE_URL:url}});
 child.on('error',()=>{console.error('Eve could not start');process.exitCode=1;});
 child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}
