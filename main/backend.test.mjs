import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {createSnifferClient,connectionNotEstablished,SnifferApiError} from './backend.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(()=>resolve()));
const client=(port,extra={})=>createSnifferClient({baseUrl:`http://127.0.0.1:${port}`,token:'test-token',...extra});

test('a refused connection (real undici error on a closed local port) is classified connect_failed',async()=>{
 const probe=createServer();
 const port=await listen(probe);
 await close(probe); // nothing listens on this loopback port now
 const error=await client(port).initialCheck('<x/>').catch(caught=>caught);
 assert.ok(error instanceof SnifferApiError);
 assert.deepEqual([error.status,error.code],[0,'connect_failed']);
});

test('a reset after the connection was accepted is NOT connect_failed',async()=>{
 const server=createServer(socket=>socket.once('data',()=>socket.destroy()));
 const port=await listen(server);
 try{
  const error=await client(port).initialCheck('<x/>').catch(caught=>caught);
  assert.deepEqual([error.status,error.code],[0,'network_error']);
 }finally{await close(server);}
});

test('a request timeout is NOT connect_failed; a 5xx keeps its status and code',async()=>{
 const server=createHttpServer((req,res)=>{
  if(req.url==='/v1/initial-check'&&req.headers['x-mode']!=='503')return; // never answers
  res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'dependency_unavailable',message:'x'}));
 });
 const port=await listen(server);
 try{
  const timeout=await client(port,{timeoutMs:100}).initialCheck('<x/>').catch(caught=>caught);
  assert.deepEqual([timeout.status,timeout.code],[0,'network_error']);
  const fetch503=(url,init)=>fetch(url,{...init,headers:{...init.headers,'x-mode':'503'}});
  const unavailable=await client(port,{fetchImpl:fetch503}).initialCheck('<x/>').catch(caught=>caught);
  assert.deepEqual([unavailable.status,unavailable.code],[503,'dependency_unavailable']);
 }finally{server.closeAllConnections();await close(server);}
});

test('connectionNotEstablished walks undici causes and AggregateErrors conservatively',()=>{
 const wrap=cause=>Object.assign(new TypeError('fetch failed'),{cause});
 const sys=code=>Object.assign(new Error(code),{code});
 for(const code of ['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH'])assert.equal(connectionNotEstablished(wrap(sys(code))),true,code);
 for(const code of ['ECONNRESET','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','ETIMEDOUT','EPIPE','UND_ERR_HEADERS_TIMEOUT','ERR_TLS_CERT_ALTNAME_INVALID'])assert.equal(connectionNotEstablished(wrap(sys(code))),false,code);
 const aggregate=errors=>Object.assign(new AggregateError(errors),{code:'ECONNREFUSED'});
 assert.equal(connectionNotEstablished(wrap(aggregate([sys('ECONNREFUSED'),sys('ECONNREFUSED')]))),true);
 assert.equal(connectionNotEstablished(wrap(aggregate([sys('ECONNREFUSED'),sys('ETIMEDOUT')]))),false);
 assert.equal(connectionNotEstablished(Object.assign(new Error('t'),{name:'TimeoutError'})),false);
 assert.equal(connectionNotEstablished(Object.assign(new Error('a'),{name:'AbortError',cause:sys('ECONNREFUSED')})),false);
 assert.equal(connectionNotEstablished(new TypeError('fetch failed')),false);
 assert.equal(connectionNotEstablished(undefined),false);
});
