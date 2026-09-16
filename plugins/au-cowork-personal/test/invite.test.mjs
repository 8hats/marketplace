import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionRegistry} from '../src/connections.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {LoggingMessageNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CoworkSession} from '../src/session.mjs';
import {createRuntime as personal} from '../src/server.mjs';
import {createRuntime as moderator} from '../../au-cowork-moderator/src/server.mjs';
const roomCid='A'.repeat(64);
const registry={init:async()=>{},list:async()=>[],create:async()=>{throw Error('Invite connections must not use the legacy room-name registry');}};
async function setup(factory,options={}){
 const stateDir=await mkdtemp(join(tmpdir(),'au-invite-'));const connections=new ConnectionRegistry(stateDir);
 let identity,redemptions=0,releases=0,closed=0,lease;
 const sdk={createIdentity:async({name})=>{identity={name,cid:'B'.repeat(64)};return {info:identity};},currentIdentity:async()=>identity,
 addContact:async()=>{redemptions++;if(options.reject)throw Error('redemption uncertain');return {cid:roomCid,display:'Room'};},listContacts:async()=>({contacts:options.briefing?[{container_id:roomCid}]:[]}),
 closeTemporaryIdentityOp:async()=>{closed++;},releaseLease:async()=>{releases++;},listIncomingMessages:async()=>options.briefing?[{wire_id:'briefing',from:{id:roomCid}}]:[],listIncomingFiles:async()=>[],
 getHistoryItem:async()=>({direction:'in',from:{id:roomCid},text:JSON.stringify({version:1,kind:'room_briefing',briefing_version:1,room_id:'room',room_name:'Canonical Room',at:'2026-09-16T07:08:57.380Z',author:{display_name:'Room',identity:roomCid,role:'room'},message_id:'briefing',text:'Private criteria'})}),
 watchNotifications:async function*(_name,{signal}){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},
 sendMessage:async args=>{assert.equal(args.contact,roomCid);return {sent:true,wire_id:'sent-wire'};},
 getMessages:async()=>({messages:[{wire_id:'briefing-wire',from:{id:roomCid},body:'Room briefing'}],command_results:[],remaining:0})};
 const session=new CoworkSession({resolve:()=>({expectStateDir:stateDir}),attach:async args=>{lease=args.leaseToken;return sdk;}});
 const runtime=await factory({session,registry,connections}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await (runtime.server.server??runtime.server).connect(a);await host.connect(b);
 return {host,session,get identity(){return identity;},get lease(){return lease;},counts:()=>({redemptions,releases,closed}),stop:async()=>{await host.close();await runtime.shutdown();await rm(stateDir,{recursive:true,force:true});}};
}
for(const [profile,factory] of [['personal',personal],['moderator',moderator]])test(`${profile} manually redeems once and retains its persistent identity`,async()=>{
 const x=await setup(factory);
 try{
 const names=(await x.host.listTools()).tools.map(t=>t.name);assert.ok(names.includes('connect_to_room'));assert.equal(names.includes('ac_review_publish'),profile==='moderator');
 const result=await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});const value=JSON.parse(result.content[0].text);assert.equal(value.data.agent_cid,'B'.repeat(64));assert.equal(value.data.status,'connecting');assert.equal(value.data.bootstrap.status,'unchecked');assert.deepEqual(value.data.bootstrap.required_reads.map(read=>read.arguments.kind),['context','capabilities']);assert.equal(value.data.bootstrap.assigned_roles_source,'context.assigned_roles');assert.match(value.data.bootstrap.instructions,/Immediately read/);
 await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});assert.equal(x.counts().redemptions,1);
 const mail=await x.host.callTool({name:'ac_messages',arguments:{}});assert.notEqual(mail.isError,true);assert.equal(JSON.parse(mail.content[0].text).messages[0].body,'Room briefing');
 const sent=await x.host.callTool({name:'ac_message',arguments:{text:'Ready'}});assert.equal(JSON.parse(sent.content[0].text).wire_id,'sent-wire');
 }finally{await x.stop();}assert.equal(x.counts().releases,1);assert.equal(x.counts().closed,0);
});
test('two personal sessions sharing a folder have independent identities and leases',async()=>{
 const a=await setup(personal),b=await setup(personal);
 try{for(const x of [a,b])await x.host.callTool({name:'connect_to_room',arguments:{invite:'own-invite'}});assert.notEqual(a.identity.name,b.identity.name);assert.notEqual(a.lease,b.lease);}finally{await a.stop();await b.stop();}
});
test('uncertain invite redemption is not repeated in the same MCP session',async()=>{
 const x=await setup(personal,{reject:true});try{for(let i=0;i<2;i++)await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});assert.equal(x.counts().redemptions,1);}finally{await x.stop();}
});

test('invalid connect arguments do not acquire a lease or redeem an invite',async()=>{
 const x=await setup(personal);try{
 const reply=await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use',room_name:'Room'}});
 assert.equal(JSON.parse(reply.content[0].text).error.code,'invalid_request');assert.equal(x.lease,undefined);assert.equal(x.counts().redemptions,0);
 }finally{await x.stop();}
});

for(const [profile,factory] of [['personal',personal],['moderator',moderator]])test(`${profile} delivers body-free briefing notifications over actual MCP transport`,async()=>{
 const x=await setup(factory,{briefing:true}),wakes=[];
 x.host.setNotificationHandler(LoggingMessageNotificationSchema,n=>wakes.push(n.params));
 try{await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(wakes.length,1);assert.equal(JSON.parse(wakes[0].data).event,'room_message_available');assert.doesNotMatch(JSON.stringify(wakes),/Private criteria/);}finally{await x.stop();}
});

for(const [profile,factory] of [['personal',personal],['moderator',moderator]]){
 test(`${profile} foreground wait sees earlier unread briefing through real MCP`,async()=>{
  const x=await setup(factory,{briefing:true});try{
   await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});
   const result=await x.host.callTool({name:'wait_for_room_event',arguments:{timeout_ms:1000}}),data=JSON.parse(result.content[0].text);
   assert.equal(data.status,'event');assert.equal(data.event.wire_id,'briefing');assert.doesNotMatch(JSON.stringify(data),/Private criteria/);
   const invalid=await x.host.callTool({name:'wait_for_room_event',arguments:{timeout_ms:1}});assert.equal(invalid.isError,true);
  }finally{await x.stop();}
 });
 test(`${profile} foreground wait permits disconnect and MCP cancellation`,async()=>{
  const x=await setup(factory);try{
   await x.host.callTool({name:'connect_to_room',arguments:{invite:'one-use'}});
   const abort=new AbortController();const cancelled=x.host.callTool({name:'wait_for_room_event',arguments:{timeout_ms:50000}},undefined,{signal:abort.signal});
   await new Promise(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(cancelled);await new Promise(resolve=>setImmediate(resolve));
   const pending=x.host.callTool({name:'wait_for_room_event',arguments:{timeout_ms:50000}});await new Promise(resolve=>setImmediate(resolve));
   const duplicate=await x.host.callTool({name:'wait_for_room_event',arguments:{timeout_ms:1000}});assert.equal(JSON.parse(duplicate.content[0].text).status,'already_waiting');
   await x.host.callTool({name:'disconnect_from_room',arguments:{}});assert.equal(JSON.parse((await pending).content[0].text).status,'disconnected');
  }finally{await x.stop();}
 });
}
