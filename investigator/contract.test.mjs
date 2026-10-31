import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildInvestigatorInput,parseInvestigatorInput,investigatorTaskId,investigatorPayPath,assertTaskId,MAX_INPUT_CHARS} from './contract.mjs';

const sample={case_id:'chk_01JABCDEF',role:'supplier',tasks:[{source:'S-8',task:'Prüfe den Lieferanten.'}],data:{supplier_history:{approved_count:6}}};

test('build and parse round-trip with the role-derived task_id and agent',()=>{
 const {input,text}=buildInvestigatorInput(sample);
 assert.equal(input.task_id,'chk_01JABCDEF-supplier');
 assert.equal(input.agent,'SupplierInvestigator');
 assert.deepEqual(parseInvestigatorInput(text,'supplier'),input);
});

test('parse rejects the wrong role, a forged task_id, extra keys and non-JSON',()=>{
 const {input,text}=buildInvestigatorInput(sample);
 assert.throws(()=>parseInvestigatorInput(text,'wallet'),/not wallet/);
 assert.throws(()=>parseInvestigatorInput(JSON.stringify({...input,task_id:'chk_other-supplier'})),/task_id/);
 assert.throws(()=>parseInvestigatorInput(JSON.stringify({...input,agent:'WalletInvestigator'})),/agent/);
 assert.throws(()=>parseInvestigatorInput(JSON.stringify({...input,extra:1})),/Invalid investigator input/);
 assert.throws(()=>parseInvestigatorInput('not json'),/not JSON/);
});

test('build refuses unknown roles and oversized input',()=>{
 assert.throws(()=>investigatorTaskId('chk_1','research'),/Unknown investigator role/);
 assert.throws(()=>buildInvestigatorInput({...sample,data:{blob:'x'.repeat(MAX_INPUT_CHARS)}}),/at most/);
});

test('task IDs are validated before they reach a path',()=>{
 assert.equal(investigatorPayPath('cm1abc_DEF-2'),'/pay/cm1abc_DEF-2');
 for(const bad of ['','../x','a/b','a b','-lead',`a${'b'.repeat(128)}`])assert.throws(()=>assertTaskId(bad),/Invalid Sokosumi task ID/);
});
