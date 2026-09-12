#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {z} from 'zod';
import {createProductTools} from '../../agents-university-cowork/src/product-tools.mjs';
import {MonitorManager} from '../../agents-university-cowork/src/monitor-manager.mjs';

const cid=z.string().regex(/^[a-fA-F0-9]{64}$/);
const configuration=z.object({identityName:z.string().min(1),identityCid:cid,roomCid:cid,roomName:z.string().min(1),monitor:z.boolean().optional()});
export async function createRuntime({inputs}={}){
 const server=new Server({name:'agents-cowork-moderator',version:'1.0.0'},{capabilities:{tools:{},logging:{}},instructions:'Use the assigned existing Moderator identity. On room message/result wakes call ac_messages; on file wakes call ac_files. Inspect unknown results before a deliberate new command. This plugin never creates or selects an identity.'});
 let session={bound:null,ensureAttached:async()=>{throw Error('Moderator inputs missing');}};
 let monitor;
 if(inputs){
  const config=configuration.parse(inputs),sdk=inputs.client;
  if(!sdk||typeof sdk.currentIdentity!=='function')throw Error('An already-bound SDK client is required.');
  const assigned=async()=>{const identity=await sdk.currentIdentity();if(identity?.name!==config.identityName||identity?.cid?.toUpperCase()!==config.identityCid.toUpperCase())throw Error('Assigned Moderator identity is unavailable.');return identity;};
  await assigned();
  const client=new Proxy({}, {get:(_target,method)=>method==='then'?undefined:method==='currentIdentity'?assigned:method==='watchNotifications'?async function*(...args){await assigned();for await(const event of sdk.watchNotifications(...args)){await assigned();yield event;}}:async(...args)=>{await assigned();return sdk[method](...args);}});
  const row={room_name:config.roomName,identity_name:config.identityName,contact_cid:config.roomCid.toUpperCase(),membership_state:'ready'};
  session={bound:row,ensureAttached:async()=>client};
  if(config.monitor!==false){monitor=new MonitorManager({server,registry:{}});monitor.start(client,row);}
 }
 const product=createProductTools(session,{profile:'moderator'});let busy=false;
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[...product.descriptors.values()].map(tool=>({name:tool.name,description:tool.description,inputSchema:{...zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}),type:'object'}}))}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(busy)return {isError:true,content:[{type:'text',text:JSON.stringify({code:'invalid_state',effect:'none',message:'Another Moderator tool is active.'})}]};
  busy=true;try{return await product.execute(request.params.name,request.params.arguments??{});}finally{busy=false;}
 });
 return {server,shutdown:async()=>{monitor?.stop();await server.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let runtime;
 try{
  const modulePath=process.env.AC_MODERATOR_INPUTS_MODULE;let inputs;
  if(modulePath){if(!path.isAbsolute(modulePath))throw Error('Absolute inputs path required');const module=await import(pathToFileURL(modulePath).href);inputs=await module.createModeratorInputs();}
  runtime=await createRuntime({inputs});await runtime.server.connect(new StdioServerTransport());
  let closing=false;const close=async()=>{if(closing)return;closing=true;await runtime.shutdown();};
  process.stdin.once('end',close);process.stdin.once('close',close);process.once('SIGINT',close);process.once('SIGTERM',close);
 }catch{process.stderr.write('Moderator inputs or assigned identity unavailable; verify operator configuration.\n');process.exitCode=1;await runtime?.shutdown();}
}
