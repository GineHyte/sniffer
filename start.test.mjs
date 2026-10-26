import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eveAddress,eveBinary} from './start.mjs';
import {sokosumiRoot} from './sokosumi-runtime.mjs';
test('Eve rejects a mismatched port or exposed listener',()=>{
 assert.throws(()=>eveAddress({EVE_PORT:'21949',EVE_URL:'http://127.0.0.1:21950'}),/must match/);
 assert.throws(()=>eveAddress({EVE_URL:'http://0.0.0.0:21949'}),/must match/);
 assert.throws(()=>eveAddress({EVE_PORT:'0'}),/integer/);
 assert.deepEqual(eveAddress({EVE_URL:'http://127.0.0.1:21949'}),{port:21949,url:'http://127.0.0.1:21949'});
});
test('Eve executable resolves through Node package lookup',()=>{
 assert.match(eveBinary(),/node_modules\/eve\/bin\/eve\.js$/);
});
test('runtime root derives from supported installed CLI output',()=>{
 assert.equal(sokosumiRoot((command,args)=>{assert.equal(command,'sokosumi');assert.deepEqual(args,['skills','path']);return '/opt/node/lib/node_modules/@masumi_network/sokosumi/skills\n';}),'/opt/node/lib/node_modules/@masumi_network/sokosumi/dist/src');
 assert.throws(()=>sokosumiRoot(()=>'/unrelated'),/invalid package path/);
});
