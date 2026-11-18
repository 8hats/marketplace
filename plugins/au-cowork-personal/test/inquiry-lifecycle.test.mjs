import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {consumerCommands} from '../src/product/contracts.mjs';

const input={inquiry_id:'question',expected_revision:2,idempotency_key:'stable-action',action:'reply',text:'Follow-up'};
test('direct canonical read supplies revision and actions without room-history loading',async()=>{
 const calls=[],view={id:'question',state:'open',lifecycle:{revision:2,turn:'requester'},allowed_actions:['reply','progress','resolve']};
 const tools=centralTools({async mutation(route,{body}){calls.push({route,body});return {result:{status:'committed',data:body.command==='consumer.ac.read'?view:{effective_action:'follow_up',inquiry:{...view,lifecycle:{revision:3,turn:'recipient'},allowed_actions:['resolve']}}}}},messages(){throw Error('full room history must not be needed')}});
 const read=tools.find(t=>t.name==='ac_read'),act=tools.find(t=>t.name==='ac_inquiry_act');
 const result=await read.execute(read.inputSchema.parse({kind:'inquiry',id:'question'}));
 assert.equal(result.data.lifecycle.revision,2);assert.deepEqual(result.data.allowed_actions,['reply','progress','resolve']);
 const action=await act.execute(act.inputSchema.parse({...input,expected_revision:result.data.lifecycle.revision}));
 assert.equal(action.data.effective_action,'follow_up');assert.equal(action.data.inquiry.lifecycle.revision,3);
 assert.deepEqual(calls,[{route:'/commands',body:{command:'consumer.ac.read',arguments:{kind:'inquiry',id:'question'}}},{route:'/commands',body:{command:'consumer.ac.inquiry.act',arguments:input}}]);
});
test('both shipped bundles expose canonical reads/actions with the same safe revision checks',async()=>{
 for(const bundle of ['../dist/cowork-mcp.mjs','../harness/dist/cowork-mcp.mjs']){
  const {createRuntime}=await import(bundle),registered=new Map();let list;
  const client={row:{},async mutation(route,{body}){assert.equal(route,'/commands');return {result:{status:'committed',data:body.command==='consumer.ac.read'?{id:'question',lifecycle:{revision:2,turn:'requester'},allowed_actions:['reply','progress','resolve']}:{effective_action:'follow_up',inquiry:{lifecycle:{revision:3,turn:'recipient'}}}}}},async disconnect(){}};
  const runtime=await createRuntime({client,injectedServer:{registerTool(name,_schema,execute){registered.set(name,execute)},server:{setRequestHandler(_schema,handler){list=handler}}}});
  try{
   const definitions=(await list()).tools;assert.ok(definitions.some(t=>t.name==='ac_inquiry_act'));assert.equal(definitions.some(t=>/inquiry.*grant|grant.*inquiry/.test(t.name)),false);
   const read=await registered.get('ac_read')({kind:'inquiry',id:'question'});assert.equal(read.structuredContent.data.lifecycle.revision,2);assert.deepEqual(read.structuredContent.data.allowed_actions,['reply','progress','resolve']);
   const invalid=await registered.get('ac_inquiry_act')({...input,expected_revision:0.5});assert.equal(invalid.isError,true);assert.equal(invalid.structuredContent.error.code,'invalid_request');
   const action=await registered.get('ac_inquiry_act')(input);assert.equal(action.structuredContent.data.effective_action,'follow_up');assert.equal(action.structuredContent.data.inquiry.lifecycle.revision,3);
  }finally{await runtime.shutdown();}
 }
});
test('both profiles discover authorized inquiry reads/actions but no helper-grant tool',async()=>{
 for(const profile of ['personal','moderator']){
  const calls=[],canonical={status:'committed',data:{effective_action:'follow_up',inquiry:{lifecycle:{turn:'recipient',revision:3}}}};
  const tools=centralTools({async mutation(route,{body}){calls.push({route,body});return {result:canonical}}},profile),act=tools.find(t=>t.name==='ac_inquiry_act'),read=tools.find(t=>t.name==='ac_read');
  assert.ok(act);assert.equal(consumerCommands['consumer.ac.inquiry.act'],'actInquiry');
  assert.deepEqual(read.inputSchema.parse({kind:'inquiry',id:'question'}),{kind:'inquiry',id:'question'});
  assert.deepEqual(read.inputSchema.parse({kind:'inquiry'}),{kind:'inquiry'});
  assert.match(act.description,/stable idempotency_key/);assert.match(act.description,/explicit room-scoped helper grant/);
  assert.match(tools.find(t=>t.name==='ac_ask').description,/ordinary chat replies do not/);
  assert.equal(tools.some(t=>/grant.*inquiry|inquiry.*grant/i.test(t.name)),false);
  assert.deepEqual(act.inputSchema.parse(input),input);
  for(const bad of [{...input,inquiry_id:undefined},{...input,expected_revision:undefined},{...input,expected_revision:-1},{...input,expected_revision:0.5},{...input,expected_revision:Number.MAX_SAFE_INTEGER+1},{...input,idempotency_key:undefined},{...input,text:'   '},{...input,action:'answer'},{...input,action:'follow_up'},{...input,grant:true}])assert.equal(act.inputSchema.safeParse(bad).success,false);
  assert.deepEqual(await act.execute(input),canonical);assert.deepEqual(await act.execute(input),canonical);
  assert.deepEqual(calls,Array.from({length:2},()=>({route:'/commands',body:{command:'consumer.ac.inquiry.act',arguments:input}})));
 }
});
