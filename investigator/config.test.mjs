import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiConfig,workerConfig,investigatorPaths,investigatorRole,envWithRole,DEFAULT_PORTS} from './config.mjs';

const PAY_TO='addr_test1vqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpcjw59ta';

test('roles are limited to the three investigators',()=>{
 assert.equal(investigatorRole(' wallet '),'wallet');
 for(const bad of [undefined,'','main','research','Invoice'])assert.throws(()=>investigatorRole(bad),/AGENT_ROLE/);
});

test('api config prefers role-specific settings and requires price and payTo',()=>{
 const env={AGENT_ROLE:'wallet',INVESTIGATOR_PRICE_LOVELACE:'1000000',INVESTIGATOR_PAY_TO:'addr_test1generic',INVESTIGATOR_WALLET_PAY_TO:PAY_TO};
 const config=apiConfig(env);
 assert.equal(config.port,DEFAULT_PORTS.wallet);
 assert.equal(config.payTo,PAY_TO);
 assert.equal(config.priceLovelace,'1000000');
 assert.match(config.paths.gateJournal,/investigator-wallet[\\/]gate-journal\.json$/);
 assert.equal(apiConfig({...env,INVESTIGATOR_PORT:'30001'}).port,30001);
 assert.equal(apiConfig({...env,INVESTIGATOR_PORT:'30001',INVESTIGATOR_WALLET_PORT:'30002'}).port,30002);
 assert.throws(()=>apiConfig({...env,INVESTIGATOR_PORT:'70000'}),/at most 65535/);
 assert.throws(()=>apiConfig({...env,INVESTIGATOR_PORT:'1e3'}),/positive integer/);
 assert.throws(()=>apiConfig({AGENT_ROLE:'wallet',INVESTIGATOR_PAY_TO:PAY_TO}),/PRICE_LOVELACE/);
 assert.throws(()=>apiConfig({AGENT_ROLE:'wallet',INVESTIGATOR_PRICE_LOVELACE:'1'}),/PAY_TO/);
});

test('worker config uses the role Coworker, its Workspace and its Eve URL',()=>{
 const env={AGENT_ROLE:'supplier',COWORKER_ID:'starter-coworker',COWORKER_ID_SUPPLIER:'cw-supplier',EVE_URL:'http://127.0.0.1:21949',EVE_URL_SUPPLIER:'http://127.0.0.1:21973'};
 const config=workerConfig(env);
 assert.equal(config.target.coworkerId,'cw-supplier');
 assert.deepEqual(config.target.runtimeArgs,['--personal']);
 assert.equal(config.eveUrl,'http://127.0.0.1:21973');
 assert.equal(workerConfig({...env,EVE_URL_SUPPLIER:''}).eveUrl,'http://127.0.0.1:21949');
 assert.equal(config.pollMs,5000);
 assert.equal(workerConfig({...env,INVESTIGATOR_DEADLINE_MS:'60000'}).deadlineMs,60000);
 assert.throws(()=>workerConfig({...env,COWORKER_ID_SUPPLIER:''}),/COWORKER_ID_SUPPLIER/);
 assert.throws(()=>workerConfig({...env,SOKOSUMI_ORGANIZATION_ID:'org'}),/Set both/);
});

test('the role argument wins over AGENT_ROLE from a shared .env',()=>{
 assert.equal(envWithRole(['node','api.mjs','wallet'],{AGENT_ROLE:'main'}).AGENT_ROLE,'wallet');
 assert.equal(envWithRole(['node','api.mjs'],{AGENT_ROLE:'invoice'}).AGENT_ROLE,'invoice');
 assert.throws(()=>envWithRole(['node','api.mjs'],{AGENT_ROLE:'main'}),/AGENT_ROLE/);
});

test('each role has its own private state directory and lock files',()=>{
 const a=investigatorPaths('invoice',{baseDir:'x'}),b=investigatorPaths('wallet',{baseDir:'x'});
 assert.notEqual(a.dir,b.dir);
 assert.match(a.workerLock,/investigator-invoice[\\/]worker\.lock$/);
 assert.match(a.apiLock,/investigator-invoice[\\/]api\.lock$/);
});
