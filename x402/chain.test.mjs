import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blockfrostChain} from './chain.mjs';

const SPENT='58'.repeat(32),CONSUMER='54'.repeat(32);

function blockfrost(routes){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const path=url.replace('https://bf.test','');calls.push([path,init.headers.project_id]);
  return Object.hasOwn(routes,path)?new Response(JSON.stringify(routes[path]),{status:200}):new Response('{}',{status:404});
 };
 return {calls,chain:blockfrostChain({projectId:'pid',baseUrl:'https://bf.test',fetchImpl})};
}

test('spentBy reads consumed_by_tx and the consumer depth from Blockfrost',async()=>{
 const {calls,chain}=blockfrost({
  [`/txs/${SPENT}/utxos`]:{outputs:[{output_index:0,consumed_by_tx:CONSUMER},{output_index:1,consumed_by_tx:null}]},
  [`/txs/${CONSUMER}`]:{block_height:100},
  '/blocks/latest':{height:103},
 });
 assert.deepEqual(await chain.spentBy(`${SPENT}#0`),{txHash:CONSUMER,confirmations:3});
 assert.equal(await chain.spentBy(`${SPENT}#1`),null);
 assert.ok(calls.every(([,projectId])=>projectId==='pid'));
 // Anything unclear throws, so payOnce stays unknown.
 await assert.rejects(chain.spentBy(`${SPENT}#2`),/does not know/);
 await assert.rejects(chain.spentBy(`${'aa'.repeat(32)}#0`),/does not know/);
 await assert.rejects(chain.spentBy('nope'),/txHash#index/);
 assert.throws(()=>blockfrostChain({projectId:''}),/BLOCKFROST_API_KEY_PREPROD/);
});
