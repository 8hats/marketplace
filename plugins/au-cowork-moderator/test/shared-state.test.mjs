import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {CentralClient,ConnectionStore,failure} from '../src/central-client.mjs';
import {createRuntime} from '../src/server.mjs';

const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const row=id=>({version:1,connection_id:id,credential:(id===ids[0]?'a':'b').repeat(43),origin:'https://cowork.example',room_name:'Shared room',room_id:'room',agent_id:id,display_name:id,expires_at:'2099-01-01T00:00:00.000Z',cursor:0,staged:[],consumed_files:[]});
const json=data=>new Response(JSON.stringify({data}));
function harness(root,id){
 const child=fork(new URL('../test-support/harness.mjs',import.meta.url),[root,id],{stdio:['ignore','ignore','pipe','ipc']});
 const messages=[],waiters=new Set();let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 child.on('message',message=>{messages.push(message);for(const waiter of waiters)waiter();});
 return {child,next:predicate=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Child timeout: '+stderr));},60000);
  const check=()=>{const index=messages.findIndex(predicate);if(index!==-1){clearTimeout(timer);waiters.delete(check);resolve(messages.splice(index,1)[0]);}};
  waiters.add(check);check();
 })};
}

test('independent harness processes share a root, isolate inboxes, refuse live identity reuse and recover a crash',async()=>{
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-processes-')),root=path.join(temporary,'state');
 const store=new ConnectionStore(root),children=[];
 const spawn=id=>{const instance=harness(root,id);children.push(instance.child);return instance;};
 try{
  for(const id of ids)await store.save(row(id));
  const first=spawn(ids[0]),second=spawn(ids[1]);
  await Promise.all([first.next(x=>x.connected),second.next(x=>x.connected)]);
  await Promise.all([first.next(x=>x.event),second.next(x=>x.event)]);
  const duplicate=spawn(ids[0]);assert.equal((await duplicate.next(x=>x.error)).error,'connection_in_use');
  const exits=once(first.child,'exit');first.child.kill();await exits;
  // Both children race to reclaim the dead process's lease; exactly one wins.
  const recoveries=[spawn(ids[0]),spawn(ids[0])];
  const outcomes=await Promise.all(recoveries.map(x=>x.next(m=>m.connected||m.error)));
  assert.equal(outcomes.filter(x=>x.connected).length,1);
  assert.equal(outcomes.find(x=>x.error).error,'connection_in_use');
  const recovered=recoveries[outcomes.findIndex(x=>x.connected)];
  recovered.child.send('read');second.child.send('read');
  assert.deepEqual((await recovered.next(x=>x.read)).read,[ids[0]]);
  assert.deepEqual((await second.next(x=>x.read)).read,[ids[1]]);
  for(const instance of [recovered,second]){instance.child.send('stop');await instance.next(x=>x.stopped);}
  for(const id of ids){const saved=await store.load(id);assert.equal(saved.agent_id,id);assert.equal(saved.credential,row(id).credential);assert.equal(saved.cursor,1);assert.deepEqual(saved.staged,[]);}
 }finally{
  await Promise.all(children.map(async child=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}}));
  await fs.rm(temporary,{recursive:true,force:true});
 }
});

test('bind transition excludes identity switching; shutdown waits and releases its lease',async()=>{
 let resume,entered;const gate=new Promise(resolve=>resume=resolve),started=new Promise(resolve=>entered=resolve);
 const leases=new Set();let polls=0;
 const client=new CentralClient({store:{init:async()=>{},acquire:async id=>leases.add(id),release:async id=>leases.delete(id),load:async id=>row(id)},fetchFn:async(url,options)=>{
  if(url.endsWith('/session')){entered();await gate;return json({});}
  polls++;await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw Error('aborted');
 }});
 const binding=client.connect({connection_id:ids[0]});await started;
 await assert.rejects(()=>client.connect({connection_id:ids[1]}),{code:'session_already_bound'});
 const shutdown=client.disconnect();
 await assert.rejects(()=>client.connect({connection_id:ids[1]}),{code:'session_already_bound'});
 resume();await binding;await shutdown;
 assert.equal(leases.size,0);assert.equal(client.row,null);assert.equal(client.monitorState,'disconnected');assert.ok(polls<=1);
});

test('storage failure stops once, wakes waiters, retains cursor and reconnects after repair',async()=>{
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-monitor-')),store=new ConnectionStore(path.join(temporary,'state'));
 let failSave=true,polls=0;const wakes=[];const save=store.save.bind(store);
 await store.save(row(ids[0]));
 store.save=async value=>{if(failSave)throw failure('unsafe_state_directory');return save(value);};
 const client=new CentralClient({store,onEvent:value=>wakes.push(value),fetchFn:async(url,options)=>{
  if(url.endsWith('/session'))return json({});
  polls++;if(polls<=2)return json({events:[],cursor:1});
  await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw Error('aborted');
 }});
 try{
  await client.connect({connection_id:ids[0]});
  const waiting=client.wait(60000);await client.work;
  assert.deepEqual(await waiting,{status:'unavailable',code:'unsafe_state_directory'});
  assert.deepEqual(wakes,[{status:'unavailable',code:'unsafe_state_directory'}]);
  assert.equal(polls,1);assert.equal((await store.load(ids[0])).cursor,0);
  await client.disconnect();failSave=false;await client.connect({connection_id:ids[0]});
  // Await the durable update without racing monitor scheduling.
  while(client.row.cursor!==1)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await store.load(ids[0])).cursor,1);
 }finally{await client.disconnect();await fs.rm(temporary,{recursive:true,force:true});}
});

test('permanent storage errors are actionable through MCP and never retryable',async()=>{
 const handlers=new Map();const client=new CentralClient({store:{init:async()=>{throw failure('unsafe_state_directory');}}});
 const runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
 try{
  const result=await handlers.get('connect_to_room')({connection_id:ids[0]});
  assert.equal(result.structuredContent.error.code,'unsafe_state_directory');
  assert.equal(result.structuredContent.error.retryable,false);assert.match(result.structuredContent.error.message,/same owning OS user/);
 }finally{await runtime.shutdown();}
});

test('monitor stops after six consecutive transient failures rather than reconnecting forever', {timeout:30000},async()=>{
 let requests=0;const wakes=[];
 const client=new CentralClient({onEvent:value=>wakes.push(value),fetchFn:async()=>{requests++;throw Error('offline');}});
 client.row=row(ids[0]);client.startMonitor();await client.work;
 assert.equal(requests,6);assert.equal(client.monitorState,'monitor_retry_exhausted');
 assert.deepEqual(await client.wait(1000),{status:'unavailable',code:'monitor_retry_exhausted'});
 assert.deepEqual(wakes,[{status:'unavailable',code:'monitor_retry_exhausted'}]);
 await assert.rejects(()=>client.request('/session'),{code:'monitor_retry_exhausted'});
 assert.equal(requests,6);
 client.row=null;await client.disconnect();
});
