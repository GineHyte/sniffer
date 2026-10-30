import {test} from 'node:test';
import assert from 'node:assert/strict';
import {win32} from 'node:path';
import {sokosumiRoot} from './sokosumi-runtime.mjs';
// Bug: sokosumiRoot rejected the real Windows `sokosumi skills path` output (backslashes, trailing separator)
// and could not start the CLI's .cmd shim without a shell, so worker.mjs and comments.mjs failed on Windows.
test('runtime root accepts Windows CLI output with trailing separator',()=>{
 const install='C:\\Users\\o.petrenko\\AppData\\Local\\nvm\\v24.22.2\\node_modules\\@masumi_network\\sokosumi';
 const root=sokosumiRoot((command,args,options)=>{assert.equal(command,'sokosumi skills path');assert.deepEqual(args,[]);assert.equal(options.shell,true);return `${install}\\skills\\\r\n`;},'win32');
 assert.equal(root,win32.join(install,'dist','src'));
 assert.ok(root.endsWith(win32.join('dist','src')));
 assert.throws(()=>sokosumiRoot(()=>'C:\\unrelated\\','win32'),/invalid package path/);
 assert.throws(()=>sokosumiRoot(()=>'skills\\','win32'),/invalid package path/);
});
