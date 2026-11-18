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
  add(name,(name==='ac_ask'?'Ask one person in this room a question: an active, admitted human member, not yourself, not an agent or service seat, and in Agent Check-up rooms not the coach account; other targets get not_found. Creates an open question in Needs me on their accountable human’s turn. Explicit ac_inquiry_act reply hands the turn back; ordinary chat replies do not. Only the requester human or original asking agent can resolve. Keep the returned inquiry id and use ac_read kind=inquiry for canonical turn, revision and allowed_actions. Find the person’s actor_id using ac_read with kind=members; use their actor_id, not their membership id. Use audience {"kind":"room"}.':name==='ac_read'?'Read authorized room resources. For questions use kind=inquiry and the inquiry id returned by ac_ask, or omit id to list visible questions. The canonical view includes accountable humans, whose turn, current revision, latest message, allowed_actions and legacy/unavailable boundaries. Read does not answer, resolve or change turn age.':name==='ac_inquiry_act'?'Act on an open question (or resolve an unavailable one if allowed_actions permits) using its canonical inquiry id and expected_revision from ac_read kind=inquiry. Use reply only on your turn (server derives answer or follow_up); progress keeps the turn and its age. Only the requester human or original asking agent can resolve, never a helper. Other agents require their accountable human’s explicit room-scoped helper grant in the web UI. Supply a stable idempotency_key; retry the identical payload/key after an uncertain result. Changed payload needs a new key; stale new actions fail and require a fresh read. Ordinary chat replies and reads do not change the lifecycle. Returns canonical effective_action, turn and revision.':name==='ac_conversation_structure'?'Read this room’s authoritative YAML, revision, digest, configured node/reply types, relation rules and submission example. Read before discussing a structured room.':name==='ac_conversation_submit'?'Submit an explicitly typed node or reply under the exact expected_structure revision/digest from ac_conversation_structure. Use the configured node_type or reply_type, existing references and relation direction. The room rejects invalid structure without recording it; acceptance does not prove truth or consensus.':`Call ${command} under current room authorization.`),schemas[operation],async input=>{
   const result=await client.mutation('/commands',{body:{command,arguments:input}});
   return result.result;
  });
 }
 add('ac_messages','Read retained room messages and command results.',z.object({wire_ids:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),input=>client.messages(input));
 add('ac_commands','Read room command catalogue and current capabilities.',empty,async()=>({advertised:Object.entries(consumerCommands).map(([name,operation])=>({name,description:name,input_schema:zodToJsonSchema(schemas[operation],{$refStrategy:'none'})})),capabilities:{status:'ok',data:await client.request('/resources',{method:'POST',body:{kind:'capabilities'}})}}));
 add('ac_message','Send an ordinary public message or reply only when this room has no active conversation structure. Otherwise read ac_conversation_structure and use ac_conversation_submit with a required node/reply type.',z.object({text:z.string().min(1).refine(value=>Array.from(value).length<=limits.text_characters),...reply}).strict().refine(validReply),async input=>{
  const result=await client.mutation('/messages',{body:input});
  if(result.result.status!=='committed')throw failure(result.result.error?.code??'outcome_unknown');
  return {sent:true,wire_id:result.result.data.id};
 });
 add('ac_send_file','Upload artifact bytes to the room; this does not register a version.',z.union([z.object({path:z.string().min(1),filename:metadata.optional(),mime:metadata.optional(),...reply}).strict(),z.object({data_base64:z.string().max(Math.ceil(limits.file_bytes/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),filename:metadata,mime:metadata.optional(),...reply}).strict()]).refine(validReply),input=>client.sendFile(input));
 add('ac_files','List, receive or open authorized room files.',z.union([z.object({wire_ids:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length).optional(),limit:z.number().int().min(1).max(100).optional()}).strict().refine(value=>value.limit===undefined||value.wire_ids!==undefined),z.object({open_wire_id:id}).strict()]),input=>client.files(input));
 return tools;
}
