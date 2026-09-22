import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const cid=/^[A-F0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const error=code=>Object.assign(new Error(code),{code});
const WIN=process.platform==='win32';
// A one-use invite is guarded by a marker written BEFORE the connection record, so a
// crash can never leave a record with no marker — that ordering is what keeps redemption
// at-most-once and must not be reversed. The opposite residue (marker, no record) means
// the attempt never reached the daemon and is recoverable, but only once the marker is
// old enough that it cannot be a concurrent reserve still between its two adjacent local
// writes. Those writes are sub-millisecond, so this threshold is a very wide margin.
const STALE_ATTEMPT_MS=30_000;
export class ConnectionRegistry {
 constructor(stateDir){if(!path.isAbsolute(stateDir??''))throw error('connection_registry_unavailable');this.stateDir=path.resolve(stateDir);this.root=path.join(this.stateDir,'cowork-agent-connections');}
 async init(){
  // Never follow a symlink in the selected daemon state or registry path.
  let current=path.parse(this.root).root;
  for(const part of this.root.slice(current.length).split(path.sep)){current=path.join(current,part);try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw error('connection_registry_unsafe');}catch(e){if(e.code!=='ENOENT')throw e;if(current!==this.root)throw error('connection_registry_unavailable');await fs.mkdir(current,{mode:0o700});}}
  const stat=await fs.lstat(this.root);if(!WIN&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw error('connection_registry_unsafe');
 }
 file(id){if(!uuid.test(id))throw error('connection_not_found');return path.join(this.root,id+'.json');}
 validate(row){if(!row||row.version!==1||!uuid.test(row.connection_id)||row.state_dir!==this.stateDir||!['personal','moderator'].includes(row.profile)||typeof row.identity_name!=='string'||!['reserved','identity_created','invite_attempted','connected'].includes(row.state)||(row.identity_cid!==undefined&&!cid.test(row.identity_cid))||(row.state==='connected'&&(!cid.test(row.contact_cid)||typeof row.room_name!=='string'||!['ready','connecting'].includes(row.membership_state))))throw error('connection_registry_corrupt');return row;}
 // O_NOFOLLOW is absent from fs.constants on Windows, so `O_RDONLY|O_NOFOLLOW` degrades to a
 // plain read and the symlink rejection it gives on POSIX disappears silently. Re-establish it
 // explicitly. lstat-then-open leaves a narrow TOCTOU window, which is strictly better than the
 // unchecked read it replaces, and on POSIX this only turns a raw ELOOP into the typed code.
 async read(file){const link=await fs.lstat(file);if(link.isSymbolicLink())throw error('connection_registry_unsafe');const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||(!WIN&&(stat.uid!==process.getuid()||(stat.mode&0o077))))throw error('connection_registry_unsafe');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}}
 // Windows has no directory-handle fsync (it raises EPERM), so the write is not ordered against
 // a directory flush there and a power loss can still tear it. There is no portable alternative.
 async write(file,row,exclusive=false){const target=exclusive?file:file+'.'+randomUUID()+'.tmp';const handle=await fs.open(target,'wx',0o600);try{await handle.writeFile(JSON.stringify(row)+'\n');await handle.sync();}finally{await handle.close();}if(!exclusive)await fs.rename(target,file);if(!WIN){const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}}
 attemptFile(invite){return path.join(this.root,'invite-'+createHash('sha256').update(invite).digest('hex')+'.attempt');}
 // Record that this invite is about to be handed to the daemon. From here the marker is positive
 // evidence of a redeem attempt and is never reclaimable, so losing the connection record later
 // (manual cleanup, partial state deletion) can never replay an invite that already reached the
 // daemon. Written through the tmp+rename path so a crash cannot drop the marker entirely.
 async attempted(invite,connection_id){await this.write(this.attemptFile(invite),{connection_id,stage:'attempted'});}
 // Whether an existing attempt marker may be taken over. All three must hold:
 //   - it never reached the 'attempted' stage (so the invite never went to the daemon),
 //   - the connection record it names is absent (the reserve did not complete), and
 //   - it is older than STALE_ATTEMPT_MS (so a concurrent reserve mid-write is never stolen).
 // Markers written before 1.3.2 carry no stage; they are read as 'reserved', which is what makes
 // the residue of the Windows fsync bug recoverable at all. For those legacy markers only, a
 // record deleted by hand after a real redeem could still be replayed — the stage field closes
 // that window for every marker written from this release onward.
 async attemptState(attempt){
  let previous;
  try{previous=await this.read(attempt);}
  catch(e){
   if(e.code==='ENOENT')return {reclaimable:true};
   if(e.code)throw e; // typed registry errors (unsafe permissions) stay fatal
   // no .code means JSON.parse failed: a truncated marker carries no claim at all
  }
  const connection_id=uuid.test(previous?.connection_id??'')?previous.connection_id:undefined;
  if(previous?.stage==='attempted')return {reclaimable:false,connection_id};
  if(connection_id!==undefined){
   try{await fs.access(this.file(connection_id));return {reclaimable:false,connection_id};}
   catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const stat=await fs.stat(attempt).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return {reclaimable:stat===null||Date.now()-stat.mtimeMs>=STALE_ATTEMPT_MS,connection_id};
 }
 async list(profile){await this.init();const rows=[];for(const name of await fs.readdir(this.root))if(uuid.test(name.slice(0,-5))&&name.endsWith('.json')){const row=this.validate(await this.read(path.join(this.root,name)));if(row.profile===profile)rows.push(row);}return rows;}
 async get(id,profile){await this.init();let row;try{row=this.validate(await this.read(this.file(id)));}catch(e){if(e.code==='ENOENT')throw error('connection_not_found');throw e;}if(row.profile!==profile)throw error('connection_not_found');return row;}
 async reserve(profile,invite){await this.init();const connection_id=randomUUID(),row={version:1,connection_id,profile,state_dir:this.stateDir,identity_name:`cowork-${profile}-${connection_id}`,state:'reserved',created_at:new Date().toISOString()};
  const attempt=this.attemptFile(invite);
  try{await this.write(attempt,{connection_id,stage:'reserved'},true);}catch(e){
   if(e.code!=='EEXIST')throw e;
   const {reclaimable,connection_id:previous}=await this.attemptState(attempt);
   if(!reclaimable)throw Object.assign(error('invite_already_attempted'),{connection_id:previous});
   await fs.rm(attempt,{force:true});
   // Two processes can both judge the same marker stale and race to re-create it. The 'wx'
   // create is what makes that safe -- the loser is refused rather than proceeding -- but a
   // raw EEXIST is not a public code and would surface as internal_error.
   try{await this.write(attempt,{connection_id,stage:'reserved'},true);}
   catch(raced){if(raced.code!=='EEXIST')throw raced;throw Object.assign(error('invite_already_attempted'),{connection_id:previous});}
  }
  await this.write(this.file(connection_id),row,true);return row;
 }
 async update(row,patch){const next=this.validate({...row,...patch,updated_at:new Date().toISOString()});await this.write(this.file(row.connection_id),next);return next;}
}
export function connectionView(row){return {connection_id:row.connection_id,profile:row.profile,as_agent:row.identity_name,...(row.identity_cid?{agent_cid:row.identity_cid}:{}),...(row.contact_cid?{room_cid:row.contact_cid,room_name:row.room_name}:{}),connection_state:row.state,identity_lifetime:'persistent'};}
