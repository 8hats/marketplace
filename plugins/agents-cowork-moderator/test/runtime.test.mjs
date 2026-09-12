import test from 'node:test';import assert from 'node:assert/strict';
import {createRuntime} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
test('Moderator provides20 product tools without identity lifecycle and validates the assigned identity',async()=>{
 const identityCid='B'.repeat(64),roomCid='A'.repeat(64);let current=identityCid,sends=0;
 const client={currentIdentity:async()=>({name:'Assigned',cid:current}),sendCommand:async args=>{sends++;assert.equal(args.command,'consumer.ac.review.publish');return {sent:true,wire_id:'request'};},getMessages:async()=>({messages:[],command_results:[{direction:'in',message_kind:'command_result',wire_id:'reply',from:{id:roomCid},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'committed',data:{published:true}}}})}],remaining:0})};
 const runtime=await createRuntime({inputs:{client,identityName:'Assigned',identityCid,roomCid,roomName:'Room',monitor:false}}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await runtime.server.connect(a);await host.connect(b);const names=(await host.listTools()).tools.map(t=>t.name);assert.equal(names.length,20);assert.ok(names.includes('ac_review_publish'));for(const name of ['ac_join','enter_room','connect_to_room','disconnect_from_room'])assert.equal(names.includes(name),false);
 const result=await host.callTool({name:'ac_review_publish',arguments:{round_id:'round'}});assert.equal(JSON.parse(result.content[0].text).status,'committed');
 current='C'.repeat(64);const denied=await host.callTool({name:'ac_review_publish',arguments:{round_id:'round'}});assert.equal(denied.isError,true);assert.equal(sends,1);
 }finally{await host.close();await runtime.shutdown();}
});
test('wrong startup identity is rejected without attempting identity lifecycle',async()=>{
 await assert.rejects(createRuntime({inputs:{identityName:'Assigned',identityCid:'B'.repeat(64),roomCid:'A'.repeat(64),roomName:'Room',client:{currentIdentity:async()=>({name:'Other',cid:'B'.repeat(64)})}}}),/Assigned Moderator/);
});
test('post-call identity failure retains committed result for explicit inspection, with no resend',async()=>{
 const identityCid='B'.repeat(64),roomCid='A'.repeat(64);let current=identityCid,sends=0;
 const client={currentIdentity:async()=>({name:'Assigned',cid:current}),sendCommand:async()=>{sends++;return {sent:true,wire_id:'request'};},getMessages:async()=>{current='C'.repeat(64);return {messages:[],command_results:[{direction:'in',message_kind:'command_result',wire_id:'reply',from:{id:roomCid},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'committed',data:{id:'saved'}}}})}],remaining:0};}};
 const runtime=await createRuntime({inputs:{client,identityName:'Assigned',identityCid,roomCid,roomName:'Room',monitor:false}}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await runtime.server.connect(a);await host.connect(b);assert.equal((await host.callTool({name:'ac_review_publish',arguments:{round_id:'r'}})).isError,true);current=identityCid;
 const mail=JSON.parse((await host.callTool({name:'ac_messages',arguments:{}})).content[0].text);assert.equal(mail.command_results[0].result.status,'committed');assert.equal(sends,1);
 }finally{await host.close();await runtime.shutdown();}
});
test('Moderator notifications use the supplied identity and stop without releasing its lease',async()=>{
 let watched=false,stopped=false;const identityCid='B'.repeat(64),roomCid='A'.repeat(64);
 const client={currentIdentity:async()=>({name:'Assigned',cid:identityCid}),listIncomingMessages:async()=>[],listIncomingFiles:async()=>[],watchNotifications:async function*(name,{signal}){assert.equal(name,'Assigned');watched=true;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped=true;}};
 const runtime=await createRuntime({inputs:{client,identityName:'Assigned',identityCid,roomCid,roomName:'Room'}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(watched,true);await runtime.shutdown();await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,true);
});
