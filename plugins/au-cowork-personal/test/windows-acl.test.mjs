import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {ConnectionStore} from '../src/central-client.mjs';

const windows={skip:process.platform!=='win32'};
const id='11111111-1111-4111-8111-111111111111';
const row={version:1,connection_id:id,credential:'b'.repeat(43),origin:'https://cowork.example',cursor:0,staged:[],consumed_files:[]};
const ps=(code,args={})=>execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; $data=[Console]::In.ReadToEnd() | ConvertFrom-Json; "+code,'utf16le').toString('base64')],{input:JSON.stringify(args),encoding:'utf8'}).trim();
function grant(target,{rights='ReadAndExecute',inherit='None',propagate='None',sid='S-1-1-0'}={}){
 ps(`$acl=Get-Acl -LiteralPath $data.target; $identity=New-Object Security.Principal.SecurityIdentifier($data.sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]$data.rights,[Security.AccessControl.InheritanceFlags]$data.inherit,[Security.AccessControl.PropagationFlags]$data.propagate,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $data.target -AclObject $acl`,{target,rights,inherit,propagate,sid});
}
async function fixture(run){
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-windows-')),store=new ConnectionStore(path.join(temporary,'state'));
 try{await store.init();await run(store,temporary);}finally{await fs.rm(temporary,{recursive:true,force:true});}
}

test('Windows accepts inherited read/write ACLs and never rewrites existing ACLs',windows,async()=>{
 await fixture(async(store,temporary)=>{
  grant(store.root,{rights:'FullControl',inherit:'ObjectInherit, ContainerInherit'});
  const acl=()=>ps(`(Get-Acl -LiteralPath $data.target).Sddl`,{target:store.root});
  const before=acl();await store.save(row);assert.deepEqual(await store.load(id),row);
  grant(store.file(id),{rights:'ReadAndExecute'});
  await store.save({...row,cursor:1});assert.equal((await store.load(id)).cursor,1);
  await store.acquire(id);grant(store.file(id)+'.lease',{rights:'ReadAndExecute'});
  await assert.rejects(()=>new ConnectionStore(store.root).acquire(id),{code:'connection_in_use'});
  await store.release(id);assert.equal(acl(),before);
  const linked=path.join(temporary,'linked');await fs.symlink(store.root,linked,'junction');
  await assert.rejects(()=>new ConnectionStore(path.join(linked,'nested')).init(),{code:'unsafe_state_directory'});
  assert.equal(await fs.stat(path.join(store.root,'nested')).then(()=>true,()=>false),false);
 });
});

test('Windows rejects a junction occupying the credential-file path',windows,async()=>{
 await fixture(async(store,temporary)=>{
  const target=path.join(temporary,'target');await fs.mkdir(target);
  await fs.symlink(target,store.file(id),'junction');
  await assert.rejects(()=>store.load(id),{code:'unsafe_connection_state'});
  await assert.rejects(()=>store.save(row),{code:'unsafe_connection_state'});
  assert.deepEqual(await fs.readdir(target),[]);
 });
});
