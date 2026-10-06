import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {CentralClient,ConnectionStore} from '../src/central-client.mjs';
import {createRuntime} from '../src/server.mjs';

const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const origin='https://cowork.example';
const row=(id=ids[0],extra={})=>({version:1,connection_id:id,credential:'a'.repeat(43),origin,room_name:'Room',room_id:'room',agent_id:id,display_name:'Agent',expires_at:'2099-01-01T00:00:00.000Z',cursor:0,staged:[],consumed_files:[],...extra});
const event={event_id:'event',seq:1,kind:'message',resource:{kind:'message',id:'message'}};
const json=data=>new Response(JSON.stringify({data}));
const server=handlers=>({registerTool:(name,descriptor,handler)=>handlers?.set(name,handler)});
const hold=options=>delay(100000,undefined,{signal:options.signal});
async function fixture(t){
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-watch-'));
 const store=new ConnectionStore(path.join(temporary,'state'));
 store.testCleanups=[];
 t.after(async()=>{for(const cleanup of store.testCleanups)await cleanup();await fs.rm(temporary,{recursive:true,force:true});});
 return store;
}
async function until(predicate){
 for(let attempt=0;attempt<400;attempt++){if(predicate())return;await delay(5);}
 assert.fail('monitor did not reach expected state');
}

test('runtime shutdown preserves watch intent and the next runtime automatically restores it',async t=>{
 const store=await fixture(t),calls=[];
 const fetchFn=async(url,options)=>{
  calls.push(url);
  if(url.endsWith('/exchange'))return json(row());
  if(url.endsWith('/session'))return json({});
  return hold(options);
 };
 const first=await createRuntime({injectedServer:server(),clientOptions:{store,fetchFn}});
 store.testCleanups.push(()=>first.shutdown());
 const connected=await first.client.connect({invite:origin+'/#/agent-invite/'+'b'.repeat(43)});
 assert.equal((await store.load(connected.connection_id)).watch_enabled,true);
 await first.shutdown();assert.equal(store.leases.size,0);
 assert.equal((await store.load(connected.connection_id)).watch_enabled,true);
 calls.length=0;
 const second=await createRuntime({injectedServer:server(),clientOptions:{store,fetchFn}});
 store.testCleanups.push(()=>second.shutdown());
 assert.equal(second.client.row.connection_id,connected.connection_id);
 await until(()=>calls.some(url=>url.includes('/events')));
 assert.equal(calls.some(url=>url.endsWith('/session')),false,'restore must not depend on an online session check');
});

test('a killed process restores watch intent and reclaims its dead lease without connecting again',{timeout:15000},async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true}));
 const children=[];
 const spawn=()=>{
  const child=fork(new URL('../test-support/watch-runtime.mjs',import.meta.url),[store.root],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,AC_COWORK_CONNECTION_ID:ids[0]}});
  children.push(child);return child;
 };
 store.testCleanups.push(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}});
 const first=spawn(),[started]=await once(first,'message');assert.equal(started.connection_id,ids[0]);assert.equal(started.monitoring,'running');
 const exit=once(first,'exit');first.kill('SIGKILL');await exit;
 assert.equal((await store.load(ids[0])).watch_enabled,true);
 const second=spawn(),[restored]=await once(second,'message');assert.equal(restored.connection_id,ids[0]);assert.equal(restored.monitoring,'running');assert.equal(restored.restore_error,undefined);
 const stopped=once(second,'exit');second.send('stop');await stopped;
 assert.equal((await store.load(ids[0])).watch_enabled,true);
 await assert.rejects(()=>fs.stat(store.file(ids[0])+'.lease'),{code:'ENOENT'});
});

test('a supplied already-connected client keeps its existing monitor',async t=>{
 const store=await fixture(t);await store.save(row());
 const client=new CentralClient({store,fetchFn:async(url,options)=>url.endsWith('/session')?json({}):hold(options)});
 await client.connect({connection_id:ids[0]});
 const runtime=await createRuntime({client,injectedServer:server()});store.testCleanups.push(()=>runtime.shutdown());
 assert.equal(client.row.connection_id,ids[0]);assert.equal(client.monitorState,'running');assert.equal(client.restoreError,null);
});

test('body-stream outages retry beyond six attempts before catching up durably',async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true}));let polls=0,retries=0;
 const client=new CentralClient({store,retryDelayFn:async()=>{retries++;},fetchFn:async(url,options)=>{
  polls++;
  if(polls<=8)return new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}}));
  if(polls===9)return json({events:[event],cursor:1});
  return hold(options);
 }});
 const runtime=await createRuntime({client,injectedServer:server()});store.testCleanups.push(()=>runtime.shutdown());
 await until(()=>client.row.cursor===1);
 assert.equal(retries,8);assert.equal(client.monitorState,'running');assert.deepEqual((await store.load(ids[0])).staged,[event]);
});

test('body-stream cancellation, size limits and malformed protocol retain distinct errors',async t=>{
 const store=await fixture(t),abort=new AbortController();abort.abort();
 const request=async(fetchFn,options,code)=>{
  const client=new CentralClient({store,origin,fetchFn});
  await assert.rejects(()=>client.request('/session',options),{code});
 };
 await request(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}})),{signal:abort.signal},'cancelled');
 await request(async()=>new Response(new Uint8Array(4*1024*1024+1)),{},'response_too_large');
 await request(async()=>new Response('invalid json'),{},'invalid_central_response');
});

test('explicit disconnect disables restoration while retaining credentials and inbox',async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true,cursor:1,staged:[event]}));
 const fetchFn=async(url,options)=>hold(options);
 const handlers=new Map();
 const first=await createRuntime({injectedServer:server(handlers),clientOptions:{store,fetchFn}});
 store.testCleanups.push(()=>first.shutdown());
 await handlers.get('disconnect_from_room')({});await first.shutdown();
 const saved=await store.load(ids[0]);assert.equal(saved.watch_enabled,false);
 assert.equal(saved.credential,row().credential);assert.deepEqual(saved.staged,[event]);
 const second=await createRuntime({injectedServer:server(),clientOptions:{store,fetchFn}});
 store.testCleanups.push(()=>second.shutdown());assert.equal(second.client.row,null);
 await assert.rejects(()=>second.client.restore({connection_id:ids[0]}),{code:'connection_not_watched'});
});

test('multiple watched identities fail closed until an explicit watched ID is selected',async t=>{
 const store=await fixture(t);for(const id of ids)await store.save(row(id,{watch_enabled:true}));
 const wakes=[],handlers=new Map();
 const client=new CentralClient({store,fetchFn:async(url,options)=>hold(options),onEvent:value=>wakes.push(value)});
 const runtime=await createRuntime({client,injectedServer:server(handlers)});store.testCleanups.push(()=>runtime.shutdown());
 assert.equal(client.row,null);assert.equal(client.restoreError.code,'connection_selection_required');
 assert.ok(wakes.some(value=>value.status==='unavailable'&&value.code==='connection_selection_required'));
 const status=(await handlers.get('get_room_status')({})).structuredContent;
 assert.ok(JSON.stringify(status).includes('connection_selection_required'));
 assert.equal(store.leases.size,0);
 await client.restore({connection_id:ids[1]});assert.equal(client.row.connection_id,ids[1]);
 assert.equal(store.leases.has(ids[0]),false);
});

test('restore refuses a live lease and never steals another runtime identity',async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true}));await store.acquire(ids[0]);
 store.testCleanups.push(()=>store.release(ids[0]));
 const contender=new ConnectionStore(store.root),client=new CentralClient({store:contender,fetchFn:async()=>assert.fail('no request before lease ownership')});
 await assert.rejects(()=>client.restore(),{code:'connection_in_use'});
 assert.equal(client.row,null);assert.equal(contender.leases.size,0);assert.equal(store.leases.size,1);
 assert.equal((await store.load(ids[0])).watch_enabled,true);
});

test('old saved records are not automatically adopted, even with an explicit startup ID',async t=>{
 const store=await fixture(t);await store.save(row());
 const client=new CentralClient({store,fetchFn:async()=>assert.fail('old records must not trigger network traffic')});
 assert.equal(await client.restore(),null);await assert.rejects(()=>client.restore({connection_id:ids[0]}),{code:'connection_not_watched'});
 assert.equal(store.leases.size,0);assert.equal((await store.load(ids[0])).watch_enabled,undefined);
});

test('restore wakes durable backlog without consuming or acknowledging it',async t=>{
 const backlog=[event,{...event,event_id:'second-event',seq:2,resource:{kind:'message',id:'second-message'}}];
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true,cursor:2,staged:backlog}));
 const wakes=[],calls=[];
 const client=new CentralClient({store,onEvent:value=>wakes.push(value),fetchFn:async(url,options)=>{calls.push(url);return hold(options);}});
 const runtime=await createRuntime({client,injectedServer:server()});store.testCleanups.push(()=>runtime.shutdown());
 await until(()=>wakes.some(value=>value.status==='event'));
 assert.equal((await client.wait(1000)).status,'event');
 assert.deepEqual((await store.load(ids[0])).staged,backlog);
 assert.equal((await store.load(ids[0])).cursor,2);
 assert.deepEqual(wakes.filter(value=>value.status==='event').map(value=>value.event.event_id),['event','second-event']);
 assert.equal(calls.some(url=>url.endsWith('/ack')||url.endsWith('/messages/message')),false);
});

test('startup during outage retries beyond six failures with capped jitter then stages recovery mail',async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true}));
 let polls=0;const waits=[],wakes=[];
 const client=new CentralClient({store,onEvent:value=>wakes.push(value),retryDelayFn:async(ms,value,options)=>{
  assert.equal(value,undefined);assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted,false);waits.push(ms);
 },fetchFn:async(url,options)=>{
  assert.ok(url.includes('/events'),'startup must skip /session while offline');
  polls++;if(polls<=12)throw Error('offline');
  if(polls===13)return json({events:[event],cursor:1});
  return hold(options);
 }});
 const runtime=await createRuntime({client,injectedServer:server()});store.testCleanups.push(()=>runtime.shutdown());
 await until(()=>client.row?.cursor===1&&wakes.some(value=>value.status==='event'));
 assert.equal(waits.length,12);assert.ok(polls>=13);assert.equal(client.monitorState,'running');
 // Jitter spans 75–125% of the base, with the actual delay capped at 30 seconds.
 for(let index=0;index<waits.length;index++){
  const base=Math.min(30000,500*2**Math.min(index,6));
  assert.ok(waits[index]>=Math.floor(base*0.75)&&waits[index]<=Math.min(30000,Math.ceil(base*1.25)));
 }
 assert.equal(wakes.some(value=>value.status==='unavailable'),false);
 assert.deepEqual((await store.load(ids[0])).staged,[event]);
});

test('restore refuses pending credential rotation and releases its lease',async t=>{
 const store=await fixture(t);await store.save(row(ids[0],{watch_enabled:true,rotation_pending:true}));
 const client=new CentralClient({store,fetchFn:async()=>assert.fail('uncertain credentials must not be used')});
 await assert.rejects(()=>client.restore(),{code:'credential_rotation_uncertain'});
 assert.equal(client.row,null);assert.equal(store.leases.size,0);
 assert.equal((await store.load(ids[0])).rotation_pending,true);
});

test('throwing wake callback does not kill monitoring after a durable event',async t=>{
 const store=await fixture(t);await store.save(row());let polls=0;
 const client=new CentralClient({store,onEvent:()=>{throw Error('host callback failed');},fetchFn:async(url,options)=>{
  if(url.endsWith('/session'))return json({});
  polls++;if(polls===1)return json({events:[event],cursor:1});return hold(options);
 }});
 store.testCleanups.push(()=>client.disconnect());await client.connect({connection_id:ids[0]});
 await until(()=>polls===2);assert.equal(client.monitorState,'running');
 assert.deepEqual((await store.load(ids[0])).staged,[event]);
});
