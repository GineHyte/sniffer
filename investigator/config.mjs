// Per-role investigator configuration and private state paths (Task 25).
// One API process and one worker process per role. Role-specific variables (INVESTIGATOR_<ROLE>_<NAME>,
// COWORKER_ID_<ROLE>) let all three roles share one .env; INVESTIGATOR_<NAME> is the per-process fallback.
import {join,resolve} from 'node:path';
import {INVESTIGATOR_ROLES} from './contract.mjs';
import {taskTarget} from '../task-target.mjs';
import {roleEveAddress} from './eve-root.mjs';

export const DEFAULT_PORTS=Object.freeze({invoice:21961,wallet:21962,supplier:21963});
export const DEFAULT_POLL_MS=5000;
// Same budget as Main's INVESTIGATION_TIMEOUT_MS default: a later report is useless to Main.
export const DEFAULT_DEADLINE_MS=15*60*1000;

export function investigatorRole(value){
 const role=typeof value==='string'?value.trim():value;
 if(!INVESTIGATOR_ROLES.includes(role))throw new Error(`AGENT_ROLE must be one of ${INVESTIGATOR_ROLES.join(', ')}`);
 return role;
}

// `node investigator/<api|worker>.mjs <role>`: the argument wins over AGENT_ROLE (a shared .env may set main).
export function envWithRole(argv=process.argv,env=process.env){
 return {...env,AGENT_ROLE:investigatorRole(argv[2]?.trim()||env.AGENT_ROLE?.trim())};
}

export function roleSetting(env,role,name){
 const specific=env[`INVESTIGATOR_${role.toUpperCase()}_${name}`]?.trim();
 return specific||env[`INVESTIGATOR_${name}`]?.trim()||undefined;
}

export function investigatorPaths(role,{baseDir='.local'}={}){
 const dir=join(resolve(baseDir),`investigator-${investigatorRole(role)}`);
 return {dir,gateJournal:join(dir,'gate-journal.json'),apiLock:join(dir,'api.lock'),workerLock:join(dir,'worker.lock'),tasksDir:join(dir,'tasks')};
}

function positiveInt(value,name,fallback){
 if(value===undefined)return fallback;
 if(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(`${name} must be a positive integer`);
 return Number(value);
}

export function apiConfig(env=process.env){
 const role=investigatorRole(env.AGENT_ROLE);
 const port=positiveInt(roleSetting(env,role,'PORT'),'INVESTIGATOR_PORT',DEFAULT_PORTS[role]);
 if(port>65535)throw new Error('INVESTIGATOR_PORT must be at most 65535');
 const priceLovelace=roleSetting(env,role,'PRICE_LOVELACE');
 const payTo=roleSetting(env,role,'PAY_TO');
 if(!priceLovelace)throw new Error('INVESTIGATOR_PRICE_LOVELACE is required');
 if(!payTo)throw new Error('INVESTIGATOR_PAY_TO is required');
 return {role,port,priceLovelace,payTo,paths:investigatorPaths(role)};
}

export function workerConfig(env=process.env){
 const role=investigatorRole(env.AGENT_ROLE);
 const coworkerId=env[`COWORKER_ID_${role.toUpperCase()}`];
 if(!coworkerId?.trim())throw new Error(`COWORKER_ID_${role.toUpperCase()} must identify the ${role} Coworker`);
 const target=taskTarget({...env,COWORKER_ID:coworkerId});
 return {role,target,eveUrl:roleEveAddress(role,env).url,paths:investigatorPaths(role),
  pollMs:positiveInt(env.INVESTIGATOR_POLL_MS?.trim()||undefined,'INVESTIGATOR_POLL_MS',DEFAULT_POLL_MS),
  deadlineMs:positiveInt(env.INVESTIGATOR_DEADLINE_MS?.trim()||undefined,'INVESTIGATOR_DEADLINE_MS',DEFAULT_DEADLINE_MS)};
}
