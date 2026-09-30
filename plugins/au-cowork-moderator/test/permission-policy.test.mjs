import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ConnectionStore} from '../src/central-client.mjs';
const id='11111111-1111-4111-8111-111111111111';
const row={version:1,connection_id:id,credential:'b'.repeat(43),origin:'https://cowork.example',cursor:0,staged:[],consumed_files:[]};
test('shared POSIX permissions are accepted without changing existing directories or read files',{skip:process.platform==='win32'},async()=>{
 const parent=await fs.mkdtemp(path.join(tmpdir(),'cowork-shared-')),root=path.join(parent,'state');
 try{
  await fs.chmod(parent,0o777);await fs.mkdir(root,{mode:0o775});await fs.chmod(root,0o775);
  const store=new ConnectionStore(root);await store.save(row);await fs.chmod(store.file(id),0o664);
  assert.deepEqual(await store.load(id),row);assert.deepEqual(await store.list(),[row]);
  assert.equal((await fs.stat(store.file(id))).mode&0o777,0o664);
  await store.acquire(id);await fs.chmod(store.file(id)+'.lease',0o666);
  await assert.rejects(()=>new ConnectionStore(root).acquire(id),{code:'connection_in_use'});
  await store.release(id);await store.save({...row,cursor:1});assert.equal((await store.load(id)).cursor,1);
  assert.equal((await fs.stat(parent)).mode&0o777,0o777);assert.equal((await fs.stat(root)).mode&0o777,0o775);
  await fs.writeFile(store.file(id),JSON.stringify({...row,credential:'invalid'}));
  await assert.rejects(()=>store.load(id),{code:'invalid_connection_state'});
 }finally{await fs.rm(parent,{recursive:true,force:true});}
});
