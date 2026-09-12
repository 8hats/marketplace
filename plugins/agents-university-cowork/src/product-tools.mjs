import {z, ZodError} from 'zod';
import {registerAgentTools} from './product/agent-tools.mjs';
import {consumerCommands,limits} from './product/contracts.mjs';
import {DomainError,fail} from './product/errors.mjs';
import {parseRoomEnvelope} from './mcp/envelope.mjs';
const consumers=new Set(Object.keys(consumerCommands).map(name=>name.replace('consumer.','').replaceAll('.','_')));
const encode=value=>({content:[{type:'text',text:JSON.stringify(value??null)}]});
const bounded=value=>{const result=encode(value);if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)fail(413,'payload_too_large','Output is too large; inspect retained mail.');return result;};
export function createProductTools(session,{timeoutMs=5000,pollMs=20}={}) {
 const retained=new Map();const descriptors=new Map();
 registerAgentTools(tool=>descriptors.set(tool.name,tool),{}, {roomCid:'0'.repeat(64),timeoutMs,pollMs});
 async function context(){
  const row=session.bound;if(!row)fail(409,'not_connected','Connect to a room first.');
  const client=await session.ensureAttached(),identity=await client.currentIdentity();
  if(identity?.name!==row.identity_name||!z.string().regex(/^[a-fA-F0-9]{64}$/).safeParse(identity.cid).success)fail(403,'forbidden','Current identity does not match the selected room.');
  const key=JSON.stringify([row.identity_name,row.contact_cid,identity.cid.toUpperCase()]);
  let selected=retained.get(key);
  if(!selected){
   if(retained.size>=100)fail(409,'invalid_state','Session room retention limit reached.');
   const tools=new Map();
   // Resolve the current lease on each call, so explicit disconnect/reconnect
   // preserves retained replies without keeping the old SDK lease alive.
   const expected={name:row.identity_name,room:row.contact_cid,cid:identity.cid.toUpperCase()};
   const proxy=new Proxy({}, {get:(_target,method)=>async(...args)=>{
    const sdk=await session.ensureAttached(),current=await sdk.currentIdentity();
    if(session.bound?.identity_name!==expected.name||session.bound?.contact_cid!==expected.room||current?.name!==expected.name||current?.cid?.toUpperCase()!==expected.cid)fail(403,'forbidden','Room identity changed before SDK operation.');
    return sdk[method](...args);
   }});
   const harness=registerAgentTools(tool=>tools.set(tool.name,tool),proxy,{roomCid:row.contact_cid,timeoutMs,pollMs});
   selected={tools,harness};retained.set(key,selected);
  }
  const check=async()=>{const current=await client.currentIdentity();if(session.bound!==row||current?.name!==row.identity_name||current?.cid?.toUpperCase()!==identity.cid.toUpperCase())fail(403,'forbidden','Room identity changed during the call.');};
  return {...selected,check};
 }
 async function execute(name,input={}) {
  let invoked=false;
  try {
   const descriptor=descriptors.get(name);const parsed=descriptor.inputSchema.parse(input);
   if(Buffer.byteLength(JSON.stringify(parsed))>limits.json_bytes&&name!=='ac_send_file')fail(413,'payload_too_large','Arguments exceed the room command limit.');
   const ctx=await context();
   let value;invoked=true;
   if(name==='ac_messages'||consumers.has(name))value=await ctx.harness.call(name,parsed,{retainReceived:true});
   else if(name==='ac_commands'){
    const client=await session.ensureAttached();const advertised=await client.listContactCommands({contact:session.bound.contact_cid});
    value={advertised,capabilities:await ctx.harness.call('ac_read',{kind:'capabilities'},{retainReceived:true})};
   }else value=await ctx.tools.get(name).execute(parsed);
   await ctx.check();const result=bounded(value);
   if(name==='ac_messages')ctx.harness.acknowledgeReceived(value);
   else if(consumers.has(name))ctx.harness.acknowledgeCommandResult(value);
   else if(name==='ac_commands')ctx.harness.acknowledgeCommandResult(value.capabilities);
   return result;
  }catch(error){return {isError:true,...encode(error instanceof DomainError?{code:error.code,message:error.message,effect:invoked&&error.effect==='none'?'unknown':error.effect}:error instanceof ZodError?{code:'invalid_request',message:'Invalid room tool arguments.',effect:'none'}:{code:'dependency_unavailable',message:'Outcome unavailable; inspect state before repeating a mutation.',effect:'unknown'})};}
 }
 async function readLegacy(limit=50,render=value=>value){
  const ctx=await context();const page=await ctx.harness.call('ac_messages',{limit:Math.min(limit,100)},{retainReceived:true,legacyMessageFilter:item=>item.from?.id?.toUpperCase()===session.bound.contact_cid.toUpperCase()&&parseRoomEnvelope(item.body??item.text,session.bound.room_name)?.kind==='room_msg'});
  if(!page.messages) return render({messages:[],remaining:0,outcome:page});
  const selected=[],messages=[];
  for(const item of page.messages){if(item.from?.id?.toUpperCase()!==session.bound.contact_cid.toUpperCase())continue;const body=parseRoomEnvelope(item.body??item.text,session.bound.room_name);if(body?.kind!=='room_msg')continue;selected.push(item);messages.push({message_id:body.message_id,wire_id:item.wire_id,author:body.author,text:body.text,time:body.at??item.date,kind:body.kind});}
  const value={messages,command_results:page.command_results,remaining:page.remaining+page.messages.length-selected.length+page.unmatched_results.length};
  await ctx.check();const result=render(value);if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)fail(413,'payload_too_large','Legacy output exceeds the limit; use ac_messages to inspect retained mail.');
  ctx.harness.acknowledgeReceived({...page,messages:selected,unmatched_results:[]});
  return result;
 }
 return {descriptors,execute,readLegacy};
}
