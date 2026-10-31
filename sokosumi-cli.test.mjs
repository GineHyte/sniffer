import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cliArgs,sokosumi,sokosumiCliEntry,sokosumiSync} from './sokosumi-cli.mjs';

function fakePackage(pkg){
 const dir=mkdtempSync(join(tmpdir(),'soko-'));
 mkdirSync(join(dir,'dist','src'),{recursive:true});
 writeFileSync(join(dir,'package.json'),JSON.stringify(pkg));
 return ()=>join(dir,'dist','src');
}

test('entry resolves the package bin next to the skills root',()=>{
 const root=fakePackage({name:'@masumi_network/sokosumi',bin:{sokosumi:'dist/bin/sokosumi.js'}});
 assert.equal(sokosumiCliEntry({env:{},root}),join(root(),'..','..','dist','bin','sokosumi.js'));
 assert.throws(()=>sokosumiCliEntry({env:{},root:fakePackage({name:'other',bin:{sokosumi:'x.js'}})}),/no sokosumi executable/);
 assert.throws(()=>sokosumiCliEntry({env:{SOKOSUMI_CLI_JS:'relative.js'}}),/absolute/);
});

test('arguments go to the node binary unchanged, without a shell',async()=>{
 const calls=[];
 const run=(file,args,options)=>{calls.push({file,args,options});return '{"ok":true}';};
 assert.deepEqual(sokosumiSync(['tasks','get','id & calc'],{entry:'/cli.js',run}),{ok:true});
 assert.equal(calls[0].file,process.execPath);
 assert.deepEqual(calls[0].args,['/cli.js','--preprod','tasks','get','id & calc','--json']);
 assert.equal(calls[0].options.shell,undefined);
 const asyncRun=async(file,args)=>({stdout:JSON.stringify({args})});
 assert.deepEqual(await sokosumi(['tasks','list'],{entry:'/cli.js',run:asyncRun}),{args:['/cli.js','--preprod','tasks','list','--json']});
});

test('bad arguments and non-JSON output are refused',()=>{
 assert.throws(()=>cliArgs([]),/non-empty/);
 assert.throws(()=>cliArgs(['a\0b']),/NUL/);
 assert.throws(()=>sokosumiSync(['tasks'],{entry:'/cli.js',run:()=>'oops'}),/non-JSON/);
});
