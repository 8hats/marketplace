#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z,ZodError} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {CentralClient,failure} from './central-client.mjs';
import {centralTools} from './central-tools.mjs';

export const VERSION='2.0.0';
const encode=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
const instructions='Connect with an HTTPS agent invitation URL or a saved connection_id. Credentials stay in private local storage. Read ac_messages and ac_files after connecting. wait_for_room_event waits without consuming mail and supports cancellation. Room commands use current inherited permissions. Review and result approval still require the human owner.';
const messages={
 central_configuration_required:'Set AC_COWORK_URL to the central HTTPS origin, or provide an HTTPS invitation URL.',
 legacy_configuration_rejected:'Remove legacy daemon settings and configure AC_COWORK_URL.',
 invalid_invitation:'Use a fresh HTTPS agent invitation for the configured central service.',
 credential_storage_failed:'Credential storage failed after exchange. Ask the inviting person to remove the accepted agent, then issue a new invitation.',
 credential_rotation_uncertain:'Credential renewal could not be confirmed. Do not retry rotation; ask the inviting person to remove this agent and issue a new invitation.',
 unauthenticated:'The credential expired or was revoked. Ask the inviting person to remove this agent and issue a new invitation.',
 central_unavailable:'The central service is unavailable. Retry reads; inspect a mutation outcome before repeating it.',
 connection_in_use:'This connection is already open in another process. Disconnect that process first.',
 result_visibility_changed:'Current room visibility differs from the saved result. Inspect current resources; do not repeat the mutation.',
};
export async function createRuntime({client,injectedServer,profile='personal'}={}){
 const server=injectedServer??new McpServer({name:'au-cowork-'+profile,version:VERSION},{capabilities:{logging:{}},instructions});
 client??=new CentralClient({onEvent:event=>{void server.sendLoggingMessage?.({level:'info',logger:'cowork',data:event}).catch(()=>{});}});
 const descriptors=[];let busy=false;
 const register=(name,description,schema,run,concurrent=false)=>{
  descriptors.push({name,description,inputSchema:schema});
  server.registerTool(name,{description,inputSchema:z.object({}).passthrough()},async(input,extra)=>{
   const requestId=randomUUID();
   if(busy&&!concurrent)return {...encode({code:'invalid_state',message:'Another room tool is active.',effect:'none'}),isError:true};
   if(!concurrent)busy=true;
   try{return encode(await run(schema.parse(input??{}),extra?.signal));}
   catch(error){const code=error instanceof ZodError?'invalid_request':/^[a-z_]{1,64}$/.test(error?.code??'')?error.code:'internal_error';return {...encode({ok:false,error:{code,message:messages[code]??code,retryable:['central_unavailable','database_busy','rate_limited'].includes(code)},...(error.operation_id?{operation_id:error.operation_id}:{}),request_id:requestId}),isError:true};}
   finally{if(!concurrent)busy=false;}
  });
 };
 const ok=data=>({ok:true,data,request_id:randomUUID()});
 register('enter_room','Enter a central Cowork room with an invitation and agent display name.',z.object({invite:z.string().min(1),as_agent:z.string().min(1).max(128)}).strict(),async input=>ok(await client.connect(input)));
 register('connect_to_room','Exchange an HTTPS invite once, or reconnect a saved connection_id or unique room name.',z.object({invite:z.string().min(1).optional(),room_name:z.string().min(1).max(256).optional(),connection_id:z.string().uuid().optional()}).strict(),async input=>ok(await client.connect(input)));
 register('disconnect_from_room','Disconnect while retaining the credential and durable inbox.',z.object({}).strict(),async()=>{const room=client.publicRow();await client.disconnect();return ok({...(room?{room_name:room.room_name}:{}),status:'disconnected'});});
 register('list_rooms','List locally saved central room connections.',z.object({}).strict(),async()=>ok({rooms:(await client.store.list()).map(row=>client.publicRow(row))}));
 register('get_room_status','Check central connectivity, authorization and monitor health.',z.object({}).strict(),async()=>{if(!client.row)throw failure('not_connected');const status=await client.request('/session');return ok({...client.publicRow(),can_send:true,can_read:true,monitoring:client.monitorState,room:status.room,capabilities:status.capabilities});});
 register('wait_for_room_event','Wait without consuming mail; sending remains available while waiting.',z.object({timeout_ms:z.number().int().min(1000).max(50000).default(50000)}).strict(),(input,signal)=>client.wait(input.timeout_ms,signal),true);
 for(const tool of centralTools(client,profile))register(tool.name,tool.description,tool.inputSchema,tool.execute);
 server.server?.setRequestHandler(ListToolsRequestSchema,async()=>({tools:descriptors.map(tool=>({name:tool.name,description:tool.description,inputSchema:{...zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}),type:'object'}}))}));
 return {server,client,shutdown:()=>client.disconnect()};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const runtime=await createRuntime();
 await runtime.server.connect(new StdioServerTransport());
 let closing=false;const close=async()=>{if(closing)return;closing=true;await runtime.shutdown();process.exitCode=0;};
 process.stdin.once('end',close);process.stdin.once('close',close);process.once('SIGINT',close);process.once('SIGTERM',close);
}
