import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {CentralClient,ConnectionStore,stateDirectories,stateDirectoryHelp} from '../src/central-client.mjs';
import {VERSION,createRuntime} from '../src/server.mjs';
import {NAME} from '../src/version.mjs';
const token='a'.repeat(43),origin='https://cowork.example';

// Ported from the P16 plugin suite; invitation parsing and warning behavior stay at 2.0.9.
test('Windows uses Local AppData, preserves absolute override, and knows both old roots',()=>{
 const options={platform:'win32',home:'C:\\Users\\Tester',env:{LOCALAPPDATA:'C:\\Users\\Tester\\AppData\\Local'}};
 assert.deepEqual(stateDirectories(options),{root:'C:\\Users\\Tester\\AppData\\Local\\au-cowork-central',legacy:['C:\\Users\\Tester\\.au-cowork-central','C:\\Users\\Tester\\.local\\share\\au-cowork-central']});
 assert.equal(stateDirectories({...options,env:{}}).root,'C:\\Users\\Tester\\AppData\\Local\\au-cowork-central');
 assert.deepEqual(stateDirectories({...options,env:{AC_COWORK_HOME:'D:\\Private\\Cowork'}}),{root:'D:\\Private\\Cowork',legacy:[]});
 for(const root of ['relative','C:relative',''])assert.throws(()=>stateDirectories({...options,env:{AC_COWORK_HOME:root}}),{code:'unsafe_state_directory'});
 assert.deepEqual(stateDirectories({platform:'linux',home:'/users/test',env:{}}),{root:path.join('/users/test','.local','share','au-cowork-central'),legacy:[]});
 assert.deepEqual(stateDirectories({platform:'linux',home:'/users/test',env:{AC_COWORK_HOME:'/private/cowork'}}),{root:'/private/cowork',legacy:[]});
});
test('legacy state keeps original files and leases; duplicate identities and symlinks fail closed',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'p17-state-')),old=new ConnectionStore(path.join(root,'old')),current=path.join(root,'new');
 const row={version:1,connection_id:'11111111-1111-1111-1111-111111111111',credential:'b'.repeat(43),origin,cursor:0,staged:[],consumed_files:[]};
 try{
  await old.save(row);const store=new ConnectionStore(current,{legacyRoots:[old.root]});
  assert.deepEqual(await store.list(),[row]);await store.acquire(row.connection_id);
  await assert.rejects(()=>old.acquire(row.connection_id),{code:'connection_in_use'});
  await store.save({...row,cursor:2});assert.equal((await old.load(row.connection_id)).cursor,2);await store.release(row.connection_id);
  assert.deepEqual(await fs.readdir(current),[]);
  await new ConnectionStore(current).save(row);
  await assert.rejects(()=>new ConnectionStore(current,{legacyRoots:[old.root]}).list(),{code:'connection_selection_required'});
  const link=path.join(root,'linked');await fs.symlink(old.root,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>new ConnectionStore(path.join(root,'other'),{legacyRoots:[link]}).list(),{code:'unsafe_state_directory'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('connector header uses this profile name and version for exchange, reads, mutations and binary requests',async()=>{
 const calls=[];
 const client=new CentralClient({store:{init:async()=>{},acquire:async()=>{},save:async()=>{},release:async()=>{}},fetchFn:async(url,options)=>{
  calls.push({url,...options});return new Response(JSON.stringify({data:url.endsWith('/exchange')?{credential:'b'.repeat(43),room_id:'r',agent_id:'a'}:{room:{}}}));
 }});client.startMonitor=()=>{};
 try{
  await client.connect({invite:origin+'/#/agent-invite/'+token});
  await client.request('/events?after=0');
  await client.request('/messages',{method:'POST',body:{text:'test'},headers:{'idempotency-key':'test-key'}});
  await client.request('/files',{method:'POST',bytes:Buffer.from('test'),headers:{'content-type':'application/octet-stream'}});
  await client.request('/files/f',{raw:true});
  await client.request('/ack',{method:'POST',body:{event_ids:[]}});
  assert.deepEqual(JSON.parse(calls[0].body),{token,display_name:'Cowork agent'});
  assert.equal(calls[0].headers.authorization,undefined);
  assert.equal(calls.length,7);
  for(const call of calls){assert.equal(new URL(call.url).origin,origin);assert.equal(call.headers['X-Cowork-Connector'],NAME+'/'+VERSION);assert.match(call.headers['X-Cowork-Connector'],/^[a-z][a-z0-9-]{0,47}\/\d+\.\d+\.\d+$/);}
  assert.equal(calls[3].headers['idempotency-key'],'test-key');
  assert.equal(calls[4].headers['content-type'],'application/octet-stream');
 }finally{await client.disconnect();}
});
test('unsafe directory MCP error names the human fix and never consumes invitation',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'p17-unsafe-'));const handlers=new Map();let exchanges=0,runtime;
 try{
  await fs.writeFile(path.join(root,'file'),'not a directory');
  const client=new CentralClient({store:new ConnectionStore(path.join(root,'file','child')),fetchFn:async()=>{exchanges++;throw Error('No network');}});
  runtime=await createRuntime({client,injectedServer:{registerTool:(name,_,handler)=>handlers.set(name,handler)}});
  const result=await handlers.get('connect_to_room')({invite:origin+'/#/agent-invite/'+token});
  assert.equal(result.structuredContent.error.code,'unsafe_state_directory');
  assert.equal(result.structuredContent.error.message,stateDirectoryHelp);assert.equal(result.structuredContent.error.retryable,false);assert.equal(exchanges,0);
 }finally{await runtime?.shutdown();await fs.rm(root,{recursive:true,force:true});}
});
test('unsafe legacy directory is rejected before redeeming a fresh invitation',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'p17-legacy-preflight-'));let exchanges=0;
 try{
  const old=path.join(root,'old');await fs.writeFile(old,'not a directory');
  const client=new CentralClient({store:new ConnectionStore(path.join(root,'new'),{legacyRoots:[old]}),fetchFn:async()=>{
   exchanges++;return new Response(JSON.stringify({data:{credential:'b'.repeat(43),room_id:'r',agent_id:'a'}}));
  }});
  await assert.rejects(()=>client.connect({invite:origin+'/#/agent-invite/'+token}),{code:'unsafe_state_directory'});
  assert.equal(exchanges,0,'an unusable legacy directory must not consume the invitation');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('plugin, lock roots, manifests and optional Host version agree with version.mjs',async()=>{
 for(const file of ['package.json','.claude-plugin/plugin.json','.codex-plugin/plugin.json']){
  const manifest=JSON.parse(await fs.readFile(new URL('../'+file,import.meta.url),'utf8'));
  assert.equal(manifest.version,VERSION,file);
  if(file!=='package.json')assert.equal(manifest.name,NAME,file);
 }
 const lock=JSON.parse(await fs.readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(lock.version,VERSION);assert.equal(lock.packages[''].version,VERSION);
 if(NAME==='au-cowork-personal'){
  const host=JSON.parse(await fs.readFile(new URL('../harness/package.json',import.meta.url),'utf8'));
  assert.equal(host.version,VERSION);
  assert.ok((await fs.readFile(new URL('../harness/README.md',import.meta.url),'utf8')).includes(VERSION));
 }
 const other=NAME==='au-cowork-personal'?'moderator':'personal';
 assert.deepEqual(await fs.readFile(new URL('../src/central-client.mjs',import.meta.url)),await fs.readFile(new URL('../../au-cowork-'+other+'/src/central-client.mjs',import.meta.url)));
});
test('duplicate saved connection MCP error explains how the human can select a copy',async()=>{
 const handlers=new Map(),root=await fs.mkdtemp(path.join(tmpdir(),'p17-selection-'));
 const client=new CentralClient({store:new ConnectionStore(root)});
 client.connect=async()=>{throw Object.assign(Error(),{code:'connection_selection_required'});};
 const runtime=await createRuntime({client,injectedServer:{registerTool:(name,_,handler)=>handlers.set(name,handler)}});
 try{
  const result=await handlers.get('connect_to_room')({connection_id:'11111111-1111-1111-1111-111111111111'});
  assert.equal(result.structuredContent.error.code,'connection_selection_required');
  assert.equal(result.structuredContent.error.message,'Ask your human to keep one saved copy of this connection, or set AC_COWORK_HOME to the folder containing the copy to use. Keep the other copy privately until the connection works.');
 }finally{await runtime.shutdown();await fs.rm(root,{recursive:true,force:true});}
});
