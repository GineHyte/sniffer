import {execFileSync} from 'node:child_process';
import {join,posix,win32} from 'node:path';
import {pathToFileURL} from 'node:url';
let loaded;
export function sokosumiRoot(run=execFileSync,platform=process.platform){
 const windows=platform==='win32',path=windows?win32:posix,options={encoding:'utf8',timeout:30000};
 // Windows installs the CLI as a .cmd shim, which only a shell can start. The command is a fixed string.
 const output=windows?run('sokosumi skills path',[],{...options,shell:true}):run('sokosumi',['skills','path'],options);
 const skillsPath=output.trim().replace(windows?/[\\/]+$/:/\/+$/,'');
 if(!path.isAbsolute(skillsPath)||path.basename(skillsPath)!=='skills')throw new Error('sokosumi skills path returned an invalid package path');
 return path.join(path.dirname(skillsPath),'dist','src');
}
export async function loadSokosumiRuntime(){
 if(!loaded){const root=sokosumiRoot();
  loaded=Promise.all(['coworker/runtime-credentials.js','api/http-client.js','api/services/task-service.js'].map(p=>import(pathToFileURL(join(root,p)).href))).then(modules=>Object.assign({},...modules));
 }
 return loaded;
}
