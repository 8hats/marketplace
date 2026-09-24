import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {randomUUID} from 'node:crypto';
import {consumerCommands,consumerToolName,schemas,id,limits} from './product/contracts.mjs';
import {failure} from './central-client.mjs';

const empty=z.object({}).strict();
const metadata=z.string().min(1).refine(value=>Buffer.byteLength(value)<=limits.metadata_bytes);
const reply={reply_to_wire_id:id.optional(),reply_to_sentence:z.number().int().positive().safe().optional()};
const validReply=value=>value.reply_to_sentence===undefined||value.reply_to_wire_id!==undefined;
const moderatorOnly=new Set(['ac_request_route','ac_review_publish','ac_publication_propose','ac_intervention_record','ac_stage_explain','ac_result_create']);
export function centralTools(client,profile='personal'){
 const tools=[];
 const add=(name,description,inputSchema,execute)=>tools.push({name,description,inputSchema,execute});
 for(const [command,operation] of Object.entries(consumerCommands)){
  const name=consumerToolName(command);if(profile!=='moderator'&&moderatorOnly.has(name))continue;
  add(name,`Call ${command} under current room authorization.`,schemas[operation],async input=>{
   const result=await client.mutation('/commands',{body:{command,arguments:input}});
   return result.result;
  });
 }
 add('ac_messages','Read retained room messages and command results.',z.object({wire_ids:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),input=>client.messages(input));
 add('ac_commands','Read room command catalogue and current capabilities.',empty,async()=>({advertised:Object.entries(consumerCommands).map(([name,operation])=>({name,description:name,input_schema:zodToJsonSchema(schemas[operation],{$refStrategy:'none'})})),capabilities:{status:'ok',data:await client.request('/resources',{method:'POST',body:{kind:'capabilities'}})}}));
 add('ac_message','Send a public room message or reply.',z.object({text:z.string().min(1).refine(value=>Array.from(value).length<=limits.text_characters),...reply}).strict().refine(validReply),async input=>{
  const result=await client.mutation('/messages',{body:input});
  if(result.result.status!=='committed')throw failure(result.result.error?.code??'outcome_unknown');
  return {sent:true,wire_id:result.result.data.id};
 });
 add('ac_send_file','Upload artifact bytes to the room; this does not register a version.',z.union([z.object({path:z.string().min(1),filename:metadata.optional(),mime:metadata.optional(),...reply}).strict(),z.object({data_base64:z.string().max(Math.ceil(limits.file_bytes/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),filename:metadata,mime:metadata.optional(),...reply}).strict()]).refine(validReply),input=>client.sendFile(input));
 add('ac_files','List, receive or open authorized room files.',z.union([z.object({wire_ids:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length).optional(),limit:z.number().int().min(1).max(100).optional()}).strict().refine(value=>value.limit===undefined||value.wire_ids!==undefined),z.object({open_wire_id:id}).strict()]),input=>client.files(input));
 return tools;
}
