// Per-role Eve app root. Eve 0.71.0 keeps one dev server per app root in `<appRoot>/.eve/`; a second
// `eve dev` from the same root refuses to start ("A dev server is already running for this eve agent").
// Each role therefore runs from its own root `.local/eve-<role>/`.
import {spawn} from 'node:child_process';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {eveAddress,eveBinary} from '../start.mjs';

export const EVE_ROLES=Object.freeze(['invoice','wallet','supplier','main']);
// Copied fresh on every prepare: Eve's bundler resolves the real path of authored files and refuses asset
// imports (agent/instructions/role.ts -> ../../promts/*.txt) outside the app root, so links do not work here.
export const EVE_ROOT_COPIES=Object.freeze(['agent','promts']);
// Linked (junction on Windows): package resolution only.
export const EVE_ROOT_LINKS=Object.freeze(['node_modules']);

export function assertEveRole(role){
 if(!EVE_ROLES.includes(role))throw new Error(`Eve role must be one of ${EVE_ROLES.join(', ')}`);
 return role;
}

export function eveRootPath(role,{appRoot=process.cwd(),baseDir=join(appRoot,'.local')}={}){
 return join(resolve(baseDir),`eve-${assertEveRole(role)}`);
}

function sameTarget(link,target){
 try{return realpathSync(link)===realpathSync(target);}catch{return false;}
}

// Idempotent. Never replaces an existing entry that points elsewhere.
export function prepareEveRoot(role,{appRoot=process.cwd(),baseDir,link=symlinkSync}={}){
 const root=resolve(appRoot);
 const dir=eveRootPath(role,{appRoot:root,baseDir});
 mkdirSync(dir,{recursive:true,mode:0o700});
 for(const name of EVE_ROOT_COPIES){
  const source=join(root,name),path=join(dir,name);
  if(!existsSync(source))throw new Error(`Eve root source ${name} is missing in ${root}`);
  let stat;
  try{stat=lstatSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}
  // Never recurse through a link: that would delete the shared sources.
  if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw new Error(`${path} is not a plain copied directory. Inspect it before retry.`);
  if(stat)rmSync(path,{recursive:true,force:true});
  cpSync(source,path,{recursive:true,dereference:false,errorOnExist:true});
 }
 for(const name of EVE_ROOT_LINKS){
  const target=join(root,name),path=join(dir,name);
  if(!existsSync(target))throw new Error(`Eve root source ${name} is missing in ${root}`);
  let present=false;
  try{lstatSync(path);present=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(present){if(!sameTarget(path,target))throw new Error(`${path} exists but does not link to ${target}. Inspect it before retry.`);continue;}
  // Junctions need no admin rights on Windows and take absolute targets.
  link(target,path,process.platform==='win32'?'junction':'dir');
 }
 const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 const next=JSON.stringify({...pkg,name:`${pkg.name}-eve-${role}`,scripts:{}},null,2)+'\n';
 const pkgPath=join(dir,'package.json');
 if(!existsSync(pkgPath)||readFileSync(pkgPath,'utf8')!==next)writeFileSync(pkgPath,next,{mode:0o600});
 return dir;
}

// EVE_URL_<ROLE> selects a role's Eve address from one shared .env; EVE_URL/EVE_PORT is the fallback.
export function roleEveAddress(role,env=process.env){
 const roleUrl=env[`EVE_URL_${assertEveRole(role).toUpperCase()}`]?.trim();
 return roleUrl?eveAddress({EVE_URL:roleUrl}):eveAddress(env);
}

// The argument wins over AGENT_ROLE: a shared .env may set AGENT_ROLE for the default root process.
export function cliRole(argv,env){
 return assertEveRole(argv[2]?.trim()||env.AGENT_ROLE?.trim());
}

// Usage: node --env-file=.env investigator/eve-root.mjs <role>
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const role=cliRole(process.argv,process.env);
 const {port,url}=roleEveAddress(role);
 const dir=prepareEveRoot(role);
 console.log(`Eve ${role} app root ready; starting on ${url}`);
 const child=spawn(process.execPath,[eveBinary(),'dev','--no-ui','--no-default-extensions','--host','127.0.0.1','--port',String(port)],
  {cwd:dir,stdio:'inherit',env:{...process.env,AGENT_ROLE:role,EVE_PORT:String(port),EVE_URL:url}});
 child.on('error',()=>{console.error('Eve could not start');process.exitCode=1;});
 child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}
