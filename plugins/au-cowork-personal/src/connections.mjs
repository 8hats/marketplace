import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const cid=/^[A-F0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const error=code=>Object.assign(new Error(code),{code});
export class ConnectionRegistry {
 constructor(stateDir){if(!path.isAbsolute(stateDir??''))throw error('connection_registry_unavailable');this.stateDir=path.resolve(stateDir);this.root=path.join(this.stateDir,'cowork-agent-connections');}
 async init(){
  // Never follow a symlink in the selected daemon state or registry path.
  let current=path.parse(this.root).root;
  for(const part of this.root.slice(current.length).split(path.sep)){current=path.join(current,part);try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw error('connection_registry_unsafe');}catch(e){if(e.code!=='ENOENT')throw e;if(current!==this.root)throw error('connection_registry_unavailable');await fs.mkdir(current,{mode:0o700});}}
  const stat=await fs.lstat(this.root);if(stat.uid!==process.getuid()||(stat.mode&0o077))throw error('connection_registry_unsafe');
 }
 file(id){if(!uuid.test(id))throw error('connection_not_found');return path.join(this.root,id+'.json');}
 validate(row){if(!row||row.version!==1||!uuid.test(row.connection_id)||row.state_dir!==this.stateDir||!['personal','moderator'].includes(row.profile)||typeof row.identity_name!=='string'||!['reserved','identity_created','invite_attempted','connected'].includes(row.state)||(row.identity_cid!==undefined&&!cid.test(row.identity_cid))||(row.state==='connected'&&(!cid.test(row.contact_cid)||typeof row.room_name!=='string'||!['ready','connecting'].includes(row.membership_state))))throw error('connection_registry_corrupt');return row;}
 async read(file){const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077))throw error('connection_registry_unsafe');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}}
 async write(file,row,exclusive=false){const target=exclusive?file:file+'.'+randomUUID()+'.tmp';const handle=await fs.open(target,'wx',0o600);try{await handle.writeFile(JSON.stringify(row)+'\n');await handle.sync();}finally{await handle.close();}if(!exclusive)await fs.rename(target,file);const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}
 async list(profile){await this.init();const rows=[];for(const name of await fs.readdir(this.root))if(uuid.test(name.slice(0,-5))&&name.endsWith('.json')){const row=this.validate(await this.read(path.join(this.root,name)));if(row.profile===profile)rows.push(row);}return rows;}
 async get(id,profile){await this.init();let row;try{row=this.validate(await this.read(this.file(id)));}catch(e){if(e.code==='ENOENT')throw error('connection_not_found');throw e;}if(row.profile!==profile)throw error('connection_not_found');return row;}
 async reserve(profile,invite){await this.init();const connection_id=randomUUID(),row={version:1,connection_id,profile,state_dir:this.stateDir,identity_name:`cowork-${profile}-${connection_id}`,state:'reserved',created_at:new Date().toISOString()};
  const attempt=path.join(this.root,'invite-'+createHash('sha256').update(invite).digest('hex')+'.attempt');
  try{await this.write(attempt,{connection_id},true);}catch(e){if(e.code==='EEXIST'){const previous=await this.read(attempt);throw Object.assign(error('invite_already_attempted'),{connection_id:previous.connection_id});}throw e;}
  await this.write(this.file(connection_id),row,true);return row;
 }
 async update(row,patch){const next=this.validate({...row,...patch,updated_at:new Date().toISOString()});await this.write(this.file(row.connection_id),next);return next;}
}
export function connectionView(row){return {connection_id:row.connection_id,profile:row.profile,as_agent:row.identity_name,...(row.identity_cid?{agent_cid:row.identity_cid}:{}),...(row.contact_cid?{room_cid:row.contact_cid,room_name:row.room_name}:{}),connection_state:row.state,identity_lifetime:'persistent'};}
