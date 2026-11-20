import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {consumerCommands} from '../src/product/contracts.mjs';

const input={inquiry_id:'question',expected_revision:2,idempotency_key:'stable-action',action:'reply',text:'Follow-up'};
test('actual Moderator package exposes canonical lifecycle actions without losing moderator controls',async()=>{
 const calls=[],canonical={status:'committed',data:{effective_action:'follow_up',inquiry:{lifecycle:{turn:'recipient',revision:3}}}};
 const tools=centralTools({async mutation(route,{body}){calls.push({route,body});return {result:canonical}}},'moderator');
 const act=tools.find(t=>t.name==='ac_inquiry_act'),read=tools.find(t=>t.name==='ac_read');
 assert.ok(act);assert.equal(consumerCommands['consumer.ac.inquiry.act'],'actInquiry');
 for(const name of ['ac_room_status_set','ac_room_heartbeat_set'])assert.ok(tools.some(t=>t.name===name));
 assert.deepEqual(read.inputSchema.parse({kind:'inquiry',id:'question'}),{kind:'inquiry',id:'question'});
 assert.match(act.description,/helper agents can never resolve/);
 assert.equal(tools.some(t=>/inquiry.*grant|grant.*inquiry/.test(t.name)),false);
 for(const bad of [{...input,expected_revision:-1},{...input,expected_revision:0.5},{...input,expected_revision:Number.MAX_SAFE_INTEGER+1},{...input,idempotency_key:undefined},{...input,text:' '},{...input,action:'answer'},{...input,action:'follow_up'},{...input,grant:true}])assert.equal(act.inputSchema.safeParse(bad).success,false);
 assert.deepEqual(await act.execute(act.inputSchema.parse(input)),canonical);
 assert.deepEqual(calls,[{route:'/commands',body:{command:'consumer.ac.inquiry.act',arguments:input}}]);
});
test('shipped Moderator artifact registers lifecycle tool and validates revision',async()=>{
 const {createRuntime}=await import('../dist/cowork-mcp.mjs');const registered=new Map();let list;
 const client={row:{},async mutation(){return {result:{status:'committed',data:{effective_action:'follow_up'}}}},async disconnect(){}};
 const runtime=await createRuntime({profile:'moderator',client,injectedServer:{registerTool(name,_schema,execute){registered.set(name,execute)},server:{setRequestHandler(_schema,handler){list=handler}}}});
 try{
  assert.ok((await list()).tools.some(t=>t.name==='ac_inquiry_act'));
  const invalid=await registered.get('ac_inquiry_act')({...input,expected_revision:0.5});assert.equal(invalid.structuredContent.error.code,'invalid_request');
  assert.equal((await registered.get('ac_inquiry_act')(input)).structuredContent.data.effective_action,'follow_up');
 }finally{await runtime.shutdown();}
});
