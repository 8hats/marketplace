import test from 'node:test';import assert from 'node:assert/strict';
import {createRuntime} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
test('Moderator provides 22 product tools and foreground wait without identity lifecycle and validates the assigned identity',async()=>{
 const identityCid='B'.repeat(64),roomCid='A'.repeat(64);let current=identityCid,sends=0;
 const client={currentIdentity:async()=>({name:'Assigned',cid:current}),sendCommand:async args=>{sends++;assert.equal(args.command,'consumer.ac.review.publish');return {sent:true,wire_id:'request'};},getMessages:async()=>({messages:[],command_results:[{direction:'in',message_kind:'command_result',wire_id:'reply',from:{id:roomCid},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'committed',data:{published:true}}}})}],remaining:0})};
 const runtime=await createRuntime({inputs:{client,identityName:'Assigned',identityCid,roomCid,roomName:'Room',monitor:false}}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await runtime.server.connect(a);await host.connect(b);const names=(await host.listTools()).tools.map(t=>t.name);assert.equal(names.length,23);assert.ok(names.includes('ac_review_publish'));for(const name of ['ac_join','enter_room','connect_to_room','disconnect_from_room'])assert.equal(names.includes(name),false);
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

test('Moderator command polling wakes for retained chat over MCP without consuming it',async()=>{
 const {LoggingMessageNotificationSchema}=await import('@modelcontextprotocol/sdk/types.js');
 const identityCid='B'.repeat(64),roomCid='A'.repeat(64),wakes=[];let reads=0;
 const chat={wire_id:'chat',direction:'in',from:{id:roomCid},body:JSON.stringify({version:1,kind:'room_msg',room_id:'r',room_name:'Canonical Room',at:'2026-09-16T07:08:57.380Z',author:{display_name:'Peer',identity:'C'.repeat(64),role:'Personal Agent'},message_id:'chat',text:'Private chat'})};
 const sdk={currentIdentity:async()=>({name:'Assigned',cid:identityCid}),listIncomingMessages:async()=>[],listIncomingFiles:async()=>[],watchNotifications:async function*(_name,{signal}){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},sendCommand:async()=>({sent:true,wire_id:'request'}),getMessages:async()=>{reads++;return {messages:[chat],command_results:[{wire_id:'reply',direction:'in',message_kind:'command_result',from:{id:roomCid},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'ok',data:{id:'room'}}}})}],remaining:0};}};
 const runtime=await createRuntime({inputs:{client:sdk,identityName:'Assigned',identityCid,roomCid,roomName:'ours-cowork:Room'}}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 host.setNotificationHandler(LoggingMessageNotificationSchema,n=>wakes.push(n.params));
 try{await runtime.server.connect(a);await host.connect(b);await host.callTool({name:'ac_read',arguments:{kind:'room'}});assert.equal(wakes.length,1);assert.equal(JSON.parse(wakes[0].data).event,'room_message_available');assert.doesNotMatch(JSON.stringify(wakes),/Private chat/);const mail=JSON.parse((await host.callTool({name:'ac_messages',arguments:{}})).content[0].text);assert.equal(mail.messages[0].body,chat.body);assert.equal(reads,1);}finally{await host.close();await runtime.shutdown();}
});
test('Moderator ac_messages exposes app-session human attribution over MCP without replacing native signer',async()=>{
 const identityCid='B'.repeat(64),roomCid='A'.repeat(64);
 const app={version:1,kind:'au_cowork_human_message',transport_role:'Web',author:{id:'human',kind:'human',display_name:'Alice',role_labels:['Reviewer'],attribution:'application_session'},text:'Hello'};
 const body=JSON.stringify({version:1,kind:'room_msg',room_id:'r',room_name:'Room',message_id:'message',at:'2026-09-16T00:00:00Z',author:{identity:roomCid,display_name:'Web',role:'Web'},text:JSON.stringify(app)});
 const sdk={currentIdentity:async()=>({name:'Assigned',cid:identityCid}),getMessages:async()=>({messages:[{direction:'in',wire_id:'wire',from:{id:roomCid},body}],command_results:[],remaining:0})};
 const runtime=await createRuntime({inputs:{client:sdk,identityName:'Assigned',identityCid,roomCid,roomName:'Room',monitor:false}}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await runtime.server.connect(a);await host.connect(b);const mail=JSON.parse((await host.callTool({name:'ac_messages',arguments:{}})).content[0].text);assert.equal(mail.messages[0].application_message.author.id,'human');assert.equal(mail.messages[0].body,body);assert.equal(mail.messages[0].from.id,roomCid);}finally{await host.close();await runtime.shutdown();}
});
