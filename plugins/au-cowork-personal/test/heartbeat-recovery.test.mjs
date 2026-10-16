import test from 'node:test';
import assert from 'node:assert/strict';
import {CentralClient as Personal} from '../src/central-client.mjs';
import {CentralClient as Moderator} from '../../au-cowork-moderator/src/central-client.mjs';

const heartbeat={event_id:'heartbeat-event',seq:1,kind:'roomHeartbeatNotice',resource:{kind:'message',id:'heartbeat-message'}};
const mail={event_id:'mail-event',seq:2,kind:'postMessage',resource:{kind:'message',id:'mail-message'}};
const current={room:{heartbeat:{current_id:heartbeat.resource.id}}};
const offline=()=>Object.assign(new Error('offline'),{code:'central_unavailable'});
function monitor(Client,{staged=[],pages,session}){
 const hints=[],acks=[];let polls=0,sessions=0;
 const client=new Client({store:{async save(){},async release(){}},onEvent:value=>hints.push(value.event.event_id)});
 client.row={connection_id:'original',cursor:0,staged:structuredClone(staged),consumed_files:[],expires_at:'2099-01-01T00:00:00Z'};
 client.request=async(route,options)=>{
  if(route.startsWith('/events?')){
   const index=polls++;
   if(index===pages.length){client.monitor.abort();throw offline();}
   const events=await pages[index]({client,hints,sessions,acks});
   return {events,cursor:Math.max(client.row.cursor,...events.map(event=>event.seq))};
  }
  if(route==='/session')return session(++sessions,client);
  assert.equal(route,'/ack');assert.ok(options.body.event_ids.length<=100);acks.push(...options.body.event_ids);return {};
 };
 client.startMonitor();
 return {client,hints,acks,done:()=>client.work,sessionCount:()=>sessions};
}
for(const [profile,Client] of [['Personal',Personal],['Moderator',Moderator]]){
 for(const failCatchup of [false,true]){
  test(`${profile}: restored catch-up ${failCatchup?'retries failure':'deduplicates success'} with the monitor`,async()=>{
   let releasePoll;const gate=new Promise(resolve=>{releasePoll=resolve;});
   const hints=[];let polls=0,sessions=0;
   const row={connection_id:'original',cursor:1,staged:[heartbeat],consumed_files:[],watch_enabled:true,expires_at:'2099-01-01T00:00:00Z'};
   const client=new Client({store:{async init(){},async acquire(){},async load(){return structuredClone(row);},async save(){}},onEvent:value=>hints.push(value.event.event_id)});
   client.request=async route=>{
    if(route==='/session'){sessions++;if(failCatchup&&sessions===1)throw offline();return current;}
    assert.ok(route.startsWith('/events?'));
    if(polls++===0){await gate;return {events:[],cursor:1};}
    client.monitor.abort();throw offline();
   };
   await client.connect({connection_id:'original',restoring:true});
   assert.deepEqual(hints,failCatchup?[]:[heartbeat.event_id]);
   releasePoll();await client.work;
   assert.deepEqual(hints,[heartbeat.event_id]);assert.equal(sessions,failCatchup?2:1);
  });
 }
 test(`${profile}: empty polls retry a failed staged heartbeat once without starving ordinary mail`,async()=>{
  const run=monitor(Client,{pages:[()=>[heartbeat,mail],({hints,sessions})=>{assert.deepEqual(hints,[mail.event_id]);assert.equal(sessions,1);return [];},({hints,sessions})=>{assert.deepEqual(hints,[mail.event_id,heartbeat.event_id]);assert.equal(sessions,2);return [];},({hints,sessions})=>{assert.equal(hints.length,2);assert.equal(sessions,2);return [];}],session:n=>{if(n===1)throw offline();return current;}});
  await run.done();assert.deepEqual(run.hints,[mail.event_id,heartbeat.event_id]);assert.equal(run.sessionCount(),2);assert.equal(run.client.row.cursor,2);
 });
 for(const [reason,room] of [['disabled',{heartbeat:{enabled:false,current_id:null}}],['Done',{status:'done'}],['currency changed',{heartbeat:{current_id:'replacement'}}]]){
  test(`${profile}: ${reason} after currency outage prunes silently on an empty poll`,async()=>{
   const run=monitor(Client,{pages:[()=>[heartbeat],()=>[],()=>[]],session:n=>{if(n===1)throw offline();return {room};}});
   await run.done();assert.deepEqual(run.hints,[]);assert.deepEqual(run.acks,[heartbeat.event_id]);assert.deepEqual(run.client.row.staged,[]);assert.equal(run.sessionCount(),2);
  });
 }
 test(`${profile}: no heartbeat means no added session reads`,async()=>{
  const run=monitor(Client,{pages:[()=>[mail],()=>[],()=>[]],session:()=>{throw new Error('unexpected session');}});
  await run.done();assert.deepEqual(run.hints,[mail.event_id]);assert.equal(run.sessionCount(),0);
 });
 test(`${profile}: an already staged heartbeat retries after failure and a new monitor can hint again`,async()=>{
  for(let attempt=0;attempt<2;attempt++){
   const run=monitor(Client,{staged:[heartbeat],pages:[()=>[],()=>[],()=>[]],session:n=>{if(n===1)throw offline();return current;}});
   await run.done();assert.deepEqual(run.hints,[heartbeat.event_id]);assert.equal(run.sessionCount(),2);
  }
 });
 test(`${profile}: ordinary-mail callback abort prevents a later same-page heartbeat hint`,async()=>{
  const run=monitor(Client,{pages:[({client})=>{client.onEvent=value=>{run.hints.push(value.event.event_id);client.monitor.abort();};return [heartbeat,mail];}],session:()=>current});
  await run.done();assert.deepEqual(run.hints,[mail.event_id]);
 });
 for(const stop of ['abort','detach','replace monitor']){
  test(`${profile}: ${stop} during currency read cannot emit an old-row hint`,async()=>{
   const run=monitor(Client,{pages:[()=>[heartbeat]],session:async(n,client)=>{
    await Promise.resolve();
    if(stop==='abort')client.monitor.abort();
    else if(stop==='detach')client.row={...client.row,connection_id:'replacement'};
    else client.monitor=new AbortController();
    return current;
   }});
   await run.done();assert.deepEqual(run.hints,[]);
  });
 }
}
