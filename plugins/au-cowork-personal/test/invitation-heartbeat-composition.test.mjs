import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CentralClient as PersonalClient,ConnectionStore} from '../src/central-client.mjs';
import {CentralClient as ModeratorClient} from '../../au-cowork-moderator/src/central-client.mjs';
import {createRuntime as personalRuntime} from '../src/server.mjs';
import {createRuntime as moderatorRuntime} from '../../au-cowork-moderator/src/server.mjs';

const origin='https://cowork.example';
const json=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
const event=(seq,kind,id)=>({event_id:'event-'+seq,seq,kind,resource:{kind:'message',id}});
for(const [profile,Client,createRuntime] of [['personal',PersonalClient,personalRuntime],['moderator',ModeratorClient,moderatorRuntime]]){
 // Keep the actual bind/save/read/ack path, without an unrelated concurrent poll loop.
 class QuietClient extends Client {startMonitor(){this.monitorState='running';}}
 for(const tool of ['enter_room','connect_to_room'])test(`${profile}/${tool}: saved instruction admission survives optional session failure and reconnects with one exchange`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'cowork-compose-'));let runtime,exchange=0,sessions=0,id;
  const store=new ConnectionStore(root);
  const client=new QuietClient({origin,store,fetchFn:async(url,options)=>{
   const route=new URL(url).pathname;
   if(route.endsWith('/exchange')){exchange++;assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),['display_name','token']);return json({credential:'b'.repeat(43),room_id:'room',agent_id:'agent',display_name:'Accepted'});}
   assert.ok(route.endsWith('/session'));sessions++;
   // Informational session must run only after binding AND durable credential storage.
   assert.ok(client.row);assert.equal((await store.load(client.row.connection_id)).credential,client.row.credential);
   return new Response('<html>Unavailable</html>',{status:503});
  }});
  const handlers=new Map();
  try{
   runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
   const result=await handlers.get(tool)({invite:origin+'/agent-instructions#token='+'a'.repeat(43),...(tool==='enter_room'?{as_agent:'Explicit'}:{})});
   assert.notEqual(result.isError,true);assert.equal(result.structuredContent.ok,true);id=result.structuredContent.data.connection_id;
   assert.equal(exchange,1);assert.equal(sessions,1);assert.equal((await store.load(id)).watch_enabled,true);
   await runtime.shutdown();runtime=null;
   const resumed=new QuietClient({origin,store,fetchFn:async url=>{assert.ok(new URL(url).pathname.endsWith('/session'));sessions++;return json({room:{status:'working',discussion:'open'}});}});
   try{assert.equal((await resumed.connect({connection_id:id})).connection_id,id);assert.equal(exchange,1);assert.equal(sessions,2);}finally{await resumed.disconnect();}
  }finally{await runtime?.shutdown();await rm(root,{recursive:true,force:true});}
 });
 for(const currencyFails of [false,true])test(`${profile}: saved restore ${currencyFails?'retains silent heartbeat and reads ordinary mail during currency outage':'prunes stale heartbeat before replay'} without exchange`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'cowork-compose-')),store=new ConnectionStore(root),wakes=[],acks=[];let sessions=0;
  const id='12345678-1234-1234-1234-123456789abc';
  const heartbeat=event(1,'roomHeartbeatNotice','old-heartbeat'),mail=event(2,'postMessage','ordinary');
  await store.save({version:1,connection_id:id,origin,credential:'b'.repeat(43),room_id:'room',agent_id:'agent',display_name:'Saved',cursor:2,staged:[heartbeat,mail],consumed_files:[],watch_enabled:true});
  const client=new QuietClient({origin,store,onEvent:value=>wakes.push(value.event.event_id),fetchFn:async(url,options)=>{
   const route=new URL(url).pathname;
   assert.ok(!route.endsWith('/exchange'));
   if(route.endsWith('/session')){sessions++;return currencyFails?new Response('<html>Unavailable</html>',{status:503}):json({room:{heartbeat:{current_id:'new-heartbeat'}}});}
   if(route.endsWith('/ack')){acks.push(...JSON.parse(options.body).event_ids);return json({});}
   assert.ok(route.endsWith('/messages/ordinary'));return json({id:'ordinary',author:{id:'other'},text:'ordinary mail'});
  }});
  try{
   assert.equal((await client.restore({connection_id:id})).connection_id,id);
   assert.equal(sessions,1);assert.deepEqual(wakes,['event-2']);
   assert.deepEqual(acks,currencyFails?[]:['event-1']);
   assert.deepEqual((await client.wait(1)).event.resource,mail.resource);
   const read=await client.messages();assert.equal(read.messages.length,1);assert.equal(read.messages[0].body,'ordinary mail');
   assert.deepEqual(client.row.staged,currencyFails?[heartbeat]:[]);
  }finally{await client.disconnect();await rm(root,{recursive:true,force:true});}
 });
 test(`${profile}: saved restore with no staged heartbeat does not read session or exchange`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'cowork-compose-')),store=new ConnectionStore(root),id='12345678-1234-1234-1234-123456789abc';
  const client=new QuietClient({origin,store,fetchFn:async()=>assert.fail('restore must not require transport')});
  try{await store.save({version:1,connection_id:id,origin,credential:'b'.repeat(43),cursor:0,staged:[],consumed_files:[],watch_enabled:true});assert.equal((await client.restore({connection_id:id})).connection_id,id);}finally{await client.disconnect();await rm(root,{recursive:true,force:true});}
 });
}
