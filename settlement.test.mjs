import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sellerTokenNet} from './settlement.mjs';
test('seller change does not inflate token receipt',()=>{
 const amount=quantity=>[{unit:'token',quantity}];
 assert.equal(sellerTokenNet({inputs:[{address:'seller',amount:amount('100')}],outputs:[{address:'seller',amount:amount('101')},{address:'buyer',amount:amount('99')}]},'seller','token'),1n);
});
