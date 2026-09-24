import {randomUUID,createHash} from 'node:crypto';
import {constants,lstatSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {windowsPrivateState} from './windows-private-state.mjs';

export const failure=code=>Object.assign(new Error(code),{code});
const uuid=/^[a-f0-9-]{36}$/;
const secret=/^[A-Za-z0-9_-]{43}$/;
export function centralOrigin(value){
 let url;try{url=new URL(value);}catch{throw failure('central_configuration_required');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw failure('invalid_central_url');
 return url.origin;
}
export function invitation(value,configured){
 let url;try{url=new URL(value);}catch{throw failure('invalid_invitation');}
 const origin=centralOrigin(url.origin),match=url.hash.match(/^#\/agent-invite\/([A-Za-z0-9_-]{43})$/);
 if(url.username||url.password||url.pathname!=='/'||url.search||!match||(configured&&origin!==centralOrigin(configured)))throw failure('invalid_invitation');
 return {origin,token:match[1]};
}
export class ConnectionStore {
 constructor(root=process.env.AC_COWORK_HOME??path.join(homedir(),'.local','share','au-cowork-central')){if(!path.isAbsolute(root))throw failure('unsafe_state_directory');this.root=root;this.leases=new Map();}
 async init(){
  if(process.platform==='win32'){await windowsPrivateState(this.root,true);return;}
  await fs.mkdir(this.root,{recursive:true,mode:0o700});
  let ancestor=path.parse(this.root).root;
  for(const segment of this.root.slice(ancestor.length).split(path.sep).filter(Boolean)){
   ancestor=path.join(ancestor,segment);const info=await fs.lstat(ancestor);
   const trustedTemporary=(info.mode&0o1000)!==0&&info.uid===0;
   if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0&&info.uid!==process.getuid?.()||(info.mode&0o022)&&!trustedTemporary)throw failure('unsafe_state_directory');
  }
  const state=await fs.lstat(this.root);
  if(!state.isDirectory()||state.isSymbolicLink()||(process.getuid&&state.uid!==process.getuid())||(state.mode&0o077))throw failure('unsafe_state_directory');
 }
 file(id){if(!uuid.test(id))throw failure('connection_not_found');return path.join(this.root,id+'.json');}
 async load(id){
  await this.init();let handle;
  try{
   if(process.platform==='win32'){await fs.lstat(this.file(id));await windowsPrivateState(this.file(id),false);}
   handle=await fs.open(this.file(id),constants.O_RDONLY|constants.O_NOFOLLOW);
   const info=await handle.stat();if(!info.isFile()||process.platform!=='win32'&&(info.mode&0o077)||info.size>8*1024*1024||(process.getuid&&info.uid!==process.getuid()))throw failure('unsafe_connection_state');
   const row=JSON.parse(await handle.readFile('utf8'));
   if(row.version!==1||row.connection_id!==id||!secret.test(row.credential)||!Array.isArray(row.staged)||!Number.isSafeInteger(row.cursor)||row.cursor<0||!Array.isArray(row.consumed_files))throw failure('invalid_connection_state');
   centralOrigin(row.origin);return row;
  }catch(error){if(error.code==='ENOENT')throw failure('connection_not_found');throw error;}finally{await handle?.close();}
 }
 async save(row){
  await this.init();const target=this.file(row.connection_id),temporary=target+'.'+randomUUID()+'.tmp';
  const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{if(process.platform==='win32')await windowsPrivateState(temporary,false);await handle.writeFile(JSON.stringify(row));await handle.sync();}catch(error){await handle.close();await fs.unlink(temporary).catch(()=>{});throw error;}finally{await handle.close();}
  try{await fs.rename(temporary,target);if(process.platform!=='win32'){const directory=await fs.open(this.root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}}
  catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
 }
 async list(){await this.init();const rows=[];for(const name of await fs.readdir(this.root))if(name.endsWith('.json')&&uuid.test(name.slice(0,-5)))rows.push(await this.load(name.slice(0,-5)));return rows;}
 async acquire(id){
  await this.init();const filename=this.file(id)+'.lease',lease={pid:process.pid,nonce:randomUUID()};
  let handle;
  try{handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const recovery=filename+'.recovery';
   try{await fs.mkdir(recovery,{mode:0o700});}catch{throw failure('connection_in_use');}
   try{
    let previous,reader;
    try{if(process.platform==='win32')await windowsPrivateState(filename,false);reader=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await reader.stat();if(!info.isFile()||info.size>1024||process.platform!=='win32'&&(info.mode&0o077)||(process.getuid&&info.uid!==process.getuid()))throw failure('connection_in_use');previous=JSON.parse(await reader.readFile('utf8'));}catch{throw failure('connection_in_use');}finally{await reader?.close();}
    if(!Number.isInteger(previous.pid)||previous.pid<1)throw failure('connection_in_use');
    try{process.kill(previous.pid,0);throw failure('connection_in_use');}catch(cause){if(cause.code!=='ESRCH')throw failure('connection_in_use');}
    await fs.unlink(filename);handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   }finally{await fs.rmdir(recovery);}
  }
  try{await handle.writeFile(JSON.stringify(lease));await handle.sync();}finally{await handle.close();}
  this.leases.set(id,lease.nonce);
 }
 async release(id){
  const nonce=this.leases.get(id);if(!nonce)return;
  const filename=this.file(id)+'.lease';
  const lease=JSON.parse(await fs.readFile(filename,'utf8'));if(lease.nonce!==nonce)throw failure('connection_lease_changed');
  await fs.unlink(filename);this.leases.delete(id);
 }
}

export class CentralClient {
 constructor({fetchFn=fetch,store=new ConnectionStore(),origin=process.env.AC_COWORK_URL,onEvent=()=>{}}={}){
  const incompatible=['OURS_PORT','OURS_STATE_DIR','OURS_CONFIG','OURS_URL','OURS_TOKEN','OURS_TOKEN_FILE','AU_OURS_URL','AU_OURS_API_TOKEN','AU_OURS_CONFIG','AC_REMOTE_OURS_URL','AC_REMOTE_OURS_TOKEN_FILE','AC_MODERATOR_INPUTS_MODULE'].some(key=>process.env[key]);
  if(incompatible)throw failure('legacy_configuration_rejected');
  try{lstatSync(path.resolve('.au-ours.json'));throw failure('legacy_configuration_rejected');}catch(error){if(error.code!=='ENOENT')throw error;}
  this.fetchFn=fetchFn;this.store=store;this.origin=origin?centralOrigin(origin):undefined;this.onEvent=onEvent;this.row=null;this.monitor=null;this.work=null;this.listeners=new Set();this.stateQueue=Promise.resolve();this.monitorState='disconnected';
 }
 async request(route,{method='GET',body,bytes,headers={},signal,origin=this.row?.origin??this.origin,credential=this.row?.credential,raw=false}={}){
  if(!origin)throw failure('central_configuration_required');centralOrigin(origin);
  const timeout=AbortSignal.timeout(route.startsWith('/events')?35000:30000),combined=signal?AbortSignal.any([timeout,signal]):timeout;
  let response;
  try{response=await this.fetchFn(origin+'/api/v1/agent'+route,{method,redirect:'error',signal:combined,headers:{...(credential?{authorization:'Bearer '+credential}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:bytes!==undefined?{body:bytes}:{})});}
  catch(error){if(signal?.aborted)throw failure('cancelled');throw failure('central_unavailable');}
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(reader)try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4*1024*1024){await reader.cancel();throw failure('response_too_large');}chunks.push(item.value);}}finally{reader.releaseLock();}
  const buffer=Buffer.concat(chunks);
  if(raw&&response.ok)return {bytes:buffer,headers:response.headers};
  let payload;try{payload=JSON.parse(buffer.toString('utf8'));}catch{throw failure('invalid_central_response');}
  if(!response.ok){const code=typeof payload?.error?.code==='string'&&/^[a-z_]{1,64}$/.test(payload.error.code)?payload.error.code:'central_unavailable';throw failure(code);}
  if(!Object.hasOwn(payload,'data'))throw failure('invalid_central_response');return payload.data;
 }
 async update(change){
  const work=this.stateQueue.then(async()=>{if(!this.row)throw failure('not_connected');const next=structuredClone(this.row);change(next);await this.store.save(next);this.row=next;});
  this.stateQueue=work.catch(()=>{});return work;
 }
 publicRow(row=this.row){return row?{connection_id:row.connection_id,room_name:row.room_name,room_id:row.room_id,as_agent:row.display_name,status:row.connection_id===this.row?.connection_id?'connected':'disconnected',membership_state:'ready',bind_state:row.connection_id===this.row?.connection_id?'bound_here':'unbound'}:null;}
 async connect({invite,connection_id,room_name,as_agent}){
  if(this.row)throw failure('session_already_bound');
  if([invite,connection_id,room_name].filter(Boolean).length!==1)throw failure('invalid_request');
  await this.store.init();
  if(invite){
   const parsed=invitation(invite,this.origin),accepted=await this.request('/exchange',{method:'POST',body:{token:parsed.token,display_name:as_agent??'Cowork agent'},origin:parsed.origin,credential:undefined});
   if(!secret.test(accepted.credential)||typeof accepted.room_id!=='string'||typeof accepted.agent_id!=='string')throw failure('invalid_central_response');
   const row={version:1,connection_id:randomUUID(),origin:parsed.origin,...accepted,cursor:0,staged:[],consumed_files:[]};
   await this.store.acquire(row.connection_id);
   try{await this.store.save(row);this.row=row;}catch(error){await this.store.release(row.connection_id);throw failure('credential_storage_failed');}
  }else{
   if(room_name){const rows=(await this.store.list()).filter(row=>row.room_name===room_name);if(rows.length!==1)throw failure(rows.length?'connection_selection_required':'connection_not_found');connection_id=rows[0].connection_id;}
   await this.store.acquire(connection_id);
   try{const row=await this.store.load(connection_id);if(row.rotation_pending)throw failure('credential_rotation_uncertain');if(this.origin&&row.origin!==this.origin)throw failure('central_origin_mismatch');await this.request('/session',{origin:row.origin,credential:row.credential});this.row=row;}catch(error){await this.store.release(connection_id);throw error;}
  }
  this.startMonitor();return {...this.publicRow(),monitoring_instructions:'Read ac_messages and ac_files. wait_for_room_event waits without consuming mail.'};
 }
 async disconnect(){
  this.monitor?.abort();await this.work;await this.stateQueue;
  const row=this.row;this.row=null;this.monitor=null;this.monitorState='disconnected';
  if(row)await this.store.release(row.connection_id);
  for(const listener of this.listeners)listener({status:'disconnected'});
 }
 wake(event){const value={status:'event',event:{event_id:event.event_id,kind:event.kind,resource:event.resource,seq:event.seq}};this.onEvent(value);for(const listener of this.listeners)listener(value);}
 async renewCredential(){
  if(this.row.rotation_pending)throw failure('credential_rotation_uncertain');
  const expires=Date.parse(this.row.expires_at);if(!Number.isFinite(expires))throw failure('invalid_connection_state');
  if(expires-Date.now()>24*60*60*1000)return;
  if(expires<=Date.now())throw failure('unauthenticated');
  await this.update(row=>{row.rotation_pending=true;});
  try{
   const renewed=await this.request('/credentials/rotate',{method:'POST'});
   if(!secret.test(renewed.credential)||!Number.isFinite(Date.parse(renewed.expires_at))||Date.parse(renewed.expires_at)<=Date.now())throw failure('invalid_central_response');
   await this.update(row=>{row.credential=renewed.credential;row.credential_id=renewed.credential_id;row.expires_at=renewed.expires_at;row.rotation_pending=false;});
  }catch{throw failure('credential_rotation_uncertain');}
 }
 startMonitor(){
  this.monitor=new AbortController();const signal=this.monitor.signal;this.monitorState='running';
  this.work=(async()=>{
   let failures=0;
   while(!signal.aborted&&this.row){
    try{
     await this.renewCredential();
     await this.reconcileFiles();
     if(this.row.staged.length>=5000){this.monitorState='backpressure';await delay(1000,undefined,{signal});continue;}
     const page=await this.request('/events?after='+this.row.cursor+'&limit=100&wait_ms=25000',{signal});
     if(!Array.isArray(page.events)||!Number.isSafeInteger(page.cursor)||page.cursor<this.row.cursor)throw failure('invalid_central_response');
     const fresh=[];
     await this.update(row=>{const known=new Set(row.staged.map(event=>event.event_id));for(const event of page.events){if(typeof event.event_id!=='string'||!Number.isSafeInteger(event.seq)||event.seq>page.cursor)throw failure('invalid_central_response');if(!known.has(event.event_id)){row.staged.push(event);fresh.push(event);known.add(event.event_id);}}row.cursor=page.cursor;});
     await this.reconcileFiles();
     failures=0;this.monitorState='running';for(const event of fresh)if(this.row.staged.some(staged=>staged.event_id===event.event_id))this.wake(event);
    }catch(error){
     if(signal.aborted)break;
     if(['unauthenticated','forbidden','not_found','invalid_state','invalid_cursor','invalid_central_response','invalid_connection_state','unsafe_connection_state','credential_rotation_uncertain'].includes(error.code)){this.monitorState=error.code;for(const listener of this.listeners)listener({status:'unavailable',code:error.code});break;}
     this.monitorState='reconnecting';const backoff=Math.min(30000,500*2**Math.min(failures++,6));
     try{await delay(Math.floor(backoff*(0.75+Math.random()*0.5)),undefined,{signal});}catch{break;}
    }
   }
  })();
 }
 async wait(timeout,signal){
  if(!this.row)return {status:'disconnected'};
  if(this.row.staged.length)return {status:'event',event:{event_id:this.row.staged[0].event_id,kind:this.row.staged[0].kind,resource:this.row.staged[0].resource}};
  if(!['running','reconnecting','backpressure'].includes(this.monitorState))return {status:'unavailable',code:this.monitorState};
  if(signal?.aborted)return {status:'cancelled'};
  return new Promise(resolve=>{let timer;const done=value=>{clearTimeout(timer);this.listeners.delete(done);signal?.removeEventListener('abort',cancel);resolve(value);};const cancel=()=>done({status:'cancelled'});this.listeners.add(done);timer=setTimeout(()=>done({status:'timeout'}),timeout);signal?.addEventListener('abort',cancel,{once:true});});
 }
 async acknowledge(events){
  if(!events.length)return;
  const ids=events.map(event=>event.event_id);
  await this.request('/ack',{method:'POST',body:{event_ids:ids}});
  await this.update(row=>{row.staged=row.staged.filter(event=>!ids.includes(event.event_id));});
 }
 async reconcileFiles(){
  const consumed=new Set(this.row.consumed_files);
  const events=this.row.staged.filter(event=>event.resource.kind==='attachment'&&consumed.has(event.resource.id));
  for(let offset=0;offset<events.length;offset+=100)await this.acknowledge(events.slice(offset,offset+100));
 }
 async mutation(route,{body,bytes,headers={}}={}){
  if(!this.row)throw failure('not_connected');
  const fingerprint=createHash('sha256').update(JSON.stringify({route,body,headers,hash:bytes?createHash('sha256').update(bytes).digest('hex'):undefined})).digest('hex');
  let key;
  await this.update(row=>{row.pending_operations??={};key=row.pending_operations[fingerprint]??randomUUID();if(Object.keys(row.pending_operations).length>=100&&!row.pending_operations[fingerprint])throw failure('pending_operation_limit');row.pending_operations[fingerprint]=key;});
  try{
   const value=await this.request(route,{method:'POST',...(body?{body:{...body,idempotency_key:key}}:{bytes,headers:{...headers,'idempotency-key':key}})});
   await this.update(row=>{delete row.pending_operations[fingerprint];});return value;
  }catch(error){
   if(['invalid_request','forbidden','not_found','idempotency_conflict','sentence_reply_unsupported','file_reply_unsupported','file_too_large'].includes(error.code))await this.update(row=>{delete row.pending_operations[fingerprint];});
   error.operation_id=key;throw error;
  }
 }
 async messages(input={}){
  if(!this.row)throw failure('not_connected');
  const selected=this.row.staged.filter(event=>event.resource.kind!=='attachment'&&(!event.retry_after||event.retry_after<=Date.now())&&(!input.wire_ids||input.wire_ids.includes(event.resource.id)||input.wire_ids.includes(event.event_id))).slice(0,input.limit??50);
  const messages=[],command_results=[],unmatched_results=[],consumed=[],deferred=[];
  for(const event of selected){
   try{
   if(event.resource.kind==='message'){
    const message=await this.request('/messages/'+encodeURIComponent(event.resource.id));
    messages.push({wire_id:message.id,from:message.author,direction:'in',message_kind:'text',body:message.text,text:message.text,at:message.at,...(message.reply_to?{reply_to:{wire_id:message.reply_to.id,...(message.reply_to_sentence?{sentence:message.reply_to_sentence}:{})}}:{})});
   }else if(event.resource.kind==='command'){
    const command=await this.request('/commands/'+encodeURIComponent(event.resource.id));command_results.push({request_wire_id:command.command_id,wire_id:event.event_id,result:command.result});
   }else messages.push({wire_id:event.event_id,message_kind:'room_event',direction:'in',body:JSON.stringify(event),from:{id:this.row.room_id,name:this.row.room_name}});
   consumed.push(event);
   }catch(error){
    if(['not_found','forbidden','result_visibility_changed'].includes(error.code)){messages.push({wire_id:event.event_id,message_kind:'unavailable',code:error.code});consumed.push(event);}
    else if(['central_unavailable','database_busy','rate_limited'].includes(error.code))deferred.push(event.event_id);
    else throw error;
   }
  }
  const output={messages,command_results,unmatched_results,remaining:this.row.staged.length-consumed.length,...(deferred.length?{deferred_event_ids:deferred}:{})};
  if(Buffer.byteLength(JSON.stringify(output))>3*1024*1024)throw failure('response_too_large');
  await this.acknowledge(consumed);
  if(deferred.length)await this.update(row=>{for(const event of row.staged)if(deferred.includes(event.event_id))event.retry_after=Date.now()+2000;});
  return output;
 }
 async files(input={}){
  if(!this.row)throw failure('not_connected');
  if(input.open_wire_id){
   const metadata=await this.request('/files/'+encodeURIComponent(input.open_wire_id));
   const downloaded=await this.request('/files/'+encodeURIComponent(input.open_wire_id)+'?content=1',{raw:true});
   if(downloaded.bytes.length!==metadata.attachment.size||createHash('sha256').update(downloaded.bytes).digest('hex')!==metadata.attachment.hash)throw failure('invalid_version_hash');
   return {file:metadata,data_base64:downloaded.bytes.toString('base64')};
  }
  const project=file=>({...file,wire_id:file.id,from:file.author??{id:this.row.room_id,name:this.row.room_name},direction:'in',filename:file.attachment.filename,mime:file.attachment.mime,size:file.attachment.size,sha256:file.attachment.hash});
  if(!input.wire_ids){
   for(let attempt=0;attempt<50;attempt++){
    const after=this.row.files_cursor??0,page=await this.request('/files'+(after?'?after='+after:''));
    const incoming=page.files.filter(file=>!this.row.consumed_files.includes(file.id)).map(project);
    if(incoming.length)return {incoming,has_more:page.has_more??false};
    if(page.cursor!==undefined){if(!Number.isSafeInteger(page.cursor)||page.cursor<after||page.has_more&&page.cursor===after)throw failure('invalid_central_response');await this.update(row=>{row.files_cursor=page.cursor;});}
    if(!page.has_more)return {incoming:[],has_more:false};
   }
   return {incoming:[],has_more:true};
  }
  if(input.wire_ids.some(id=>this.row.consumed_files.includes(id)))throw failure('file_not_found');
  const selected=[];for(const id of input.wire_ids.slice(0,input.limit??100))selected.push(project(await this.request('/files/'+encodeURIComponent(id))));
  await this.update(row=>{row.consumed_files=[...new Set([...row.consumed_files,...selected.map(file=>file.id)])];});
  await this.reconcileFiles();
  return {files:selected,remaining:input.wire_ids.length-selected.length};
 }
 async sendFile(input){
  let bytes,filename=input.filename,mime=input.mime??'application/octet-stream';
  if(input.path){const handle=await fs.open(input.path,constants.O_RDONLY);try{const stat=await handle.stat();if(!stat.isFile()||stat.size>2097152)throw failure('file_too_large');const buffer=Buffer.alloc(2097153);let size=0;while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}bytes=buffer.subarray(0,size);filename??=path.basename(input.path);}finally{await handle.close();}}
  else bytes=Buffer.from(input.data_base64,'base64');
  if(bytes.length>2097152)throw failure('file_too_large');
  return this.mutation('/files',{bytes,headers:{'content-type':mime,'x-file-name':encodeURIComponent(filename),...(input.reply_to_wire_id?{'x-reply-to-wire-id':input.reply_to_wire_id}:{}),...(input.reply_to_sentence?{'x-reply-to-sentence':String(input.reply_to_sentence)}:{})}});
 }
}
