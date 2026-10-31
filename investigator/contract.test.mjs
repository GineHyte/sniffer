import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildInvestigatorInput,parseInvestigatorInput,stripDescriptionPrefix,investigatorTaskId,investigatorPayPath,assertTaskId,MAX_INPUT_CHARS} from './contract.mjs';

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

// Regression: Sokosumi Preprod prepends the Workspace DESIGN.md link to stored task descriptions (measured 2026-10-31).
const DESIGN_LINK='[DESIGN.md](https://yhpsw8jlcoagsrkq.public.blob.vercel-storage.com/design-md/organizations/01a18c39-0cdb-77cc-9947-823c4187b1d7/2762-56ea5e5aeef430703f4716e3d137c096c6df3f4def3526e035db4eb0fbb984af.md)';

test('parse accepts the Sokosumi design-doc link prefix and nothing else in front of the JSON',()=>{
 const {input,text}=buildInvestigatorInput(sample);
 assert.equal(stripDescriptionPrefix(text),text);
 assert.equal(stripDescriptionPrefix(`${DESIGN_LINK}\n\nSmoke test: unpaid task, the worker should skip it.`),'Smoke test: unpaid task, the worker should skip it.');
 assert.deepEqual(parseInvestigatorInput(`${DESIGN_LINK}\n\n${text}`,'supplier'),input);
 assert.deepEqual(parseInvestigatorInput(` ${DESIGN_LINK} \r\n[Style](https://example.com/s.md)\n \n\n${text}`,'supplier'),input,'several link lines, whitespace and CRLF');
 for(const bad of [`${DESIGN_LINK}\n${text}`,`${DESIGN_LINK} ${text}`,`[DESIGN.md](http://example.com/d.md)\n\n${text}`,`See [DESIGN.md](https://example.com/d.md)\n\n${text}`,`Note\n\n${text}`,`\n${DESIGN_LINK}\n\n${text}`])
  assert.throws(()=>parseInvestigatorInput(bad,'supplier'),/not JSON/,JSON.stringify(bad.slice(0,60)));
 assert.throws(()=>parseInvestigatorInput(`${DESIGN_LINK}\n\n `),/1 to/);
 assert.throws(()=>parseInvestigatorInput(`${DESIGN_LINK}\n\n${'x'.repeat(MAX_INPUT_CHARS+1)}`),/1 to/);
});

test('build refuses unknown roles and oversized input',()=>{
 assert.throws(()=>investigatorTaskId('chk_1','research'),/Unknown investigator role/);
 assert.throws(()=>buildInvestigatorInput({...sample,data:{blob:'x'.repeat(MAX_INPUT_CHARS)}}),/at most/);
});

test('task IDs are validated before they reach a path',()=>{
 assert.equal(investigatorPayPath('cm1abc_DEF-2'),'/pay/cm1abc_DEF-2');
 for(const bad of ['','../x','a/b','a b','-lead',`a${'b'.repeat(128)}`])assert.throws(()=>assertTaskId(bad),/Invalid Sokosumi task ID/);
});
