import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sessionRegistry} from '../src/session-registries.mjs';
import {ConnectionRegistry} from '../src/connections.mjs';
const methods=['list','reserve','get','update'];
test('remote connection records survive a new session and stay isolated by endpoint',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'au-remote-registry-'));let reads=0;
 const session={get selection(){reads++;return {expectStateDir:'remote:https://one.example/gate',registryKey:'remote:https://one.example/gate'};}};
 try{
  const a=sessionRegistry(session,ConnectionRegistry,methods,{home});assert.equal(reads,0);
  const row=await a.reserve('personal','one-use');
  const b=sessionRegistry(session,ConnectionRegistry,methods,{home});assert.equal((await b.get(row.connection_id,'personal')).identity_name,row.identity_name);
  const other=sessionRegistry({selection:{expectStateDir:'remote:https://two.example/gate',registryKey:'remote:https://two.example/gate'}},ConnectionRegistry,methods,{home});assert.deepEqual(await other.list('personal'),[]);
  await assert.rejects(b.reserve('personal','one-use'),{code:'invite_already_attempted'});
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('remote registry rejects a symlinked profile base',{skip:process.platform==='win32'&&'creating a directory symlink on Windows requires admin or Developer Mode'},async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'au-remote-registry-'));
 try{await fs.symlink(os.tmpdir(),path.join(home,'.au-cowork-remotes'));const r=sessionRegistry({selection:{registryKey:'remote:https://example.test'}},ConnectionRegistry,methods,{home});await assert.rejects(r.list('personal'),{code:'connection_registry_unsafe'});}finally{await fs.rm(home,{recursive:true,force:true});}
});
