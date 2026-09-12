import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime} from '../src/server.mjs';
const room='A'.repeat(64),agent='B'.repeat(64);
function fixture(overrides={}) {
 const tools=new Map();const server={registerTool:(name,config,fn)=>tools.set(name,{config,fn}),sendLoggingMessage:()=>{}};
 const row={room_name:'Room',identity_name:'Agent',contact_cid:room,membership_state:'ready'};
 let sends=0,reads=0;const sdk={currentIdentity:async()=>({name:'Agent',cid:agent}),listContacts:async()=>({contacts:[{container_id:room}]}),sendCommand:async()=>{sends++;return {sent:true,wire_id:'request'};},getMessages:async()=>{reads++;return {messages:[],command_results:[{wire_id:'reply',direction:'in',message_kind:'command_result',from:{id:room},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'committed',data:{id:'saved'}}}})}],remaining:0};},...overrides};
 const session={bound:row,selection:{},ensureAttached:async()=>sdk,release:async()=>{session.bound=null;}};
 return {tools,server,row,sdk,session,registry:{init:async()=>{},list:async()=>[]},counts:()=>({sends,reads})};
}
test('plugin advertises 14 strict Personal Agent ac tools and correlates one actual room command',async()=>{
 const f=fixture();const runtime=await createRuntime(f);try{
 assert.equal(f.tools.size,19);assert.equal(f.tools.has('ac_request_decide'),true);
 const result=await f.tools.get('ac_read').fn({kind:'room'});assert.equal(JSON.parse(result.content[0].text).status,'committed');assert.deepEqual(f.counts(),{sends:1,reads:1});
 const invalid=await f.tools.get('ac_read').fn({kind:'room',actor_id:'forged'});assert.equal(invalid.isError,true);assert.deepEqual(f.counts(),{sends:1,reads:1});
 }finally{await runtime.shutdown();}
});
test('ac_messages retrieves late results and unrelated mail without resend',async()=>{
 let ready=false;const f=fixture({getMessages:async()=>({messages:ready?[{wire_id:'other',from:{id:'C'.repeat(64)},body:'private'}]:[],command_results:ready?[{wire_id:'late',direction:'in',message_kind:'command_result',from:{id:room},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:false,error:'local_effect_committed'}})}]:[],remaining:0})});
 const runtime=await createRuntime({...f,productOptions:{timeoutMs:10,pollMs:1}});try{
 assert.equal(JSON.parse((await f.tools.get('ac_read').fn({kind:'room'})).content[0].text).status,'unknown');ready=true;
 const mail=JSON.parse((await f.tools.get('ac_messages').fn({})).content[0].text);assert.equal(mail.command_results[0].result.status,'unknown');assert.equal(mail.messages[0].wire_id,'other');assert.equal(f.counts().sends,1);
 }finally{await runtime.shutdown();}
});
test('one active tool prevents disconnect; changed identity retains completed result for original identity',async()=>{
 let resolveRead,current=agent;const read=new Promise(resolve=>{resolveRead=resolve;});
 const f=fixture({currentIdentity:async()=>({name:'Agent',cid:current}),getMessages:async()=>{await read;current='C'.repeat(64);return {messages:[],command_results:[{wire_id:'reply',direction:'in',message_kind:'command_result',from:{id:room},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'committed',data:{id:'saved'}}}})}],remaining:0};}});
 const runtime=await createRuntime(f);try{
 const pending=f.tools.get('ac_read').fn({kind:'room'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await f.tools.get('disconnect_from_room').fn({})).isError,true);resolveRead();const denied=await pending;assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).effect,'unknown');
 current=agent;const received=JSON.parse((await f.tools.get('ac_messages').fn({})).content[0].text);assert.equal(received.command_results[0].result.status,'committed');assert.equal(f.counts().sends,1);
 }finally{await runtime.shutdown();}
});
test('actual MCP client sees strict union schemas and executes plugin tools',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const f=fixture(),runtime=await createRuntime({...f,server:undefined}),client=new Client({name:'host-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{await runtime.server.connect(a);await client.connect(b);const tools=(await client.listTools()).tools;assert.equal(tools.length,19);assert.ok(tools.every(tool=>tool.inputSchema.type==='object'));for(const name of ['ac_join','send_room_message','read_room_messages','reply_to_room_message','send_room_file','read_room_files','ac_request_route','ac_review_publish','ac_publication_propose','ac_intervention_record','ac_stage_explain','ac_result_create']){assert.equal(tools.some(tool=>tool.name===name),false);assert.equal((await client.callTool({name,arguments:{}})).isError,true);}assert.ok(tools.find(tool=>tool.name==='ac_request_decide').inputSchema.anyOf);
 const result=await client.callTool({name:'ac_read',arguments:{kind:'room'}});assert.equal(JSON.parse(result.content[0].text).status,'committed');
 assert.equal((await client.callTool({name:'ac_read',arguments:{kind:'room',unexpected:true}})).isError,true);
 }finally{await client.close();await runtime.shutdown();await runtime.server.close();}
});
test('byte-bounded mail pages retain every item across post-call identity denial',async()=>{
 let reads=0,identity=agent,deny=false;const f=fixture({currentIdentity:async()=>({name:'Agent',cid:identity}),getMessages:async()=>{reads++;if(deny)identity='C'.repeat(64);return {messages:Array.from({length:100},(_,i)=>({wire_id:`${reads}-${i}`,from:{id:room},body:'x'.repeat(5000)})),command_results:[],remaining:0};}});
 const runtime=await createRuntime({...f,productOptions:{timeoutMs:1000,pollMs:1}});try{
 await f.tools.get('ac_read').fn({kind:'room'});assert.equal(reads,10);
 // A post-call check must retain both results and ordinary inbox pages.
 let checks=0;f.sdk.currentIdentity=async()=>({name:'Agent',cid:++checks===2?'C'.repeat(64):agent});
 assert.equal((await f.tools.get('ac_messages').fn({})).isError,true);f.sdk.currentIdentity=async()=>({name:'Agent',cid:agent});
 const wires=[];while(wires.length<1000){const result=await f.tools.get('ac_messages').fn({});assert.ok(Buffer.byteLength(JSON.stringify(result))<=4*1024*1024);wires.push(...JSON.parse(result.content[0].text).messages.map(item=>item.wire_id));}
 assert.equal(new Set(wires).size,1000);assert.equal(reads,10);assert.equal(f.counts().sends,1);
 }finally{await runtime.shutdown();}
});
