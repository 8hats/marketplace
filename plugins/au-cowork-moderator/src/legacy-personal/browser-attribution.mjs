import {z} from 'zod';
import {parseRoomEnvelope} from './mcp/envelope.mjs';
const appMessage=z.object({version:z.literal(1),kind:z.literal('au_cowork_human_message'),transport_role:z.string().min(1).max(8000),author:z.object({id:z.string().min(1).max(128),kind:z.literal('human'),display_name:z.string().min(1).max(8000),role_labels:z.array(z.string().max(8000)).max(100),attribution:z.literal('application_session')}).strict(),text:z.string().refine(value=>Array.from(value).length<=8000)}).strict();
/** Preserve native signer/body. Application session attribution is separate,
 * never a human native CID, external identity verification, or owner authority. */
export function applicationMessage(item,roomCid){
 if(item?.direction!=='in'||typeof item.from?.id!=='string'||item.from.id.toUpperCase()!==roomCid.toUpperCase())return item;
 const body=item.body??item.text;if(typeof body!=='string'||Buffer.byteLength(body)>2*1024*1024)return item;
 const envelope=parseRoomEnvelope(body);
 if(envelope?.kind!=='room_msg'||envelope.author.identity!==roomCid.toUpperCase()||Buffer.byteLength(envelope.text)>262144)return item;
 let parsed;try{parsed=appMessage.safeParse(JSON.parse(envelope.text));}catch{return item;}
 if(!parsed.success||parsed.data.transport_role!==envelope.author.role)return item;
 return {...item,application_message:{author:parsed.data.author,text:parsed.data.text}};
}
