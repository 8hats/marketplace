import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,ConnectionStore,CentralClient} from '../src/server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('Host factory isolates store and origin without environment mutation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cowork-host-'));
 const before={...process.env};
 const injectedServer={registerTool(){},server:{setRequestHandler(){}},sendLoggingMessage:async()=>{}};
 let a,b;
 try{
  a=await createRuntime({injectedServer,clientOptions:{origin:'https://a.example',store:new ConnectionStore(join(root,'a'))}});
  b=await createRuntime({injectedServer,clientOptions:{origin:'https://b.example',store:new ConnectionStore(join(root,'b'))}});
  assert.ok(a.client instanceof CentralClient);assert.notEqual(a.client.store.root,b.client.store.root);
  assert.equal(a.client.origin,'https://a.example');assert.equal(b.client.origin,'https://b.example');assert.ok(JSON.stringify({...process.env})===JSON.stringify(before));
 }finally{await a?.shutdown();await b?.shutdown();await rm(root,{recursive:true,force:true});}
});
