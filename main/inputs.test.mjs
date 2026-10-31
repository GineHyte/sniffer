import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRoleInput,buildRoleInputs} from './inputs.mjs';
import {parseInvestigatorInput} from '../investigator/contract.mjs';
import {checkResult} from './test-fixtures.mjs';

const CASE_ID=`case-${'a'.repeat(32)}`;
const OPEN_ORDER={order_id:'PO-2026-003',supplier_vat_id:'DE333333333',ordered_total:{amount:'1190.00',currency:'EUR'},
 description:'Beratungsleistung Oktober 2026: 1 x 1000.00 EUR netto zzgl. 19 % USt'};

function resultWith(openOrder){
 const result=checkResult('medium');
 return {...result,invoice:{...result.invoice,order_reference:'PO-2026-003',...(openOrder===undefined?{}:{open_order:openOrder})}};
}

// Measured live 2026-10-31: a first-time supplier's invoice investigator said "Purchase order PO-2026-001 not supplied".
test('the backend open order reaches the invoice and supplier investigator inputs',()=>{
 const inputs=buildRoleInputs({caseId:CASE_ID,result:resultWith(OPEN_ORDER),fields:null,history:null});
 for(const role of ['invoice','supplier']){
  assert.deepEqual(inputs[role].input.data.open_order,OPEN_ORDER,role);
  assert.deepEqual(parseInvestigatorInput(inputs[role].text,role).data.open_order,OPEN_ORDER,`${role} task description`);
 }
 assert.equal(inputs.invoice.input.data.invoice.order_reference,'PO-2026-003');
 assert.equal(inputs.wallet.input.data.open_order,undefined,'wallet role stays without order data');
});

test('open_order is null without a backend match or from an older backend',()=>{
 for(const openOrder of [null,undefined]){
  const {input}=buildRoleInput('invoice',{caseId:CASE_ID,result:resultWith(openOrder),fields:null,history:null});
  assert.equal(input.data.open_order,null);
 }
});
