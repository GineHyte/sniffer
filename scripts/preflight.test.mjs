import {test} from 'node:test';
import assert from 'node:assert/strict';
import {minimums,formatTable,requiredFailed,workersRunning,formatAda,REQUIRED_ENV} from './preflight.mjs';

test('per-case minimums: intake + 2 tADA, 3 investigator payments + 2 tADA, payout + 2 tADA',()=>{
 assert.deepEqual(minimums({intakePrice:'1000000',investigatorPrice:'1000000',payout:1_190_000n}),{payer:3_000_000n,mainPayer:5_000_000n,payout:3_190_000n});
 assert.equal(minimums({intakePrice:'1',investigatorPrice:'1',payout:null}).payout,null);
 assert.equal(formatAda(3_190_000n),'3.190000');
});

test('table output and the required-failure rule',()=>{
 const rows=[{name:'a',required:true,status:'PASS',detail:'ok'},{name:'longer check',required:false,status:'WARN',detail:'later'}];
 const table=formatTable(rows).split('\n');
 assert.equal(table.length,4);
 assert.match(table[0],/^STATUS\s+REQ\s+CHECK\s+DETAIL$/);
 assert.match(table[2],/^PASS\s+yes\s+a\s+ok$/);
 assert.equal(requiredFailed(rows),false);
 assert.equal(requiredFailed([...rows,{name:'b',required:false,status:'FAIL'}]),false);
 assert.equal(requiredFailed([...rows,{name:'c',required:true,status:'FAIL'}]),true);
});

test('worker detection matches only the role worker processes',()=>{
 const ps=['COMMAND','node --env-file-if-exists=.env investigator/worker.mjs invoice','node investigator/worker.mjs wallet --x',
  'npm run investigator:worker supplier','grep investigator/worker.mjs supplier','node investigator/worker.mjs invoicex'].join('\n');
 assert.deepEqual(workersRunning(ps),{invoice:1,wallet:1,supplier:0});
});

test('required env covers every Main startup variable',()=>{
 for(const name of ['COWORKER_ID_INVOICE','INVESTIGATOR_SUPPLIER_URL','INVESTIGATOR_WALLET_PAY_TO','INTAKE_PRICE_LOVELACE','INTAKE_PAY_TO','INVESTIGATOR_PRICE_LOVELACE','BLOCKFROST_API_KEY_PREPROD','SNIFFER_API_TOKEN'])
  assert.ok(REQUIRED_ENV.includes(name),name);
});
