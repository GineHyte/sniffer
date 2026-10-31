import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,lstatSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareEveRoot,eveRootPath,roleEveAddress,cliRole} from './eve-root.mjs';

function fakeApp(){
 const dir=mkdtempSync(join(tmpdir(),'eve-root-'));
 const app=join(dir,'app');
 mkdirSync(join(app,'agent','instructions'),{recursive:true});
 mkdirSync(join(app,'promts'),{recursive:true});
 mkdirSync(join(app,'node_modules','eve'),{recursive:true});
 writeFileSync(join(app,'agent','agent.ts'),'export default {};\n');
 writeFileSync(join(app,'agent','instructions','role.ts'),'// v1\n');
 writeFileSync(join(app,'promts','invoice_investigator.txt'),'prompt v1\n');
 writeFileSync(join(app,'node_modules','eve','sentinel'),'keep\n');
 writeFileSync(join(app,'package.json'),JSON.stringify({name:'sniffer',type:'module',scripts:{start:'x'},dependencies:{eve:'0.71.0'}}));
 return {dir,app,base:join(dir,'base'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('prepares a per-role app root: copied sources, linked node_modules, renamed package',()=>{
 const env=fakeApp();
 try{
  const root=prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base});
  assert.equal(root,eveRootPath('invoice',{appRoot:env.app,baseDir:env.base}));
  assert.equal(readFileSync(join(root,'promts','invoice_investigator.txt'),'utf8'),'prompt v1\n');
  assert.equal(lstatSync(join(root,'agent')).isSymbolicLink(),false,'agent is a real copy');
  assert.equal(lstatSync(join(root,'node_modules')).isSymbolicLink(),true);
  assert.equal(realpathSync(join(root,'node_modules')),realpathSync(join(env.app,'node_modules')));
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'sniffer-eve-invoice');
  assert.deepEqual(pkg.scripts,{});
  assert.equal(pkg.dependencies.eve,'0.71.0');
  assert.notEqual(prepareEveRoot('wallet',{appRoot:env.app,baseDir:env.base}),root);
 }finally{env.cleanup();}
});

test('a second prepare refreshes the copies and keeps the link',()=>{
 const env=fakeApp();
 try{
  const root=prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base});
  writeFileSync(join(root,'agent','stale.ts'),'old');
  writeFileSync(join(env.app,'agent','instructions','role.ts'),'// v2\n');
  prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base});
  assert.equal(readFileSync(join(root,'agent','instructions','role.ts'),'utf8'),'// v2\n');
  assert.equal(existsSync(join(root,'agent','stale.ts')),false);
  assert.equal(existsSync(join(env.app,'node_modules','eve','sentinel')),true);
 }finally{env.cleanup();}
});

test('never replaces entries it did not create',()=>{
 const env=fakeApp();
 try{
  const root=eveRootPath('invoice',{appRoot:env.app,baseDir:env.base});
  mkdirSync(join(root,'node_modules'),{recursive:true});
  assert.throws(()=>prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base}),/does not link/);
  rmSync(join(root,'node_modules'),{recursive:true});
  rmSync(join(root,'agent'),{recursive:true,force:true});
  symlinkSync(join(env.app,'agent'),join(root,'agent'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base}),/not a plain copied directory/);
  assert.equal(existsSync(join(env.app,'agent','agent.ts')),true,'the shared source is untouched');
 }finally{env.cleanup();}
 assert.throws(()=>eveRootPath('research'),/Eve role/);
});

test('removing a prepared root keeps the shared node_modules',()=>{
 const env=fakeApp();
 try{
  prepareEveRoot('invoice',{appRoot:env.app,baseDir:env.base});
  rmSync(env.base,{recursive:true,force:true});
  assert.equal(readFileSync(join(env.app,'node_modules','eve','sentinel'),'utf8'),'keep\n');
 }finally{env.cleanup();}
});

test('the role argument wins over AGENT_ROLE; main is a valid Eve role',()=>{
 assert.equal(cliRole(['node','eve-root.mjs','supplier'],{AGENT_ROLE:'main'}),'supplier');
 assert.equal(cliRole(['node','eve-root.mjs'],{AGENT_ROLE:'main'}),'main');
 assert.throws(()=>cliRole(['node','eve-root.mjs'],{}),/Eve role/);
});

test('EVE_URL_<ROLE> selects the role Eve address, EVE_URL is the fallback',()=>{
 assert.deepEqual(roleEveAddress('wallet',{EVE_URL:'http://127.0.0.1:21949',EVE_URL_WALLET:'http://127.0.0.1:21972'}),{port:21972,url:'http://127.0.0.1:21972'});
 assert.deepEqual(roleEveAddress('main',{EVE_PORT:'21949'}),{port:21949,url:'http://127.0.0.1:21949'});
 assert.throws(()=>roleEveAddress('wallet',{EVE_URL_WALLET:'http://localhost:1'}),/EVE_URL must match/);
});
