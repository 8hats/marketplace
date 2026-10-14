import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {CentralClient} from '../src/central-client.mjs';

test('Moderator heartbeat tool is Moderator-only and sends only the strict policy through the bound client',async()=>{
 const calls=[],client={mutation:async(...args)=>{calls.push(args);return {result:{status:'committed',data:{heartbeat:{enabled:true,interval_minutes:30,current_id:null}}}};}};
 const tool=centralTools(client,'moderator').find(t=>t.name==='ac_room_heartbeat_set');assert.ok(tool);
 assert.match(tool.description,/never changes the room status/);assert.match(tool.description,/human room owner/);
 assert.ok(!centralTools(client,'personal').some(t=>t.name===tool.name));
 for(const input of [{},{interval_minutes:20},{enabled:true,interval_minutes:0},{enabled:true,interval_minutes:1441},{enabled:true,interval_minutes:1.5},{enabled:true,room_id:'other'}])assert.equal(tool.inputSchema.safeParse(input).success,false,JSON.stringify(input));
 await tool.execute(tool.inputSchema.parse({enabled:true,interval_minutes:30}));await tool.execute(tool.inputSchema.parse({enabled:false}));
 assert.deepEqual(calls,[['/commands',{body:{command:'consumer.ac.room.heartbeat.set',arguments:{enabled:true,interval_minutes:30}}}],['/commands',{body:{command:'consumer.ac.room.heartbeat.set',arguments:{enabled:false}}}]]);
});

// Exercises the real pruning method on a minimal client state.
const event=(id,kind,resource)=>({event_id:'event-'+id,seq:id,kind,resource});
function fake(staged,session){
 const acknowledged=[],state={row:{staged},acknowledged,sessions:0,
  async request(route){assert.equal(route,'/session');state.sessions++;if(session instanceof Error)throw session;return session;},
  async acknowledge(events){acknowledged.push(...events.map(e=>e.event_id));this.row.staged=this.row.staged.filter(e=>!events.includes(e));},
 };
 return state;
}
const prune=(state,session)=>CentralClient.prototype.pruneHeartbeats.call(state,session);
test('only the current heartbeat (by message ID) stays staged; other mail is untouched',async()=>{
 const message=event(1,'postMessage',{kind:'message',id:'m1'}),old=event(2,'roomHeartbeatNotice',{kind:'message',id:'h1'}),current=event(3,'roomHeartbeatNotice',{kind:'message',id:'h2'});
 const state=fake([message,old,current],{room:{heartbeat:{enabled:true,interval_minutes:20,current_id:'h2'}}});
 assert.equal(await prune(state),true);
 assert.deepEqual(state.acknowledged,['event-2']);assert.deepEqual(state.row.staged,[message,current]);
 // The history event ID never matches the message ID used for currency.
 const confusing=event(4,'roomHeartbeatNotice',{kind:'message',id:'h3'});confusing.event_id='h2';
 const second=fake([confusing],{room:{heartbeat:{current_id:'h2'}}});assert.equal(await prune(second),true);assert.deepEqual(second.row.staged,[]);
});
test('disabled, Done or superseded rooms leave no heartbeat staged; no heartbeat means no session read',async()=>{
 for(const heartbeat of [{enabled:false,interval_minutes:20,current_id:null},undefined]){
  const state=fake([event(1,'roomHeartbeatNotice',{kind:'message',id:'h1'})],{room:{status:'done',heartbeat}});
  assert.equal(await prune(state),true);assert.deepEqual(state.row.staged,[]);
 }
 const quiet=fake([event(1,'postMessage',{kind:'message',id:'m1'})],new Error('must not be called'));
 assert.equal(await prune(quiet),true);assert.equal(quiet.sessions,0);
});
test('a failed currency check keeps heartbeat mail staged but reports it as not validated',async()=>{
 const state=fake([event(1,'roomHeartbeatNotice',{kind:'message',id:'h1'})],Object.assign(new Error('offline'),{code:'central_unavailable'}));
 assert.equal(await prune(state),false);assert.equal(state.row.staged.length,1);assert.deepEqual(state.acknowledged,[]);
});
