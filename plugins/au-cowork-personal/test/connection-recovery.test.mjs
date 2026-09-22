import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ConnectionRegistry} from '../src/connections.mjs';

const WIN=process.platform==='win32';
const scratch=()=>fs.mkdtemp(path.join(os.tmpdir(),'au-recovery-'));
const marker=(registry,invite)=>path.join(registry.root,'invite-'+createHash('sha256').update(invite).digest('hex')+'.attempt');
// Age a marker past the reclaim threshold without waiting for it.
const backdate=async(file)=>{const when=new Date(Date.now()-3600_000);await fs.utimes(file,when,when);};

test('a stale invite marker whose connection record is gone is reclaimed instead of dead-ending',async()=>{
 const dir=await scratch();
 try{
  const registry=new ConnectionRegistry(dir);
  const first=await registry.reserve('personal','one-use');
  // Reproduce the residue the pre-1.3.2 Windows directory-fsync abort left behind:
  // the attempt marker is on disk but the connection record never landed.
  await fs.rm(registry.file(first.connection_id));
  await backdate(marker(registry,'one-use'));
  const second=await registry.reserve('personal','one-use');
  assert.notEqual(second.connection_id,first.connection_id);
  assert.equal((await registry.get(second.connection_id,'personal')).identity_name,second.identity_name);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a FRESH marker with no record is never reclaimed: a concurrent reserve must not be stolen',async()=>{
 const dir=await scratch();
 try{
  const registry=new ConnectionRegistry(dir);
  const first=await registry.reserve('personal','one-use');
  // Exactly what a reserve sitting between its two writes looks like on disk. Reclaiming
  // here would redeem one single-use invite twice, which is worse than the dead end.
  await fs.rm(registry.file(first.connection_id));
  await assert.rejects(registry.reserve('personal','one-use'),{code:'invite_already_attempted'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('an invite marker with an intact connection record still blocks a second attempt',async()=>{
 const dir=await scratch();
 try{
  const registry=new ConnectionRegistry(dir);
  const first=await registry.reserve('personal','one-use');
  await backdate(marker(registry,'one-use')); // age alone must not unlock a live record
  await assert.rejects(registry.reserve('personal','one-use'),e=>e.code==='invite_already_attempted'&&e.connection_id===first.connection_id);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a marker that reached the redeem stage is NEVER reclaimable, even stale with no record',async()=>{
 const dir=await scratch();
 try{
  const registry=new ConnectionRegistry(dir);
  const first=await registry.reserve('personal','one-use');
  await registry.attempted('one-use',first.connection_id); // the invite went to the daemon
  // Partial manual cleanup: the record is deleted but the marker survives. Replaying the
  // invite here would redeem a single-use invite a second time.
  await fs.rm(registry.file(first.connection_id));
  await backdate(registry.attemptFile('one-use'));
  await assert.rejects(registry.reserve('personal','one-use'),{code:'invite_already_attempted'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a truncated or unparseable stale marker is treated as reclaimable, not as an internal error',async()=>{
 for(const body of ['','{','{"connection_id":"not-a-uuid"}','null']){
  const dir=await scratch();
  try{
   const registry=new ConnectionRegistry(dir);
   await registry.init();
   const file=marker(registry,'one-use');
   await fs.writeFile(file,body,{mode:0o600});
   await backdate(file);
   const row=await registry.reserve('personal','one-use');
   assert.equal((await registry.get(row.connection_id,'personal')).connection_id,row.connection_id);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }
});

test('a symlinked connection record is rejected with a typed code, never a raw filesystem error',{skip:WIN&&'creating a file symlink on Windows requires admin or Developer Mode'},async()=>{
 const dir=await scratch();
 try{
  const registry=new ConnectionRegistry(dir);
  const row=await registry.reserve('personal','one-use');
  const target=path.join(dir,'elsewhere.json');
  await fs.writeFile(target,JSON.stringify({version:1}),{mode:0o600});
  await fs.rm(registry.file(row.connection_id));
  await fs.symlink(target,registry.file(row.connection_id));
  await assert.rejects(registry.get(row.connection_id,'personal'),{code:'connection_registry_unsafe'});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
