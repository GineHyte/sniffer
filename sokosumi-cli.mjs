import {execFile,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {sokosumiRoot} from './sokosumi-runtime.mjs';

// Runs the Sokosumi CLI's JS entry with this Node binary. No shell, so task IDs and other
// arguments are never interpreted by cmd.exe or a POSIX shell.
const execFileAsync=promisify(execFile);
const MAX_BUFFER=4*1024*1024;
let cachedEntry;

export function sokosumiCliEntry({env=process.env,root=sokosumiRoot}={}){
 const override=env.SOKOSUMI_CLI_JS?.trim();
 if(override){if(!isAbsolute(override))throw new Error('SOKOSUMI_CLI_JS must be an absolute path');return override;}
 if(root===sokosumiRoot&&cachedEntry)return cachedEntry;
 const packageDir=dirname(dirname(root()));
 const pkg=JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8'));
 const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.sokosumi;
 if(pkg.name!=='@masumi_network/sokosumi'||typeof bin!=='string')throw new Error('Installed Sokosumi CLI package has no sokosumi executable');
 const entry=join(packageDir,bin);
 if(root===sokosumiRoot)cachedEntry=entry;
 return entry;
}

export function cliArgs(args){
 if(!Array.isArray(args)||!args.length)throw new Error('Sokosumi CLI arguments must be a non-empty array');
 for(const arg of args)if(typeof arg!=='string'||arg.includes('\0'))throw new Error('Sokosumi CLI arguments must be strings without NUL');
 return ['--preprod',...args,'--json'];
}

const parse=stdout=>{try{return JSON.parse(stdout)}catch{throw new Error('Sokosumi CLI returned non-JSON output')}};

export function sokosumiSync(args,{entry,run=execFileSync,timeout=30000}={}){
 return parse(run(process.execPath,[entry??sokosumiCliEntry(),...cliArgs(args)],{encoding:'utf8',timeout,maxBuffer:MAX_BUFFER,windowsHide:true}));
}

export async function sokosumi(args,{entry,run=execFileAsync,timeout=30000}={}){
 const {stdout}=await run(process.execPath,[entry??sokosumiCliEntry(),...cliArgs(args)],{encoding:'utf8',timeout,maxBuffer:MAX_BUFFER,windowsHide:true});
 return parse(stdout);
}
