import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CentralClient,ConnectionStore} from '../src/central-client.mjs';

test('storage accepts broadened native permissions',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'cowork-platform-')),root=join(temporary,'private');
 try{
  const store=new ConnectionStore(root);await store.init();
  const row={version:1,connection_id:'11111111-1111-1111-1111-111111111111',credential:'b'.repeat(43),origin:'https://cowork.example',cursor:0,staged:[],consumed_files:[]};
  await store.save(row);assert.deepEqual(await store.load(row.connection_id),row);
  if(process.platform==='win32')execFileSync('icacls.exe',[store.file(row.connection_id),'/grant','*S-1-1-0:(R)'],{stdio:'ignore'});else await chmod(store.file(row.connection_id),0o644);
  assert.deepEqual(await store.load(row.connection_id),row);
  await store.acquire(row.connection_id);await store.release(row.connection_id);
  await store.save({...row,cursor:1});assert.equal((await store.load(row.connection_id)).cursor,1);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
test('storage preflight prevents consuming an invitation when credentials cannot be stored',async()=>{
 let requests=0;
 const client=new CentralClient({store:{init:async()=>{throw Object.assign(Error('unsafe'),{code:'unsafe_state_directory'});}},fetchFn:async()=>{requests++;throw Error('No network allowed');}});
 await assert.rejects(()=>client.connect({invite:'https://cowork.example/#/agent-invite/'+'a'.repeat(43)}),{code:'unsafe_state_directory'});assert.equal(requests,0);
});
