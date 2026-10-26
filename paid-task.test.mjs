import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskHash,purchasePayload,createPaidAdapter,confirmedState,USDM} from './paid-task.mjs';
const registration={walletId:'seller-wallet',agentIdentifier:'a'.repeat(80),supportedPaymentSourceIndex:0};
const payment={sellerReturnAddress:null,forceLayer:null,PaymentSource:{network:'Preprod',paymentSourceType:'Web3CardanoV2',smartContractAddress:'addr_test1contract',policyId:'a'.repeat(56)},SmartContractWallet:{id:'seller-wallet',walletVkey:'b'.repeat(56)},RequestedFunds:[{amount:'1000000',unit:USDM}],agentIdentifier:registration.agentIdentifier,blockchainIdentifier:'signed',inputHash:taskHash('abc'),payByTime:String(Date.now()+100000),submitResultTime:String(Date.now()+200000),unlockTime:'9999999999999',externalDisputeUnlockTime:'9999999999999'};
test('Task compatibility hashes exact UTF-8 bytes without JSON escapes or nonce',()=>{
 assert.equal(taskHash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.notEqual(taskHash('a\nb'),taskHash('a\\nb'));
});
test('signed fields preserved and unsupported signed override rejected',()=>{
 const payload=purchasePayload(payment,'01020304050607',registration);
 assert.equal(payload.blockchainIdentifier,payment.blockchainIdentifier);
 assert.equal(payload.unlockTime,payment.unlockTime);
 assert.throws(()=>purchasePayload({...payment,forceLayer:'L1'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,sellerReturnAddress:'addr_test1seller'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,SmartContractWallet:{id:'other'}},'nonce',registration),/differs/);
});
test('uncertain purchase never reposted',async()=>{
 let posts=0;const adapter=await createPaidAdapter({registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},core:{post:async()=>{posts++;throw Error('timeout')}}});
 await assert.rejects(()=>adapter.advance({id:'task'},{input:'abc',paid:{stage:'purchase-pending'}}),/automatic retry disabled/);
 assert.equal(posts,0);
});
test('unconfirmed escrow does not invoke model',async()=>{
 let sends=0;const adapter=await createPaidAdapter({registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...payment,onChainState:'FundsLocked',CurrentTransaction:{status:'Pending'}})});
 const state=await adapter.advance({id:'task'},{input:'abc',paid:{stage:'awaiting-escrow',payment}});
 assert.equal(sends,0);assert.equal(state.paid.stage,'awaiting-escrow');
});
test('expired deadline prevents model after confirmed read',async()=>{
 let sends=0;const expired={...payment,submitResultTime:'1'};
 const adapter=await createPaidAdapter({registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...expired,onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}})});
 await assert.rejects(()=>adapter.advance({id:'task'},{input:'abc',paid:{stage:'awaiting-escrow',payment:expired}}),/deadline expired/);
 assert.equal(sends,0);
});

test('confirmed history proves lock when CurrentTransaction is absent',()=>{
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'FundsLocked'}]},'FundsLocked'),true);
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'ResultSubmitted'}]},'FundsLocked'),false);
});
test('successful quote survives later payload rejection',async()=>{
 let saved; const adapter=await createPaidAdapter({registration,save:async(_,s)=>{saved=s},answer:async()=>{},mps:async()=>({...payment,forceLayer:'L1'})});
 const state=await adapter.advance({id:'task'},{input:'abc'});
 assert.equal(saved.paid.payment.blockchainIdentifier,'signed');
 assert.equal(state.paid.stage,'terms-saved');
 await assert.rejects(()=>adapter.advance({id:'task'},state),/cannot preserve/);
});

test('running MPS legacy response without unsigned forceLayer is supported',()=>{const older={...payment};delete older.forceLayer;assert.equal(purchasePayload(older,'nonce',registration).blockchainIdentifier,'signed');});

test('unrelated confirmed transaction cannot prove escrow',()=>{assert.equal(confirmedState({CurrentTransaction:{status:'Confirmed',newOnChainState:'Withdrawn'}},'FundsLocked'),false)});
