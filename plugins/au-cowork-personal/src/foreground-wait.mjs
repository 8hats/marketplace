import {bootstrapInstructions} from './bootstrap.mjs';
import {z} from 'zod';
export const waitSchema=z.object({timeout_ms:z.number().int().min(1000).max(50000).default(50000)}).strict();
export const monitorInstructions=bootstrapInstructions+' To submit an artifact result, explicitly call ac_submit_result with existing product attachment IDs and their exact displayed hashes from ac_read. Positive review feedback never triggers submission or approval automatically. The submitted result still requires explicit human Owner approval in the application. On unknown outcome inspect ac_read({kind:"artifact_result"}) and ac_messages; never automatically retry or create another idempotency key.'+' After connecting, drain ac_messages in bounded pages until empty; handle files with ac_files. Use background notifications only if this host has verified automatic wake support; logging capability alone is not proof. Otherwise call wait_for_room_event, handle the event and drain mail, then wait again until the owner stops monitoring. Rearm after timeout; stop on cancellation or disconnection. Application-issued invitations automatically associate the admitted native seat with the application agent; product readiness may still be pending.';
export const waitDescriptor={name:'wait_for_room_event',description:'Wait without consuming mail for one authenticated room event. Portable foreground fallback when automatic background wake is unavailable. Timeout rearms; cancellation stops.',inputSchema:waitSchema};
export const waitResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

export class ForegroundWait {
 constructor({session,monitor,retained=async()=>[]}){this.session=session;this.monitor=monitor;this.retained=retained;this.pending=false;}
 wait({timeout_ms=50000}={},signal){
  if(this.pending)return Promise.resolve({status:'already_waiting'});
  const row=this.session.bound;if(!row)return Promise.resolve({status:'disconnected'});
  if(signal?.aborted)return Promise.resolve({status:'cancelled'});
  this.pending=true;
  return new Promise(resolve=>{
   let done=false,expectedCid=row.identity_cid,unsubscribe=()=>{},delivery=Promise.resolve();
   const finish=value=>{if(done)return;done=true;clearTimeout(timer);unsubscribe();signal?.removeEventListener('abort',cancel);this.pending=false;resolve(value);};
   const cancel=()=>finish({status:'cancelled'});
   const timer=setTimeout(()=>finish({status:'timeout'}),timeout_ms);
   const validate=async()=>{
    if(done)return null;
    if(this.session.bound!==row){finish({status:'disconnected'});return null;}
    const client=await this.session.ensureAttached();if(done)return null;
    const identity=await client.currentIdentity();if(done)return null;
    if(this.session.bound!==row){finish({status:'disconnected'});return null;}
    if(identity?.name!==row.identity_name||!identity?.cid||(expectedCid&&identity.cid.toUpperCase()!==expectedCid.toUpperCase())){finish({status:'identity_mismatch'});return null;}
    expectedCid??=identity.cid;return client;
   };
   const receive=async(eventRow,event)=>{
    if(!eventRow){finish({status:'disconnected'});return;}
    if(eventRow!==row||done)return;
    try{
     const client=await validate();if(!client||done)return;
     if(event.event==='room_file_available'){
      const file=await client.getFileInfo({wire_id:event.file_id});
      if(done||file?.direction!=='in'||file.from?.id!==row.contact_cid)return;
      if(!await validate())return;
     }
     finish({status:'event',event});
    }catch{if(!done)finish({status:'unavailable'});}
   };
   // Subscribe first: an arrival during either snapshot must not be lost.
   unsubscribe=this.monitor.subscribe((eventRow,event)=>{if(!eventRow){finish({status:'disconnected'});return;}delivery=delivery.then(()=>receive(eventRow,event));});
   signal?.addEventListener('abort',cancel,{once:true});
   if(signal?.aborted){cancel();return;}
   void (async()=>{
    try{
     const client=await validate();if(!client||done)return;
     const retained=await this.retained();if(done)return;
     if(!await validate())return;
     for(const item of retained){if(done)return;this.monitor.wakeRetained(row,item);}
     await delivery;if(done)return;
     const [messages,files]=await Promise.all([client.listIncomingMessages(),client.listIncomingFiles()]);if(done)return;
     if(!await validate())return;
     for(const [kind,items] of [['message_received',messages],['file_received',files]])for(const item of items){
      if(done)return;if(item.from?.id!==row.contact_cid)continue;
      await this.monitor.handle(client,row,{event:kind,sender_id:item.from.id,wire_id:item.wire_id});
     }
    }catch{if(!done)finish({status:'unavailable'});}
   })();
  });
 }
}
