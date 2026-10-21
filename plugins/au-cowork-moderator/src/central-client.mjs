import {NAME,VERSION} from './version.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {constants,lstatSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

export function stateDirectoryHelp({platform=process.platform}={}) {
 const cause='State requires an absolute directory path without symlinks or junctions in its components. Preserve existing state, repair the path, then disconnect and reconnect your connection_id. Do not change permissions.';
 const windows=' On Windows: ask your human to close the connector, open PowerShell, run $env:AC_COWORK_HOME = "$env:LOCALAPPDATA\\au-cowork-central", then launch the host from that same window. If still rejected, ask them to choose a private folder outside the Codex sandbox and set AC_COWORK_HOME to its absolute path. Keep existing permissions and old connection files.';
 return cause+(platform==='win32'?windows:'')+' Saved connections in the old folders are not listed while AC_COWORK_HOME points elsewhere.';
}
export const failure=(code,details={},options={})=>Object.assign(new Error(code==='unsafe_state_directory'?stateDirectoryHelp(options):code),{code,...details});
export function stateDirectories({platform=process.platform,env=process.env,home=homedir()}={}) {
 const paths=platform==='win32'?path.win32:path;
 if(env.AC_COWORK_HOME!==undefined) {
  if(!paths.isAbsolute(env.AC_COWORK_HOME))throw failure('unsafe_state_directory',{},{platform});
  return {root:env.AC_COWORK_HOME,legacy:[]};
 }
 return platform==='win32'
  ? {root:paths.join(env.LOCALAPPDATA||paths.join(home,'AppData','Local'),'au-cowork-central'),legacy:[paths.join(home,'.au-cowork-central'),paths.join(home,'.local','share','au-cowork-central')]}
  : {root:paths.join(home,'.local','share','au-cowork-central'),legacy:[]};
}
function cancelBestEffort(stream){try{void stream?.cancel().catch(()=>{});}catch{}}
const transientStatus=status=>[408,425,429].includes(status)||(status>=500&&status<=599&&![501,505].includes(status));
export function retryAfterMillis(value,now=Date.now()){
 if(typeof value!=='string'||!value.trim())return 0;
 const text=value.trim();let ms;
 if(/^\d+$/.test(text))ms=Number(text)*1000;
 else if(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text))ms=Date.parse(text)-now;
 else return 0;
 return Number.isFinite(ms)?Math.min(60000,Math.max(0,ms)):0;
}
function responseFacts(route,response){
 const parts=String(route).split('?')[0].split('/').filter(Boolean);
 const known=['events','session','ack','credentials','messages','commands','files','exchange'].includes(parts[0]);
 const endpoint=!known?'/unknown':parts[0]==='credentials'?'/credentials/rotate':'/'+parts[0]+(parts.length>1?'/:id':'');
 const mime=response?.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
 return {endpoint,http_status:response?.status??null,content_type:['application/json','application/problem+json','text/html','text/plain','application/octet-stream','application/xml','text/xml'].includes(mime)?mime:null};
}
const requestDiagnostic=(route,response,reason)=>({...responseFacts(route,response),reason,timestamp:new Date().toISOString()});
const uuid=/^[a-f0-9-]{36}$/;
const secret=/^[A-Za-z0-9_-]{43}$/;
export function centralOrigin(value){
 let url;try{url=new URL(value);}catch{throw failure('central_configuration_required');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw failure('invalid_central_url');
 return url.origin;
}
export function invitation(value,configured){
 const invalid=()=>Object.assign(failure('invalid_invitation'),{input_format:true});
 if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f]/.test(value))throw invalid();
 let url;try{url=new URL(value);}catch{throw invalid();}
 if(url.protocol!=='https:'||url.username||url.password||url.search||(configured&&url.origin!==centralOrigin(configured)))throw invalid();
 const canonical=url.pathname==='/'&&url.hash.match(/^#\/agent-invite\/([A-Za-z0-9_-]{43})$/);
 if(canonical)return {origin:url.origin,token:canonical[1]};
 if(url.pathname!=='/agent-instructions')throw invalid();
 const fields=new URLSearchParams(url.hash.slice(1));
 if([...fields.keys()].some(key=>!['token','invite','name'].includes(key))||['token','invite','name'].some(key=>fields.getAll(key).length>1)||fields.has('token')===fields.has('invite'))throw invalid();
 let token=fields.get('token');
 if(fields.has('invite')){
  // ponytail: validate one historical nested canonical URL; never fetch or recurse.
  if(/[\u0000-\u0020\u007f]/.test(fields.get('invite')))throw invalid();
  let original;try{original=new URL(fields.get('invite'));}catch{throw invalid();}
  const match=original.hash.match(/^#\/agent-invite\/([A-Za-z0-9_-]{43})$/);
  if(original.origin!==url.origin||original.username||original.password||original.pathname!=='/'||original.search||!match)throw invalid();
  token=match[1];
 }
 if(!secret.test(token??''))throw invalid();
 return {origin:url.origin,token};
}
/** Current room status and, while Done, the room closure instruction from the central session. */
export function roomDiscussion(room){
 if(!room||typeof room.status!=='string'||!['open','closed'].includes(room.discussion))return {};
 return {room_status:room.status,discussion:room.discussion,...(typeof room.instruction==='string'?{instruction:room.instruction}:{})};
}
const isHeartbeat=event=>event.kind==='roomHeartbeatNotice';
export class ConnectionStore {
 constructor(root, {legacyRoots}={}){
  const defaults=root===undefined?stateDirectories():{root,legacy:[]};
  if(!path.isAbsolute(defaults.root))throw failure('unsafe_state_directory');
  this.root=defaults.root;this.leases=new Map();this.legacy=(legacyRoots??defaults.legacy).map(value=>new ConnectionStore(value));this.locations=new Map();
 }
 // Keep legacy records and their leases together: no copy, ACL change or new identity.
 async location(id){
  if(this.locations.has(id))return this.locations.get(id);
  const stores=[];
  for(const store of [this,...this.legacy]){
   if(store!==this){try{await fs.lstat(store.root);}catch(error){if(error.code==='ENOENT')continue;throw error;}await store.init();}
   try{await store.regularFile(store.file(id),'unsafe_connection_state');stores.push(store);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(stores.length>1)throw failure('connection_copy_conflict');
  const selected=stores[0]??this;this.locations.set(id,selected);return selected;
 }
 async init(){
  // Isolation and access permissions are managed by the operator.
  // Validate existing components before mkdir so a link cannot redirect creation.
  const check=async()=>{
   let ancestor=path.parse(this.root).root;
   for(const segment of this.root.slice(ancestor.length).split(path.sep).filter(Boolean)){
    ancestor=path.join(ancestor,segment);let info;
    try{info=await fs.lstat(ancestor);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())throw failure('unsafe_state_directory');
   }
  };
  await check();
  // Validate legacy roots during preflight, before an invitation can be exchanged.
  // A later acquire/load must never discover a known unsafe legacy path after admission.
  for(const store of this.legacy){
   try{await fs.lstat(store.root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   await store.init();
  }
  await fs.mkdir(this.root,{recursive:true,mode:0o700});await check();
 }
 async regularFile(filename,code){const info=await fs.lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw failure(code);}
 file(id){if(!uuid.test(id))throw failure('connection_not_found');return path.join(this.root,id+'.json');}
 async load(id){
  await this.init();const store=await this.location(id);if(store!==this)return store.load(id);let handle;
  try{
   await this.regularFile(this.file(id),'unsafe_connection_state');
   handle=await fs.open(this.file(id),constants.O_RDONLY|constants.O_NOFOLLOW);
   const info=await handle.stat();if(!info.isFile()||info.size>8*1024*1024)throw failure('unsafe_connection_state');
   const row=JSON.parse(await handle.readFile('utf8'));
   if(row.version!==1||row.connection_id!==id||!secret.test(row.credential)||!Array.isArray(row.staged)||!Number.isSafeInteger(row.cursor)||row.cursor<0||!Array.isArray(row.consumed_files)||(row.watch_enabled!==undefined&&typeof row.watch_enabled!=='boolean'))throw failure('invalid_connection_state');
   centralOrigin(row.origin);return row;
  }catch(error){if(error.code==='ENOENT')throw failure('connection_not_found');throw error;}finally{await handle?.close();}
 }
 async save(row){
  await this.init();const store=await this.location(row.connection_id);if(store!==this)return store.save(row);const target=this.file(row.connection_id),temporary=target+'.'+randomUUID()+'.tmp';
  // Validate an existing record before replacing it.
  try{await this.load(row.connection_id);}catch(error){if(error.code!=='connection_not_found')throw error;}
  const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(JSON.stringify(row));await handle.sync();}catch(error){await handle.close();await fs.unlink(temporary).catch(()=>{});throw error;}finally{await handle.close();}
  try{await fs.rename(temporary,target);if(process.platform!=='win32'){const directory=await fs.open(this.root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}}
  catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
 }
 async list(){
  await this.init();const ids=new Set();
  for(const store of [this,...this.legacy]){
   try{await fs.lstat(store.root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   await store.init();for(const name of await fs.readdir(store.root))if(name.endsWith('.json')&&uuid.test(name.slice(0,-5)))ids.add(name.slice(0,-5));
  }
  const rows=[];for(const id of ids)rows.push(await this.load(id));return rows;
 }
 async acquire(id){
  await this.init();const store=await this.location(id);if(store!==this)return store.acquire(id);const filename=this.file(id)+'.lease',lease={pid:process.pid,nonce:randomUUID()};
  let handle;
  try{handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   const recovery=filename+'.recovery';
   try{await fs.mkdir(recovery,{mode:0o700});}catch{throw failure('connection_in_use');}
   try{
    let previous,reader;
    try{await this.regularFile(filename,'connection_in_use');reader=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await reader.stat();if(!info.isFile()||info.size>1024)throw failure('connection_in_use');previous=JSON.parse(await reader.readFile('utf8'));}catch{throw failure('connection_in_use');}finally{await reader?.close();}
    if(!Number.isInteger(previous.pid)||previous.pid<1)throw failure('connection_in_use');
    try{process.kill(previous.pid,0);throw failure('connection_in_use');}catch(cause){if(cause.code!=='ESRCH')throw failure('connection_in_use');}
    await fs.unlink(filename);
    // A fresh contender can create the lease while the stale lease is absent.
    // Exclusive creation still selects one winner; preserve its lease on conflict.
    try{handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
    catch(cause){if(cause.code==='EEXIST')throw failure('connection_in_use');throw cause;}
   }finally{await fs.rmdir(recovery);}
  }
  try{await handle.writeFile(JSON.stringify(lease));await handle.sync();}catch(error){await handle.close();await fs.unlink(filename).catch(()=>{});throw error;}finally{await handle.close();}
  this.leases.set(id,lease.nonce);
 }
 async release(id){
  const store=await this.location(id);if(store!==this)return store.release(id);const nonce=this.leases.get(id);if(!nonce)return;
  const filename=this.file(id)+'.lease';
  await this.init();await this.regularFile(filename,'connection_lease_changed');
  const reader=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let lease;
  try{const info=await reader.stat();if(!info.isFile()||info.size>1024)throw failure('connection_lease_changed');lease=JSON.parse(await reader.readFile('utf8'));}finally{await reader.close();}
  if(lease.nonce!==nonce)throw failure('connection_lease_changed');
  await fs.unlink(filename);this.leases.delete(id);
 }
}

export class CentralClient {
 constructor({fetchFn=fetch,store=new ConnectionStore(),origin=process.env.AC_COWORK_URL,onEvent=()=>{},retryDelayFn=delay}={}){
  const incompatible=['OURS_PORT','OURS_STATE_DIR','OURS_CONFIG','OURS_URL','OURS_TOKEN','OURS_TOKEN_FILE','AU_OURS_URL','AU_OURS_API_TOKEN','AU_OURS_CONFIG','AC_REMOTE_OURS_URL','AC_REMOTE_OURS_TOKEN_FILE','AC_MODERATOR_INPUTS_MODULE'].some(key=>process.env[key]);
  if(incompatible)throw failure('legacy_configuration_rejected');
  try{lstatSync(path.resolve('.au-ours.json'));throw failure('legacy_configuration_rejected');}catch(error){if(error.code!=='ENOENT')throw error;}
  this.monitorFailures=0;this.malformedFailures=0;this.nextRetryMs=0;this.lastSuccessAt=null;this.monitorDiagnostic=null;this.eventResponseFacts=null;
  this.retryDelayFn=retryDelayFn;this.restoreError=null;this.fetchFn=fetchFn;this.store=store;this.origin=origin?centralOrigin(origin):undefined;this.onEvent=onEvent;this.row=null;this.monitor=null;this.work=null;this.listeners=new Set();this.stateQueue=Promise.resolve();this.monitorState='disconnected';this.transition=null;this.disconnecting=null;
  this.inflight=0;this.held=[];this.heartbeatOnly=false;
 }
 assertHealthy(){if(this.row&&this.monitor&&!['running','reconnecting','backpressure','invalid_central_response','response_too_large','central_http_error'].includes(this.monitorState))throw failure(this.monitorState);}
 monitorHealth(){return {state:this.monitorState,live:this.monitorState==='running',pending_events:this.row?.staged.length??0,consecutive_failures:this.monitorFailures,malformed_failures:this.malformedFailures,next_retry_ms:this.nextRetryMs,last_success_at:this.lastSuccessAt,diagnostic:this.monitorDiagnostic};}
 pollFailure(reason){return failure('invalid_central_response',{diagnostic:{...(this.eventResponseFacts??responseFacts('/events')),reason,timestamp:new Date().toISOString()}});}
 async request(route,{method='GET',body,bytes,headers={},signal,origin=this.row?.origin??this.origin,credential=this.row?.credential,raw=false}={}){
  this.assertHealthy();if(!origin)throw failure('central_configuration_required');centralOrigin(origin);
  const timeout=AbortSignal.timeout(route.startsWith('/events')?35000:30000),combined=signal?AbortSignal.any([timeout,signal]):timeout;
  let response;
  const fail=(code,reason,details={})=>failure(code,{diagnostic:requestDiagnostic(route,response,reason),...details});
  try{response=await this.fetchFn(origin+'/api/v1/agent'+route,{method,redirect:'error',signal:combined,headers:{'X-Cowork-Connector':NAME+'/'+VERSION,...(credential?{authorization:'Bearer '+credential}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:bytes!==undefined?{body:bytes}:{})});}
  catch(error){if(signal?.aborted)throw fail('cancelled','cancelled');throw fail('central_unavailable','network_error');}
  if(route.startsWith('/events'))this.eventResponseFacts=responseFacts(route,response);
  if(signal?.aborted){cancelBestEffort(response.body);throw fail('cancelled','cancelled');}
  // Classify upstream status before requiring any successful JSON envelope.
  // Never retry a mutation here: callers retain its unresolved idempotency key.
  if(!response.ok&&transientStatus(response.status)){
   cancelBestEffort(response.body);
   throw fail(response.status===429?'rate_limited':'central_unavailable','http_transient',{retry_after_ms:retryAfterMillis(response.headers.get('retry-after'))});
  }
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(reader)try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4*1024*1024){cancelBestEffort(reader);throw fail('response_too_large','response_too_large');}chunks.push(item.value);}}
  catch(error){if(signal?.aborted)throw fail('cancelled','cancelled');if([401,403].includes(response.status))throw fail(response.status===401?'unauthenticated':'forbidden','http_auth');if(error.code==='response_too_large')throw error;throw fail('central_unavailable','body_transport');}
  finally{reader.releaseLock();}
  const buffer=Buffer.concat(chunks);
  if(raw&&response.ok)return {bytes:buffer,headers:response.headers};
  let payload;try{payload=JSON.parse(buffer.toString('utf8'));}catch{
   if(!response.ok)throw fail(response.status===401?'unauthenticated':response.status===403?'forbidden':'central_http_error',[401,403].includes(response.status)?'http_auth':'http_error');
   throw fail('invalid_central_response','invalid_json');
  }
  if(!response.ok){let code=typeof payload?.error?.code==='string'&&/^[a-z_]{1,64}$/.test(payload.error.code)?payload.error.code:response.status===401?'unauthenticated':response.status===403?'forbidden':'central_http_error';
   if([401,403].includes(response.status)&&['central_unavailable','database_busy','rate_limited','invalid_central_response','response_too_large','central_http_error'].includes(code))code=response.status===401?'unauthenticated':'forbidden';
   throw fail(code,[401,403].includes(response.status)?'http_auth':'json_error',{retry_after_ms:retryAfterMillis(response.headers.get('retry-after'))});}
  if(payload===null||typeof payload!=='object'||Array.isArray(payload)||!Object.hasOwn(payload,'data'))throw fail('invalid_central_response','missing_data');return payload.data;
 }
 async update(change){
  const work=this.stateQueue.then(async()=>{if(!this.row)throw failure('not_connected');const next=structuredClone(this.row);change(next);await this.store.save(next);this.row=next;});
  this.stateQueue=work.catch(()=>{});return work;
 }
 publicRow(row=this.row){return row?{connection_id:row.connection_id,room_name:row.room_name,room_id:row.room_id,as_agent:row.display_name,status:row.connection_id===this.row?.connection_id?'connected':'disconnected',membership_state:'ready',bind_state:row.connection_id===this.row?.connection_id?'bound_here':'unbound'}:null;}
 async restore({connection_id=process.env.AC_COWORK_CONNECTION_ID}={}){
  // Never adopt an arbitrary saved identity, or replay an invitation exchange.
  const watched=(await this.store.list()).filter(row=>row.watch_enabled===true);
  const selected=connection_id?watched.find(row=>row.connection_id===connection_id):watched.length===1?watched[0]:null;
  if(connection_id&&!selected)throw failure('connection_not_watched');
  if(!connection_id&&watched.length>1)throw failure('connection_selection_required');
  if(!selected)return null;
  return this.connect({connection_id:selected.connection_id,restoring:true});
 }
 async connect(input){
  if(this.row||this.transition||this.disconnecting)throw failure('session_already_bound');
  const work=this.bind(input);this.transition=work;
  try{return await work;}finally{if(this.transition===work)this.transition=null;}
 }
 async bind({invite,connection_id,room_name,as_agent,restoring=false}){
  if([invite,connection_id,room_name].filter(Boolean).length!==1)throw failure('invalid_request');
  await this.store.init();
  let session;
  if(invite){
   const parsed=invitation(invite,this.origin);let accepted;
   try{accepted=await this.request('/exchange',{method:'POST',body:{token:parsed.token,display_name:as_agent??'Cowork agent'},origin:parsed.origin,credential:undefined});}
   catch(error){if(!['invalid_invitation','expired','invalid_request','forbidden'].includes(error.code))error.exchange_uncertain=true;throw error;}
   if(!accepted||!secret.test(accepted.credential)||typeof accepted.room_id!=='string'||typeof accepted.agent_id!=='string')throw failure('invalid_central_response',{exchange_uncertain:true});
   const row={version:1,connection_id:randomUUID(),origin:parsed.origin,...accepted,cursor:0,staged:[],consumed_files:[],watch_enabled:true};
   let acquired=false;
   try{await this.store.acquire(row.connection_id);acquired=true;await this.store.save(row);this.row=row;}
   catch(error){if(acquired)await this.store.release(row.connection_id).catch(()=>{});throw failure('credential_storage_failed',{exchange_uncertain:true});}
   // Admission and credential persistence already succeeded; session is informative only.
   session=await this.request('/session').catch(()=>undefined);
  }else{
   if(room_name){const rows=(await this.store.list()).filter(row=>row.room_name===room_name);if(rows.length!==1)throw failure(rows.length?'connection_selection_required':'connection_not_found');connection_id=rows[0].connection_id;}
   await this.store.acquire(connection_id);
   try{const row=await this.store.load(connection_id);if(row.rotation_pending)throw failure('credential_rotation_uncertain');if(this.origin&&row.origin!==this.origin)throw failure('central_origin_mismatch');if(!restoring)session=await this.request('/session',{origin:row.origin,credential:row.credential});if(row.watch_enabled!==true){row.watch_enabled=true;await this.store.save(row);}this.row=row;}catch(error){await this.store.release(connection_id);throw error;}
  }
  const pendingHeartbeats=new Set(this.row.staged.filter(isHeartbeat).map(event=>event.event_id));
  this.restoreError=null;this.startMonitor(pendingHeartbeats);
  // Share pending hints with catch-up so either path may notify, but never both.
  const current=await this.pruneHeartbeats(session);
  for(const event of this.row.staged)if(!isHeartbeat(event)||(current&&pendingHeartbeats.delete(event.event_id)))this.wake(event);
  return {...this.publicRow(),...roomDiscussion(session?.room),monitoring_instructions:'Watching is durable across process restarts with the same state directory. Read ac_messages and ac_files; wait_for_room_event does not consume mail. Explicit disconnect stops watching.'};
 }
 async disconnect({preserveWatch=false}={}){
  if(this.disconnecting)return this.disconnecting;
  const work=(async()=>{
   // A shutdown during invitation exchange must also release the new lease.
   await this.transition?.catch(()=>{});
   this.monitor?.abort();this.monitorState='disconnecting';await this.work;await this.stateQueue;
   if(this.row){
     if(!preserveWatch)await this.update(row=>{row.watch_enabled=false;});
     await this.store.release(this.row.connection_id);
    }
   this.row=null;this.monitor=null;this.monitorState='disconnected';this.nextRetryMs=0;
   for(const listener of this.listeners)listener({status:'disconnected'});
  })();
  this.disconnecting=work;
  try{await work;}catch(error){this.stopMonitoring(error.code);throw error;}finally{this.disconnecting=null;}
 }
 notify(value){
  // A host notification is a hint, not consumption. Host failures must not stop
  // durable polling or get misclassified as storage/security failures.
  try{Promise.resolve(this.onEvent(value)).catch(()=>{});}catch{}
  for(const listener of this.listeners){try{listener(value);}catch{}}
 }
 /**
  * Room hints that carry no news do not wake the host; the events stay staged and readable.
  * Own command echoes are skipped, and a heartbeat right after a heartbeat-only wake is skipped.
  * Hints arriving while a mutation is in flight wait for it, so its command_id is known first.
  */
 wake(event){
  if(this.inflight){this.held.push(event);return;}
  if(event.resource?.kind==='command'&&this.row?.own_commands?.includes(event.resource.id))return;
  if(isHeartbeat(event)&&this.heartbeatOnly)return;
  this.heartbeatOnly=isHeartbeat(event);
  this.notify({status:'event',event:{event_id:event.event_id,kind:event.kind,resource:event.resource,seq:event.seq}});}
 stopMonitoring(reason){
  if(['running','reconnecting','backpressure','disconnected'].includes(reason))reason='central_http_error';
  const code=/^[a-z_]{1,64}$/.test(reason??'')?reason:'state_storage_failed';
  this.monitorState=code;this.nextRetryMs=0;const event={status:'unavailable',code};
  this.notify(event);
 }
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
 startMonitor(pendingHeartbeats=new Set(this.row.staged.filter(isHeartbeat).map(event=>event.event_id))){
  const connection=this.row.connection_id;
  this.monitor=new AbortController();const signal=this.monitor.signal;this.monitorState='running';this.monitorFailures=0;this.malformedFailures=0;this.nextRetryMs=0;this.lastSuccessAt=null;this.monitorDiagnostic=null;
  this.work=(async()=>{
   while(!signal.aborted&&this.row){
    try{
     await this.renewCredential();
     await this.reconcileFiles();
     if(this.row.staged.length>=5000){this.monitorState='backpressure';await delay(1000,undefined,{signal});continue;}
     const page=await this.request('/events?after='+this.row.cursor+'&limit=100&wait_ms=25000',{signal});
     if(!page||typeof page!=='object'||!Array.isArray(page.events))throw this.pollFailure('invalid_event_page');
     if(!Number.isSafeInteger(page.cursor)||page.cursor<this.row.cursor)throw this.pollFailure('invalid_cursor');
     const fresh=[];
     await this.update(row=>{
      const known=new Map(row.staged.map(event=>[event.event_id,event.seq]));let previous=row.cursor;
      for(const event of page.events){
       if(!event||typeof event.event_id!=='string'||!event.resource||typeof event.resource.kind!=='string'||typeof event.resource.id!=='string')throw this.pollFailure('invalid_event_sequence');
       if(!Number.isSafeInteger(event.seq)||event.seq<=0||event.seq>page.cursor||event.seq<previous||(event.seq===previous&&known.get(event.event_id)!==event.seq)||(known.has(event.event_id)&&known.get(event.event_id)!==event.seq))throw this.pollFailure('invalid_event_sequence');
       previous=event.seq;if(!known.has(event.event_id)){row.staged.push(event);fresh.push(event);known.set(event.event_id,event.seq);}
      }
      row.cursor=page.cursor;
     });
     await this.reconcileFiles();
     this.monitorFailures=0;this.malformedFailures=0;this.nextRetryMs=0;this.lastSuccessAt=new Date().toISOString();this.monitorState='running';
     // Status, policy or discussion may have changed while staging and reconciling files.
     for(const event of fresh)if(isHeartbeat(event))pendingHeartbeats.add(event.event_id);
     for(const id of pendingHeartbeats)if(!this.row.staged.some(event=>event.event_id===id))pendingHeartbeats.delete(id);
     // Retry a suppressed hint on the next successful long poll, even an empty page.
     const current=pendingHeartbeats.size?await this.pruneHeartbeats():false;
     if(signal.aborted||this.monitor?.signal!==signal||this.row?.connection_id!==connection)break;
     for(const event of fresh)if(!isHeartbeat(event)&&this.row.staged.some(staged=>staged.event_id===event.event_id))this.wake(event);
     if(current)for(const event of this.row?.staged??[]){
      if(signal.aborted||this.monitor?.signal!==signal||this.row?.connection_id!==connection)break;
      if(isHeartbeat(event)&&pendingHeartbeats.delete(event.event_id))this.wake(event);
     }
    }catch(error){
     if(signal.aborted)break;
     this.monitorDiagnostic=error.diagnostic??{endpoint:'/monitor',http_status:null,content_type:null,reason:/^[a-z_]{1,64}$/.test(error.code??'')?error.code:'state_storage_failed',timestamp:new Date().toISOString()};
     this.monitorFailures=Math.min(Number.MAX_SAFE_INTEGER,this.monitorFailures+1);
     // A malformed successful response, or a non-auth error status whose body is
     // not JSON (a proxy, captive or maintenance page rather than the application),
     // retries indefinitely with backoff up to 5 minutes while health reports not
     // live. Cursor integrity, authorization, rotation, local storage failures and
     // JSON application error codes still stop the watch.
     const malformed=(error.code==='invalid_central_response'&&['invalid_json','missing_data','invalid_event_page'].includes(error.diagnostic?.reason))||(error.code==='central_http_error'&&error.diagnostic?.reason==='http_error');
     if(malformed)this.malformedFailures=Math.min(Number.MAX_SAFE_INTEGER,this.malformedFailures+1);
     if(error.diagnostic?.reason==='http_auth'){this.stopMonitoring(error.diagnostic.http_status===401?'unauthenticated':'forbidden');break;}
     const transient=['central_unavailable','database_busy','rate_limited'].includes(error.code);
     if(!transient&&!malformed){this.stopMonitoring(error.code);break;}
     if(this.monitorState!=='reconnecting')this.notify({status:'reconnecting',code:error.code});
     const cap=malformed?300000:30000;
     this.monitorState='reconnecting';const backoff=Math.min(cap,500*2**Math.min(this.monitorFailures-1,10));
     this.nextRetryMs=Math.max(Math.min(cap,Math.floor(backoff*(0.75+Math.random()*0.5))),Math.min(60000,Math.max(0,error.retry_after_ms??0)));
     try{await this.retryDelayFn(this.nextRetryMs,undefined,{signal});}catch{break;}
    }
   }
  })();
 }
 async wait(timeout,signal){const result=await this.waitResult(timeout,signal);return {...result,monitor:this.monitorHealth()};}
 async waitResult(timeout,signal){
  if(!this.row)return this.restoreError?{status:'unavailable',code:this.restoreError.code??'state_storage_failed'}:{status:'disconnected'};
  const current=await this.pruneHeartbeats();
  const next=this.row?.staged.find(event=>current||!isHeartbeat(event));
  if(next)return {status:'event',event:{event_id:next.event_id,kind:next.kind,resource:next.resource}};
  if(!['running','reconnecting','backpressure'].includes(this.monitorState))return {status:'unavailable',code:this.monitorState};
  if(signal?.aborted)return {status:'cancelled'};
  return new Promise(resolve=>{let timer;const done=value=>{clearTimeout(timer);this.listeners.delete(done);signal?.removeEventListener('abort',cancel);resolve(value);};const cancel=()=>done({status:'cancelled'});this.listeners.add(done);timer=setTimeout(()=>done({status:'timeout'}),timeout);signal?.addEventListener('abort',cancel,{once:true});});
 }
 /**
  * Heartbeat mail is time-sensitive: only the room's current heartbeat (by message ID) may wake the host
  * or be reported. Superseded heartbeats are acknowledged; their room messages stay readable history.
  * Returns false when currency could not be checked; callers then keep heartbeat mail staged but silent.
  */
 async pruneHeartbeats(session){
  if(!this.row?.staged.some(isHeartbeat))return true;
  try{
   session??=await this.request('/session');
   const current=session?.room?.heartbeat?.current_id??null;
   // The central acknowledgement accepts at most 100 event IDs per request.
   const stale=this.row.staged.filter(event=>isHeartbeat(event)&&event.resource.id!==current);
   for(let offset=0;offset<stale.length;offset+=100)await this.acknowledge(stale.slice(offset,offset+100));
   return true;
  }catch{return false;}
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
  this.inflight++;
  try{
   const value=await this.request(route,{method:'POST',...(body?{body:{...body,idempotency_key:key}}:{bytes,headers:{...headers,'idempotency-key':key}})});
   // ponytail: the last 200 own command IDs suppress their echo wakes; older echoes simply wake.
   await this.update(row=>{delete row.pending_operations[fingerprint];if(typeof value?.command_id==='string')row.own_commands=[...(row.own_commands??[]),value.command_id].slice(-200);});return value;
  }catch(error){
   if(['invalid_request','forbidden','not_found','idempotency_conflict','sentence_reply_unsupported','file_reply_unsupported','file_too_large'].includes(error.code))await this.update(row=>{delete row.pending_operations[fingerprint];});
   error.operation_id=key;throw error;
  }finally{if(!--this.inflight)for(const event of this.held.splice(0))this.wake(event);}
 }
 async messages(input={}){
  if(!this.row)throw failure('not_connected');
  const current=await this.pruneHeartbeats();
  const selected=this.row.staged.filter(event=>event.resource.kind!=='attachment'&&(current||!isHeartbeat(event))&&(!event.retry_after||event.retry_after<=Date.now())&&(!input.wire_ids||input.wire_ids.includes(event.resource.id)||input.wire_ids.includes(event.event_id))).slice(0,input.limit??50);
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
