import test from 'node:test';import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createRuntime as personal} from '../src/server.mjs';import {createRuntime as moderator} from '../../au-cowork-moderator/src/server.mjs';
import {createProductTools} from '../src/product-tools.mjs';
const room='A'.repeat(64),agent='B'.repeat(64),hash='a'.repeat(64);
const input={attachment_id:'product-attachment',displayed_hash:hash,reviewer_actor_id:'human-reviewer',question:'Please check the evidence and conclusions.',idempotency_key:'caller-persisted-unique-key'};
function fixture(){let pending,count=0;const sent=[];const sdk={currentIdentity:async()=>({name:'Agent',cid:agent}),sendCommand:async value=>{sent.push(value);pending={value,wire:'request-'+(++count)};return {sent:true,wire_id:pending.wire};},getMessages:async()=>{if(!pending)return {messages:[],command_results:[],remaining:0};const {value,wire}=pending;pending=null;const kind=value.arguments.kind;const data=value.command==='consumer.ac.file.review.request'?{id:'review',state:'pending'}:kind==='attachment'?{id:'product-attachment',attachment:{id:'product-attachment',hash,filename:'evidence.pdf'}}:kind==='members'?{items:[{id:'reviewer-membership',actor_id:'human-reviewer',human_id:'human-reviewer',kind:'human',display_name:'Reviewer'}]}:{id:'review',state:'responded',response:{outcome:'reviewed',text:'Checked evidence'}};return {messages:[],command_results:[{direction:'in',message_kind:'command_result',wire_id:'result-'+wire,from:{id:room},reply_to:{wire_id:wire},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'ok',data}}})}],remaining:0};}};
const session={selection:{},bound:{identity_name:'Agent',identity_cid:agent,contact_cid:room,room_name:'Room',membership_state:'ready'},ensureAttached:async()=>sdk,release:async()=>{session.bound=null;}};return {sdk,session,sent};}
for(const profile of ['personal','moderator'])test(`${profile} MCP requests a human review using verified attachment metadata and reads its result`,async()=>{
 const f=fixture();const runtime=profile==='personal'?await personal({session:f.session,registry:{init:async()=>{},list:async()=>[]}}):await moderator({inputs:{identityName:'Agent',identityCid:agent,roomCid:room,roomName:'Room',monitor:false,client:f.sdk}});
 const host=new Client({name:'review-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await(runtime.server.server??runtime.server).connect(a);await host.connect(b);const tools=(await host.listTools()).tools;assert.ok(tools.some(t=>t.name==='ac_request_review'));assert.equal(tools.some(t=>t.name==='ac_file_review_request'),false);assert.equal(tools.some(t=>t.name==='ac_respond_review'),false);
  const call=async(name,args)=>JSON.parse((await host.callTool({name,arguments:args})).content[0].text);
  const attachment=(await call('ac_read',{kind:'attachment',id:'original-native-file-id'})).data;assert.equal(attachment.attachment.hash,hash);
  const members=(await call('ac_read',{kind:'members'})).data;assert.equal(members.items[0].actor_id,input.reviewer_actor_id);
  const review=(await call('ac_request_review',input)).data;assert.equal(review.id,'review');assert.deepEqual(f.sent[2],{contact:room,command:'consumer.ac.file.review.request',arguments:input});
  assert.equal((await call('ac_read',{kind:'file_review',id:review.id})).data.response.outcome,'reviewed');
  for(const invalid of [{...input,idempotency_key:''},{...input,idempotency_key:undefined},{...input,displayed_hash:'bad'},{...input,author_id:'owner'}])assert.equal((await host.callTool({name:'ac_request_review',arguments:invalid})).isError,true);assert.equal(f.sent.length,4);
 }finally{await host.close();await runtime.shutdown();}
});
test('unknown review request is sent once with caller key; later result remains inspectable without automatic replay',async()=>{
 const f=fixture();let ready=false;f.sdk.getMessages=async()=>({messages:[],command_results:ready?[{direction:'in',message_kind:'command_result',wire_id:'late',from:{id:room},reply_to:{wire_id:'request-1'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'ok',data:{id:'review',state:'pending'}}}})}]:[],remaining:0});
 const tools=createProductTools(f.session,{timeoutMs:10,pollMs:1});const unknown=JSON.parse((await tools.execute('ac_request_review',input)).content[0].text);assert.equal(unknown.status,'unknown');assert.equal(f.sent.length,1);assert.equal(f.sent[0].arguments.idempotency_key,input.idempotency_key);
 ready=true;const mail=JSON.parse((await tools.execute('ac_messages',{})).content[0].text);assert.equal(mail.command_results[0].result.data.id,'review');assert.equal(f.sent.length,1);
});

test('all advertised native consumer commands satisfy the supported Cowork naming grammar',async()=>{const {consumerCommands}=await import('../src/product/contracts.mjs');for(const name of Object.keys(consumerCommands))assert.match(name,/^consumer\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/);assert.equal(consumerCommands['consumer.ac.file.review.request'],'requestFileReview');});
