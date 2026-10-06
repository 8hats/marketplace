import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fork,execFileSync} from 'node:child_process';
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
 const client=new CentralClient({store:{init:async()=>{},acquire:async id=>leases.add(id),release:async id=>leases.delete(id),load:async id=>row(id),save:async()=>{}},fetchFn:async(url,options)=>{
  if(url.endsWith('/session')){entered();await gate;return json({});}
  polls++;await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});throw Error('aborted');
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
 store.save=async value=>{if(failSave&&value.cursor>0)throw failure('unsafe_state_directory');return save(value);};
 const client=new CentralClient({store,onEvent:value=>wakes.push(value),fetchFn:async(url,options)=>{
  if(url.endsWith('/session'))return json({});
  polls++;if(polls<=2)return json({events:[],cursor:1});
  await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});throw Error('aborted');
 }});
 try{
  await client.connect({connection_id:ids[0]});
  const waiting=client.wait(60000);await client.work;
  const result=await waiting;assert.equal(result.status,'unavailable');assert.equal(result.code,'unsafe_state_directory');
  assert.deepEqual(wakes,[{status:'unavailable',code:'unsafe_state_directory'}]);
  assert.equal(polls,1);assert.equal((await store.load(ids[0])).cursor,0);
  failSave=false;await client.disconnect();await client.connect({connection_id:ids[0]});
  // Await the durable update without racing monitor scheduling.
  const deadline=Date.now()+30000;
  while(client.row.cursor!==1&&Date.now()<deadline&&['running','reconnecting'].includes(client.monitorState))await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(client.row.cursor,1,'durable cursor did not advance: '+client.monitorState);
  assert.equal((await store.load(ids[0])).cursor,1);
 }finally{await client.disconnect();await fs.rm(temporary,{recursive:true,force:true});}
});

test('permanent storage errors are actionable through MCP and never retryable',async()=>{
 const handlers=new Map();const client=new CentralClient({store:{init:async()=>{throw failure('unsafe_state_directory');}}});
 const runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
 try{
  const result=await handlers.get('connect_to_room')({connection_id:ids[0]});
  assert.equal(result.structuredContent.error.code,'unsafe_state_directory');
  assert.equal(result.structuredContent.error.retryable,false);assert.match(result.structuredContent.error.message,/absolute directory path/);
 }finally{await runtime.shutdown();}
});

test('monitor stops immediately on authorization failure without a transport retry',async()=>{
 let requests=0,retries=0;const wakes=[];
 const client=new CentralClient({onEvent:value=>wakes.push(value),retryDelayFn:async()=>{retries++;},fetchFn:async()=>{
  requests++;return new Response(JSON.stringify({error:{code:'unauthenticated'}}),{status:401});
 }});
 client.row=row(ids[0]);client.startMonitor();await client.work;
 assert.equal(requests,1);assert.equal(retries,0);assert.equal(client.monitorState,'unauthenticated');
 const result=await client.wait(1000);assert.equal(result.status,'unavailable');assert.equal(result.code,'unauthenticated');
 assert.deepEqual(wakes,[{status:'unavailable',code:'unauthenticated'}]);
 await assert.rejects(()=>client.request('/session'),{code:'unauthenticated'});
 assert.equal(requests,1);
 client.row=null;await client.disconnect();
});

test('actual unsafe root during disconnect reports unavailable, retains lease, and permits repair/reconnect',async()=>{
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-repair-')),store=new ConnectionStore(path.join(temporary,'state'));
 await store.save(row(ids[0]));let polls=0;
 const moved=store.root+'.saved';
 const change=async unsafe=>{
  if(unsafe){await fs.rename(store.root,moved);await fs.writeFile(store.root,'invalid directory fixture');}
  else if(await fs.stat(moved).then(()=>true,()=>false)){await fs.unlink(store.root);await fs.rename(moved,store.root);}
 };
 const client=new CentralClient({store,fetchFn:async(url,options)=>{
  if(url.endsWith('/session'))return json({});
  polls++;await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});throw Error('aborted');
 }});
 const handlers=new Map();await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
 try{
  await client.connect({connection_id:ids[0]});const waiting=client.wait(60000);
  await change(true);
  await assert.rejects(()=>client.disconnect(),{code:'unsafe_state_directory'});
  const result=await waiting;assert.equal(result.status,'unavailable');assert.equal(result.code,'unsafe_state_directory');
  assert.equal(client.row.connection_id,ids[0]);assert.equal(store.leases.has(ids[0]),true);
  const status=(await handlers.get('get_room_status')({})).structuredContent.data;
  assert.equal(status.monitoring,'unsafe_state_directory');assert.equal(status.can_read,false);assert.equal(status.can_send,false);
  const wake=(await handlers.get('wait_for_room_event')({})).structuredContent;
  assert.equal(wake.status,'unavailable');assert.match(wake.message,/absolute directory path/);
  await assert.rejects(()=>client.request('/session'),{code:'unsafe_state_directory'});
  await change(false);await client.disconnect();assert.equal(store.leases.size,0);
  await client.connect({connection_id:ids[0]});assert.equal(client.row.credential,row(ids[0]).credential);
  await client.disconnect();assert.equal(store.leases.size,0);assert.ok(polls<=2);
 }finally{await change(false);await client.disconnect();await fs.rm(temporary,{recursive:true,force:true});}
});


test('a fresh lease winner between stale unlink and recreate is preserved',async t=>{
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-recovery-gap-')),root=path.join(temporary,'state');
 const seed=new ConnectionStore(root),loser=new ConnectionStore(root),winner=new ConnectionStore(root),id=ids[0];
 const filename=seed.file(id)+'.lease';
 const originalOpen=fs.open.bind(fs);let exclusiveAttempts=0,winnerLease;
 try {
  await seed.save(row(id));await seed.acquire(id);
  const deadPid=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}));
  const stale=JSON.parse(await fs.readFile(filename,'utf8'));stale.pid=deadPid;
  await fs.writeFile(filename,JSON.stringify(stale));
  t.mock.method(fs,'open',async(target,flags,...args)=>{
   if(target===filename&&(flags&fsConstants.O_EXCL)&&++exclusiveAttempts===2){
    // Force the real winner to acquire in the unlink/recreate gap.
    await winner.acquire(id);winnerLease=await fs.readFile(filename,'utf8');
   }
   return originalOpen(target,flags,...args);
  });
  await assert.rejects(loser.acquire(id),{code:'connection_in_use'});
  assert.equal(loser.leases.size,0);assert.equal(winner.leases.size,1);
  assert.equal(await fs.readFile(filename,'utf8'),winnerLease);
  await assert.rejects(fs.stat(filename+'.recovery'),{code:'ENOENT'});
  assert.deepEqual(await winner.load(id),row(id));
  await winner.release(id);await loser.acquire(id);await loser.release(id);
 }finally{t.mock.restoreAll();await fs.rm(temporary,{recursive:true,force:true});}
});
