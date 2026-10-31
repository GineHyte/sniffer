import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseXml,extractInvoiceFields,textAt} from './xml.mjs';
import {createInvestigatorTask,findCreatedTask,taskOutcome,orgArgs} from './sokosumi-tasks.mjs';
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

test('findCreatedTask: identifies by name, exact description or logical task_id; proves none only on a complete list',async()=>{
 const base={coworkerId:'cw',name:'Sniffer case-1 wallet',description:'{"task_id":"case-1-wallet","x":1}',logicalTaskId:'case-1-wallet',limit:5};
 const listing=tasks=>async args=>{assert.deepEqual(args.slice(0,6),['tasks','list','--coworker-id','cw','--limit','5']);return {tasks};};
 const other={id:'t9',name:'Sniffer case-2 wallet',description:'{"task_id":"case-2-wallet"}',coworkerId:'cw'};
 assert.deepEqual(await findCreatedTask({...base,run:listing([other,{id:'t1',name:'Sniffer case-1 wallet',description:null,coworkerId:'cw'}])}),{outcome:'found',task_id:'t1',listed:2});
 assert.equal((await findCreatedTask({...base,run:listing([{id:'t2',name:null,description:'{"task_id":"case-1-wallet","x":2}',coworkerId:'cw'}])})).task_id,'t2','an earlier attempt with other data still matches by task_id');
 assert.deepEqual(await findCreatedTask({...base,run:listing([other])}),{outcome:'none',listed:1});
 assert.deepEqual(await findCreatedTask({...base,run:listing([])}),{outcome:'none',listed:0});
 const two=await findCreatedTask({...base,run:listing([{id:'t1',name:base.name,coworkerId:'cw'},{id:'t2',description:base.description,coworkerId:'cw'}])});
 assert.deepEqual([two.outcome,two.reason,two.matches],['ambiguous','multiple_matches',['t1','t2']]);
 assert.equal((await findCreatedTask({...base,run:listing(Array(5).fill(other))})).reason,'list_may_be_truncated');
 assert.equal((await findCreatedTask({...base,run:listing([{id:'t3',name:null,description:null,coworkerId:'cw'}])})).reason,'unidentifiable_tasks');
 assert.equal((await findCreatedTask({...base,run:listing([{id:'t4',name:base.name,coworkerId:'other'}])})).reason,'match_for_other_coworker');
 assert.equal((await findCreatedTask({...base,run:listing([{id:'../x',name:base.name,coworkerId:'cw'}])})).reason,'match_without_valid_id');
 assert.equal((await findCreatedTask({...base,run:async()=>{throw new Error('not logged in');}})).outcome,'check_failed');
 assert.equal((await findCreatedTask({...base,run:async()=>({items:[]})})).reason,'list_response_invalid');
 // A match without coworkerId is confirmed with `tasks get`.
 const seen=[];
 const viaGet=async args=>{seen.push(args[1]);return args[1]==='list'?{tasks:[{id:'t5',name:base.name,coworkerId:null}]}:{task:{id:'t5',coworkerId:'cw'}};};
 assert.deepEqual(await findCreatedTask({...base,run:viaGet}),{outcome:'found',task_id:'t5',listed:1});
 assert.deepEqual(seen,['list','get']);
 const getFails=async args=>{if(args[1]==='get')throw new Error('boom');return {tasks:[{id:'t5',name:base.name}]};};
 assert.equal((await findCreatedTask({...base,run:getFails})).outcome,'check_failed');
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
