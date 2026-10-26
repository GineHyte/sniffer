import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskTarget,assertTaskTarget,verifyRuntimeTask} from './task-target.mjs';

test('task listing and runtime select the same Personal or organization Workspace',()=>{
 const personal=taskTarget({COWORKER_ID:'coworker'});
 assert.deepEqual(personal,{coworkerId:'coworker',organizationId:null,taskArgs:[],runtimeArgs:['--personal']});
 const organization=taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization',SOKOSUMI_ORGANIZATION_SLUG:'event-workspace'});
 assert.deepEqual(organization,{coworkerId:'coworker',organizationId:'organization',taskArgs:['--organization-slug','event-workspace'],runtimeArgs:['--organization-id','organization']});
 assert.doesNotThrow(()=>assertTaskTarget({coworkerId:'coworker',organizationId:null},personal));
 assert.doesNotThrow(()=>assertTaskTarget({coworkerId:'coworker',organizationId:'organization'},organization));
 assert.throws(()=>assertTaskTarget({coworkerId:'coworker',organizationId:null},organization),/configured Coworker and Workspace/);
 assert.throws(()=>assertTaskTarget({coworkerId:'coworker',organizationId:'organization'},personal),/configured Coworker and Workspace/);
});

test('incomplete or invalid Workspace settings cannot fall back to Personal Workspace',()=>{
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization'}),/Set both/);
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_SLUG:'event-workspace'}),/Set both/);
 assert.throws(()=>taskTarget({COWORKER_ID:'coworker',SOKOSUMI_ORGANIZATION_ID:'organization',SOKOSUMI_ORGANIZATION_SLUG:'event/workspace'}),/slug/);
 assert.throws(()=>taskTarget({}),/COWORKER_ID/);
});

test('runtime reads confirm the current Task before comments or payment operations',async()=>{
 const target={coworkerId:'coworker',organizationId:'organization'};
 let observed={id:'task',assigneeId:'coworker',organizationId:'organization'};
 const client={get:async(path)=>{assert.equal(path,'/v1/tasks/task');return {data:observed};}};
 assert.equal(await verifyRuntimeTask(client,'task',target),client);
 for(const change of [{id:'another-task'},{assigneeId:'another-coworker'},{organizationId:null}]){
  const previous=observed;observed={...observed,...change};
  await assert.rejects(verifyRuntimeTask(client,'task',target),/Runtime Task ID|configured Coworker and Workspace/);
  observed=previous;
 }
});
