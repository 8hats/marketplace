import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {CentralClient} from '../src/central-client.mjs';
import {createRuntime} from '../src/server.mjs';
import {conversationErrorDetails} from '../src/conversation-errors.mjs';

const expected_structure={revision:1,digest:'sha256:'+'a'.repeat(64)};
const node={expected_structure,kind:'node',node_type:'question',title:'Question',text:'Free prose',relations:[{relation:'related_to',node_id:'existing'}]};
function clientFor(fetchFn){
 const client=new CentralClient({fetchFn,store:{async save(){},async release(){}}});
 client.row={origin:'https://cowork.example',credential:'private-test-credential',connection_id:'11111111-1111-1111-1111-111111111111',room_id:'room',staged:[],consumed_files:[]};
 return client;
}
test('both agent profiles require explicit node/reply variants and current configuration',async()=>{
 for(const profile of ['personal','moderator']){
  const tools=centralTools({},profile),submit=tools.find(t=>t.name==='ac_conversation_submit');
  assert.ok(submit);assert.ok(tools.some(t=>t.name==='ac_conversation_structure'));
  assert.equal(tools.some(t=>/setConversationStructure|structure_set/.test(t.name)),false);
  assert.deepEqual(submit.inputSchema.parse(node),node);
  const reply={expected_structure,kind:'reply',reply_type:'comment',reply_to_message_id:'message',text:'Reply'};
  assert.deepEqual(submit.inputSchema.parse(reply),reply);
  for(const bad of [{text:'ordinary'}, {...node,kind:undefined},{...node,node_type:undefined},{...node,expected_structure:undefined},{...reply,reply_type:undefined},{...reply,reply_to_message_id:undefined},{...node,relations:[{relation:'addressed_by',target_node_id:'old-field'}]}])assert.equal(submit.inputSchema.safeParse(bad).success,false);
  assert.equal(submit.inputSchema.safeParse({...node,text:'   '}).success,false);
  assert.equal(submit.inputSchema.safeParse({...node,relations:Array.from({length:65},()=>({relation:'related_to',node_id:'existing'}))}).success,false);
  const defaulted=submit.inputSchema.parse({...node,relations:undefined,title:'  trimmed title  '});assert.deepEqual(defaulted.relations,[]);assert.equal(defaulted.title,'trimmed title');
 }
});
test('typed tool sends canonical consumer command without reinterpreting relation direction',async()=>{
 const calls=[],tools=centralTools({async mutation(route,{body}){calls.push({route,body});return {result:{status:'committed',data:{id:'message',structure:{kind:'node',type:'answer'}}}};}});
 const input={...node,node_type:'answer',relations:[{relation:'addressed_by',node_id:'question-node'}]};
 const result=await tools.find(t=>t.name==='ac_conversation_submit').execute(input);
 assert.equal(result.status,'committed');assert.deepEqual(calls,[{route:'/commands',body:{command:'consumer.ac.conversation.submit',arguments:input}}]);
});
test('actionable structural rejection survives HTTP and MCP and clears only definitive no-effect key',async()=>{
 for(const effect of ['none',undefined]){
  const client=clientFor(async()=>new Response(JSON.stringify({error:{code:'conversation_structure_rejected',message:'Reply to the opening message of this node.',fields:[{path:'reply_to_message_id',code:'reply_opening_only',message:'Choose the node opening message.'}],...(effect?{effect}:{}),private_extra:'must not be forwarded'}}),{status:422,headers:{'content-type':'application/json'}}));
  const handlers=new Map(),runtime=await createRuntime({client,injectedServer:{registerTool:(name,_descriptor,handler)=>handlers.set(name,handler)}});
  try{
   const result=await handlers.get('ac_conversation_submit')(node),body=result.structuredContent;
   assert.equal(result.isError,true);assert.equal(body.error.code,'conversation_structure_rejected');assert.match(body.error.message,/opening message/);
   assert.deepEqual(body.error.fields,[{path:'reply_to_message_id',code:'reply_opening_only',message:'Choose the node opening message.'}]);
   assert.equal(body.error.effect,effect);assert.equal(body.error.retryable,false);
   assert.equal(JSON.stringify(body).includes('private_extra'),false);
   assert.equal(Object.keys(client.row.pending_operations).length,effect==='none'?0:1);
  }finally{await runtime.shutdown();}
 }
});
test('local malformed submissions explain required fields without any network call',async()=>{
 let calls=0;const client=clientFor(async()=>{calls++;throw Error('unexpected')});
 const handlers=new Map(),runtime=await createRuntime({client,injectedServer:{registerTool:(name,_descriptor,handler)=>handlers.set(name,handler)}});
 try{
  const result=await handlers.get('ac_conversation_submit')({text:'missing type'});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.error.effect,'none');assert.match(result.structuredContent.error.message,/node_type.*reply_type/);assert.ok(result.structuredContent.error.fields.length);assert.equal(calls,0);
 }finally{await runtime.shutdown();}
});
test('structural error details are bounded and do not relabel unrelated or transient failures',()=>{
 assert.deepEqual(conversationErrorDetails({code:'forbidden',message:'server detail',effect:'none'},403),{});
 assert.deepEqual(conversationErrorDetails({code:'conversation_structure_rejected',message:'server detail',effect:'none'},503),{});
 const result=conversationErrorDetails({code:'conversation_structure_invalid',message:'x'.repeat(2001),fields:[{path:'yaml',message:'x'.repeat(513)}]},422);
 assert.deepEqual(result,{});
});
test('lost typed submission preserves its durable idempotency key',async()=>{
 const keys=[];let attempts=0;
 const client=clientFor(async(_url,options)=>{keys.push(JSON.parse(options.body).idempotency_key);if(!attempts++)throw Error('response lost');return new Response(JSON.stringify({data:{command_id:'command',result:{status:'committed',data:{id:'message'}}}}),{headers:{'content-type':'application/json'}});});
 const tool=centralTools(client).find(t=>t.name==='ac_conversation_submit');
 await assert.rejects(()=>tool.execute(node),{code:'central_unavailable'});assert.equal(Object.keys(client.row.pending_operations).length,1);
 await tool.execute(node);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(Object.keys(client.row.pending_operations).length,0);
});
test('received messages preserve the server structure and canonical relation endpoints',async()=>{
 const structure={revision:1,kind:'node',type:'answer',node:{id:'answer',type:'answer',title:'Answer',parent_node_id:'question',depth:1},relations:[{relation:'addressed_by',source_node_id:'question',target_node_id:'answer'}]};
 const client=clientFor(async url=>new Response(JSON.stringify({data:url.endsWith('/ack')?{}:{id:'message',author:{id:'other'},text:'body',at:'2026-10-25T00:00:00Z',structure}}),{headers:{'content-type':'application/json'}}));
 client.row.staged=[{seq:1,event_id:'event',resource:{kind:'message',id:'message'}}];
 const result=await client.messages();assert.deepEqual(result.messages[0].structure,structure);assert.equal(client.row.staged.length,0);
});

test('backend-shaped top-level session policy reaches connect and room status without drift',async()=>{
 const policy={active:true,language:'cowork-structure/1',revision:3,digest:'sha256:'+'b'.repeat(64),yaml:'language: cowork-structure/1\n',rules_text:'Choose a configured type.',submit_example:{kind:'node'}};
 const session={room:{id:'room',status:'active',discussion:'open'},conversation_structure:policy,capabilities:{commands:[]}};
 const client=clientFor(async()=>new Response(JSON.stringify({data:session}),{headers:{'content-type':'application/json'}}));
 const saved=client.row;client.row=null;
 client.store={async init(){},async acquire(){},async load(){return {...saved,watch_enabled:true}},async save(){},async release(){}};
 client.startMonitor=()=>{client.monitorState='running'};client.pruneHeartbeats=async()=>false;
 const connected=await client.connect({connection_id:saved.connection_id});assert.deepEqual(connected.conversation_structure,policy);
 const handlers=new Map(),runtime=await createRuntime({client,injectedServer:{registerTool:(name,_descriptor,handler)=>handlers.set(name,handler)}});
 try{const status=await handlers.get('get_room_status')({});assert.deepEqual(status.structuredContent.data.conversation_structure,policy);}finally{await runtime.shutdown();}
});
