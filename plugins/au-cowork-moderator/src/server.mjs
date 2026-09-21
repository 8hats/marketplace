#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {z} from 'zod';
import {createProductTools} from '../../au-cowork-personal/src/product-tools.mjs';
import {MonitorManager} from '../../au-cowork-personal/src/monitor-manager.mjs';

import {ForegroundWait,waitSchema,waitDescriptor,waitResult,monitorInstructions} from '../../au-cowork-personal/src/foreground-wait.mjs';
import {remoteDiagnostic} from '../../au-cowork-personal/src/remote-config.mjs';
import {sessionRegistry} from '../../au-cowork-personal/src/session-registries.mjs';
import {CoworkSession} from '../../au-cowork-personal/src/session.mjs';
import {ConnectionRegistry,connectionView} from '../../au-cowork-personal/src/connections.mjs';
import {connectInvite,reconnectInvite} from '../../au-cowork-personal/src/invite-session.mjs';

const cid=z.string().regex(/^[a-fA-F0-9]{64}$/);
const configuration=z.object({identityName:z.string().min(1),identityCid:cid,roomCid:cid,roomName:z.string().min(1),monitor:z.boolean().optional()});
export async function createRuntime({inputs,session: suppliedSession,connections:injectedConnections}={}){
 const server=new Server({name:'au-cowork-moderator',version:'1.2.0'},{capabilities:{tools:{},logging:{}},instructions:monitorInstructions});
 let session=inputs?null:(suppliedSession??new CoworkSession());
 if(!inputs)session.connections=injectedConnections??session.connections??sessionRegistry(session,ConnectionRegistry,['init','list','get','reserve','update']);
 const monitor=new MonitorManager({server,registry:{}});
 if(inputs){
  const config=configuration.parse(inputs),sdk=inputs.client;
  if(!sdk||typeof sdk.currentIdentity!=='function')throw Error('An already-bound SDK client is required.');
  const assigned=async()=>{const identity=await sdk.currentIdentity();if(identity?.name!==config.identityName||identity?.cid?.toUpperCase()!==config.identityCid.toUpperCase())throw Error('Assigned Moderator identity is unavailable.');return identity;};
  await assigned();
  const client=new Proxy({}, {get:(_target,method)=>method==='then'?undefined:method==='currentIdentity'?assigned:method==='watchNotifications'?async function*(...args){await assigned();for await(const event of sdk.watchNotifications(...args)){await assigned();yield event;}}:async(...args)=>{await assigned();return sdk[method](...args);}});
  const row={room_name:config.roomName,identity_name:config.identityName,identity_cid:config.identityCid,contact_cid:config.roomCid.toUpperCase(),membership_state:'ready'};
  session={bound:row,ensureAttached:async()=>client};
  if(config.monitor!==false){monitor.start(client,row);}
 }
 const product=createProductTools(session,{profile:'moderator',onRetainedMessage:(row,item)=>monitor?.wakeRetained(row,item)});let busy=false;
 const waiter=new ForegroundWait({session,monitor,retained:()=>product.retainedMessages()});
 const lifecycle=inputs?[]:[{name:'connect_to_room',description:'Create a persistent Moderator with an invite once, or reconnect its explicit connection_id; never redeem again for reconnect.',inputSchema:z.object({invite:z.string().min(1).optional(),connection_id:z.string().uuid().optional()}).strict().refine(v=>Boolean(v.invite)!==Boolean(v.connection_id))},{name:'disconnect_from_room',description:'Release this session lease while retaining identity and room membership.',inputSchema:z.object({}).strict()},{name:'list_rooms',description:'List saved Moderator connections for explicit reconnect selection.',inputSchema:z.object({}).strict()}];
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[waitDescriptor,...lifecycle,...product.descriptors.values()].map(tool=>({name:tool.name,description:tool.description,inputSchema:{...zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}),type:'object'}}))}));
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
  if(request.params.name===waitDescriptor.name){try{return waitResult(await waiter.wait(waitSchema.parse(request.params.arguments??{}),extra?.signal));}catch{return {isError:true,...waitResult({status:'invalid_request'})};}}
  if(busy)return {isError:true,content:[{type:'text',text:JSON.stringify({code:'invalid_state',effect:'none',message:'Another Moderator tool is active.'})}]};
  busy=true;try{
   const tool=lifecycle.find(t=>t.name===request.params.name);
   if(tool){
    try{
     const args=tool.inputSchema.parse(request.params.arguments??{});let data;
     if(tool.name==='connect_to_room'){data=args.invite?await connectInvite(session,args.invite,'moderator'):await reconnectInvite(session,args.connection_id,'moderator');monitor.start(await session.ensureAttached(),session.bound);}
     else if(tool.name==='list_rooms'){data={rooms:(await session.connections.list('moderator')).map(connectionView)};}
     else {monitor?.stop();await session.release();data={status:'disconnected'};}
     return {content:[{type:'text',text:JSON.stringify({ok:true,data})}]};
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{...(remoteDiagnostic(error)??{code:error instanceof z.ZodError?'invalid_request':(['session_already_bound','invite_already_attempted','identity_in_use','identity_mismatch','room_contact_missing','connection_not_found','connection_outcome_unresolved','connection_registry_unsafe','connection_registry_unavailable'].includes(error.code)?error.code:'connection_failed'),...(error.connection_id?{connection_id:error.connection_id,identity_name:error.identity_name,identity_retained:error.identity_retained}:{}),message:'Connection did not complete. Inspect admission before attempting another session.'}),...(error.connection_id?{connection_id:error.connection_id,identity_name:error.identity_name,identity_retained:error.identity_retained}:{})}})}]};}
   }
   return await product.execute(request.params.name,request.params.arguments??{});
  }finally{busy=false;}
 });
 return {server,session,shutdown:async()=>{monitor?.stop();if(!inputs)await session.release();await server.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let runtime;
 try{
  const modulePath=process.env.AC_MODERATOR_INPUTS_MODULE;let inputs;
  if(modulePath){if(!path.isAbsolute(modulePath))throw Error('Absolute inputs path required');const module=await import(pathToFileURL(modulePath).href);inputs=await module.createModeratorInputs();}
  runtime=await createRuntime({inputs});await runtime.server.connect(new StdioServerTransport());
  let closing=false;const close=async()=>{if(closing)return;closing=true;await runtime.shutdown();};
  process.stdin.once('end',close);process.stdin.once('close',close);process.once('SIGINT',close);process.once('SIGTERM',close);
 }catch(error){process.stderr.write((remoteDiagnostic(error)?.message??'Moderator inputs or assigned identity unavailable; verify operator configuration.')+'\n');process.exitCode=1;await runtime?.shutdown();}
}
