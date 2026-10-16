import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {CentralClient} from '../src/central-client.mjs';

// Personal agents receive heartbeats too: the same pruning keeps superseded heartbeat mail from waking them.
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
test('more than 100 superseded heartbeats are acknowledged in batches the central route accepts',async()=>{
 const stale=Array.from({length:205},(_,i)=>event(i+1,'roomHeartbeatNotice',{kind:'message',id:'h'+i})),other=event(999,'postMessage',{kind:'message',id:'m'});
 const state=fake([...stale,other],{room:{heartbeat:{enabled:true,interval_minutes:20,current_id:null}}}),sizes=[];
 const acknowledge=state.acknowledge;state.acknowledge=async function(events){if(events.length>100)throw Object.assign(new Error('invalid'),{code:'invalid_request'});sizes.push(events.length);return acknowledge.call(this,events);};
 assert.equal(await prune(state),true);
 assert.deepEqual(sizes,[100,100,5]);assert.deepEqual(state.row.staged,[other]);
});
test('the Personal profile does not expose heartbeat configuration',()=>{
 assert.ok(!centralTools({}).some(tool=>tool.name==='ac_room_heartbeat_set'));
});
