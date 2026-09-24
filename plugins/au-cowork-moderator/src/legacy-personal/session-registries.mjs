import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Remote daemon state is not a client filesystem path. Keep durable connection
// records on this client, scoped to the selected endpoint and independent of cwd.
async function remoteStateDir(key,home){
 const base=path.join(home,'.au-cowork-remotes');
 const target=path.join(base,createHash('sha256').update(key).digest('hex'));
 let current=path.parse(target).root;
 for(const part of target.slice(current.length).split(path.sep)){
  current=path.join(current,part);
  let stat;
  try{stat=await fs.lstat(current);}catch(error){
   if(error.code!=='ENOENT'||!(current===base||current===target))throw error;
   await fs.mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});stat=await fs.lstat(current);
  }
  if(stat.isSymbolicLink()||!stat.isDirectory()||((current===base||current===target)&&process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077))))throw Object.assign(new Error('connection_registry_unsafe'),{code:'connection_registry_unsafe'});
 }
 return target;
}
export function sessionRegistry(session,Registry,methods,{home=os.homedir()}={}){
 let registry,key;
 return Object.fromEntries(methods.map(method=>[method,async(...args)=>{
  const selected=session.selection,next=selected.registryKey??selected.expectStateDir;
  if(!registry||key!==next){
   const stateDir=selected.registryKey?.startsWith('remote:')?await remoteStateDir(next,home):selected.expectStateDir;
   registry=new Registry(stateDir);key=next;
  }
  return registry[method](...args);
 }]));
}
