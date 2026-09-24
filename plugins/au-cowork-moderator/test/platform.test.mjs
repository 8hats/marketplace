import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CentralClient,ConnectionStore} from '../src/central-client.mjs';

test('secure storage round trips and rejects broadened native permissions',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'cowork-platform-')),root=join(temporary,'private');
 try{
  const store=new ConnectionStore(root);await store.init();
  const row={version:1,connection_id:'11111111-1111-1111-1111-111111111111',credential:'b'.repeat(43),origin:'https://cowork.example',cursor:0,staged:[],consumed_files:[]};
  await store.save(row);assert.deepEqual(await store.load(row.connection_id),row);
  if(process.platform==='win32')execFileSync('icacls.exe',[store.file(row.connection_id),'/grant','*S-1-1-0:(R)'],{stdio:'ignore'});else await chmod(store.file(row.connection_id),0o644);
  await assert.rejects(()=>store.load(row.connection_id));
 }finally{await rm(temporary,{recursive:true,force:true});}
});
test('storage preflight prevents consuming an invitation when credentials cannot be stored',async()=>{
 let requests=0;
 const client=new CentralClient({store:{init:async()=>{throw Object.assign(Error('unsafe'),{code:'unsafe_state_directory'});}},fetchFn:async()=>{requests++;throw Error('No network allowed');}});
 await assert.rejects(()=>client.connect({invite:'https://cowork.example/#/agent-invite/'+'a'.repeat(43)}),{code:'unsafe_state_directory'});assert.equal(requests,0);
});

test('Windows rejects unsafe ancestor rights and non-inheriting private roots before writing',{skip:process.platform!=='win32'},async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'cowork-acl-')),parent=join(temporary,'parent'),root=join(parent,'private');
 const powershell=script=>execFileSync(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore'});
 try{
  await new ConnectionStore(parent).init();
  for(const right of ['DC','WDAC']){
   execFileSync('icacls.exe',[parent,'/grant','*S-1-1-0:('+right+')'],{stdio:'ignore'});
   await assert.rejects(()=>new ConnectionStore(root).init(),{code:'unsafe_state_directory'});
   execFileSync('icacls.exe',[parent,'/remove:g','*S-1-1-0'],{stdio:'ignore'});
  }
  const store=new ConnectionStore(root);await store.init();
  const escaped=root.replaceAll("'","''");
  powershell(`$ErrorActionPreference='Stop'; $target='${escaped}'; $acl=Get-Acl -LiteralPath $target; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object Security.AccessControl.FileSystemAccessRule($user,'FullControl','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $target -AclObject $acl`);
  await assert.rejects(()=>store.save({connection_id:'11111111-1111-1111-1111-111111111111',credential:'secret-must-not-be-written'}),{code:'unsafe_state_directory'});
  assert.deepEqual(await readdir(root),[]);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
