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
function remove(target,sid='S-1-1-0'){
 ps(`$acl=Get-Acl -LiteralPath $data.target; $identity=New-Object Security.Principal.SecurityIdentifier($data.sid); $acl.PurgeAccessRules($identity); Set-Acl -LiteralPath $data.target -AclObject $acl`,{target,sid});
}
async function fixture(run){
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-windows-')),store=new ConnectionStore(path.join(temporary,'state'));
 try{await store.init();await run(store,temporary);}finally{await fs.rm(temporary,{recursive:true,force:true});}
}

test('Windows accepts directory read ACEs by rights and propagation, never group name',windows,async()=>{
 await fixture(async store=>{
  for(const sid of ['S-1-1-0','S-1-5-32-545']){
   for(const inherit of ['None','ContainerInherit']){
    grant(store.root,{sid,inherit});await store.save(row);assert.deepEqual(await store.load(id),row);
    await store.acquire(id);await store.release(id);
    // The actual credential does not inherit the directory-reader SID.
    assert.equal(ps(`$acl=Get-Acl -LiteralPath $data.target; @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $data.sid }).Count`,{target:store.file(id),sid}),'0');
    remove(store.root,sid);
   }
  }
 });
});

test('Windows accepts inherited directory-only read but rejects explicit and inherited file inheritance',windows,async()=>{
 await fixture(async(store,temporary)=>{
  const parent=new ConnectionStore(path.join(temporary,'parent'));await parent.init();
  for(const unsafe of [false,true]){
   const child=path.join(parent.root,unsafe?'unsafe':'safe');
   grant(parent.root,{inherit:unsafe?'ContainerInherit, ObjectInherit':'ContainerInherit'});
   await fs.mkdir(child);const nested=new ConnectionStore(child);
   assert.equal(ps(`$acl=Get-Acl -LiteralPath $data.target; @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.IsInherited }).Count`,{target:child}),'1');
   if(unsafe)await assert.rejects(()=>nested.init(),{code:'unsafe_state_directory'});
   else{await nested.save(row);assert.deepEqual(await nested.load(id),row);}
   remove(parent.root);
  }
  for(const propagate of ['None','InheritOnly','NoPropagateInherit','InheritOnly, NoPropagateInherit']){
   grant(store.root,{inherit:'ObjectInherit, ContainerInherit',propagate});
   await assert.rejects(()=>store.save(row),{code:'unsafe_state_directory'});
   assert.deepEqual(await fs.readdir(store.root),[]);remove(store.root);
  }
 });
});

test('Windows rejects mutation rights, broadened credential and lease ACLs without overwriting',windows,async()=>{
 await fixture(async store=>{
  for(const rights of ['WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership']){
   grant(store.root,{rights});await assert.rejects(()=>store.init(),{code:'unsafe_state_directory'});remove(store.root);
  }
  await store.save(row);const before=await fs.readFile(store.file(id));
  grant(store.file(id));
  await assert.rejects(()=>store.load(id),{code:'unsafe_connection_state'});
  await assert.rejects(()=>store.save({...row,cursor:1}),{code:'unsafe_connection_state'});
  assert.deepEqual(await fs.readFile(store.file(id)),before);remove(store.file(id));
  await store.acquire(id);grant(store.file(id)+'.lease');
  await assert.rejects(()=>store.release(id),{code:'unsafe_connection_state'});
  await assert.rejects(()=>new ConnectionStore(store.root).acquire(id),{code:'connection_in_use'});
  remove(store.file(id)+'.lease');await store.release(id);
 });
});

test('Windows rejects wrong owner and root/ancestor junctions',windows,async()=>{
 await fixture(async(store,temporary)=>{
  const rootLink=path.join(temporary,'linked');await fs.symlink(store.root,rootLink,'junction');
  await assert.rejects(()=>new ConnectionStore(rootLink).init(),{code:'unsafe_state_directory'});
  await assert.rejects(()=>new ConnectionStore(path.join(rootLink,'nested')).init(),{code:'unsafe_state_directory'});
  assert.equal(await fs.stat(path.join(store.root,'nested')).then(()=>true,()=>false),false);
  // Get-Acl owner comparison uses the SID, even for another trusted principal.
  const oldOwner=ps(`(Get-Acl -LiteralPath $data.target).GetOwner([Security.Principal.SecurityIdentifier]).Value`,{target:store.root});
  try{
   ps(`$acl=Get-Acl -LiteralPath $data.target; $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'))); Set-Acl -LiteralPath $data.target -AclObject $acl`,{target:store.root});
   await assert.rejects(()=>store.init(),{code:'unsafe_state_directory'});
  }finally{
   ps(`$acl=Get-Acl -LiteralPath $data.target; $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($data.owner))); Set-Acl -LiteralPath $data.target -AclObject $acl`,{target:store.root,owner:oldOwner});
  }
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
