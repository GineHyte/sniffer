import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseXml,extractInvoiceFields,textAt} from './xml.mjs';
import {createInvestigatorTask,taskOutcome,orgArgs} from './sokosumi-tasks.mjs';
import {F9_XML} from './test-fixtures.mjs';

test('parseXml matches local names, decodes predefined entities and CDATA, refuses DOCTYPE',()=>{
 const doc=parseXml('<?xml version="1.0"?><a:Root xmlns:a="x"><!-- c --><a:B k="1&amp;2">x &lt; y &#228;</a:B><C><![CDATA[<raw>]]></C></a:Root>');
 assert.equal(doc.name,'Root');
 assert.equal(textAt(doc,'B'),'x < y ä');
 assert.equal(doc.children[0].attrs.k,'1&2');
 assert.equal(textAt(doc,'C'),'<raw>');
 assert.throws(()=>parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>'),/DOCTYPE/);
 assert.throws(()=>parseXml('<a><b></a>'),/mismatched|unclosed/);
 assert.throws(()=>parseXml('<a/><b/>'),/more than one/);
});

test('extractInvoiceFields reads the CII fields of fixture F9',()=>{
 const {invoice,wallet,supplier}=extractInvoiceFields(F9_XML);
 assert.deepEqual(invoice.notes,['Bitte dringend überweisen, neue Wallet.']);
 assert.equal(invoice.line_items[0].quantity,'7');
 assert.equal(invoice.line_items[0].unit_code,'HUR');
 assert.equal(invoice.totals.grand_total,'833.00');
 assert.equal(invoice.order_reference,'PO-2026-001');
 assert.match(wallet.address,/^addr_test1qq3zyg/);
 assert.equal(wallet.payment_information,'cardano:preprod:ADA');
 assert.equal(supplier.name,'Alpha Consulting GmbH');
 assert.equal(supplier.vat_id,'DE111111111');
 assert.equal(supplier.address.city,'München');
 assert.equal(supplier.contact.email,'rechnung@alpha-consulting.example');
 assert.throws(()=>extractInvoiceFields('<Invoice/>'),/CII/);
});

test('Sokosumi create passes the description as one argv entry and needs a valid task ID',async()=>{
 const seen=[];
 const run=async args=>{seen.push(args);return {task:{id:'cm1_task-2',status:'READY',coworkerId:'cw'}};};
 const created=await createInvestigatorTask({run,coworkerId:'cw',taskArgs:orgArgs('ws'),name:'n',description:'{"a":"; rm -rf / & echo"}'});
 assert.deepEqual(created,{taskId:'cm1_task-2',status:'READY'});
 assert.deepEqual(seen[0],['tasks','create','--organization-slug','ws','--coworker-id','cw','--name','n','--description','{"a":"; rm -rf / & echo"}','--status','READY']);
 await assert.rejects(createInvestigatorTask({run:async()=>({task:{id:'../x'}}),coworkerId:'cw',name:'n',description:'d'}),/Invalid Sokosumi task ID/);
 await assert.rejects(createInvestigatorTask({run:async()=>({task:{id:'t1',coworkerId:'other'}}),coworkerId:'cw',name:'n',description:'d'}),/another Coworker/);
 assert.throws(()=>orgArgs('bad slug'),/slug/);
});

test('taskOutcome reads the report from the COMPLETED event of the assigned Coworker only',()=>{
 const ids={taskId:'t1',coworkerId:'cw'};
 const task=status=>({id:'t1',status,coworkerId:'cw'});
 assert.equal(taskOutcome({task:task('RUNNING'),events:[]},ids).state,'pending');
 assert.deepEqual(taskOutcome({task:task('COMPLETED'),events:[{status:'COMPLETED',taskId:'t1',comment:'{"r":1}',actor:{type:'coworker',id:'cw'}}]},ids),{state:'completed',status:'COMPLETED',text:'{"r":1}'});
 assert.equal(taskOutcome({task:task('COMPLETED'),events:[{status:'COMPLETED',taskId:'t1',comment:'{}',actor:{type:'user',id:'u'}}]},ids).state,'pending');
 assert.equal(taskOutcome({task:task('FAILED'),events:[]},ids).state,'failed');
 assert.equal(taskOutcome({task:{...task('COMPLETED'),coworkerId:'other'},events:[]},ids).error,'coworker_mismatch');
 assert.equal(taskOutcome({task:{...task('COMPLETED'),id:'t2'}},ids).error,'task_mismatch');
});
