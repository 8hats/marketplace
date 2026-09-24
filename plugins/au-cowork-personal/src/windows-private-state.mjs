import {spawn} from 'node:child_process';
import path from 'node:path';

const script=String.raw`
$ErrorActionPreference='Stop'
try {
 $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $target=[IO.Path]::GetFullPath([string]$inputData.path)
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $trusted=@($user.Value,'S-1-5-18','S-1-5-32-544')
 $ancestorTrusted=@($trusted)
 try { $ancestorTrusted+=([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
 $parent=[IO.Directory]::GetParent($target)
 while($null -ne $parent) {
  if($parent.Exists) {
   if(($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
   $acl=$parent.GetAccessControl()
   if($ancestorTrusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'unsafe' }
   foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $ancestorTrusted -notcontains $rule.IdentityReference.Value -and ([int]$rule.FileSystemRights -band 852032) -ne 0) { throw 'unsafe' }
   }
  }
  $parent=$parent.Parent
 }
 if($inputData.directory -and -not [IO.Directory]::Exists($target)) {
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in $trusted) {
   $identity=New-Object Security.Principal.SecurityIdentifier($sid)
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
   $acl.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($target,$acl) | Out-Null
 }
 $item=Get-Item -LiteralPath $target -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne [bool]$inputData.directory) { throw 'unsafe' }
 $acl=$item.GetAccessControl()
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'unsafe' }
 $ownerAllowed=$false
 $ownerInherited=$false
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
   if($trusted -notcontains $rule.IdentityReference.Value) { throw 'unsafe' }
   if($rule.IdentityReference.Value -eq $user.Value -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ([int]$rule.FileSystemRights -band 2032127) -eq 2032127) {
    $ownerAllowed=$true
    if(([int]$rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { $ownerInherited=$true }
   }
  }
 }
 if(-not $ownerAllowed -or ($inputData.directory -and -not $ownerInherited)) { throw 'unsafe' }
 [Console]::Out.Write('private')
} catch { [Console]::Out.Write('unsafe'); exit 1 }
`;

export async function windowsPrivateState(target,directory){
 const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 await new Promise((resolve,reject)=>{
  const fail=()=>reject(Object.assign(Error('unsafe_state_directory'),{code:'unsafe_state_directory'}));
  const child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  let output='';const timer=setTimeout(()=>{child.kill();fail();},10000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>128){child.kill();fail();}});
  child.once('error',()=>{clearTimeout(timer);fail();});child.stdin.once('error',()=>{});
  child.once('exit',code=>{clearTimeout(timer);if(code===0&&output==='private')resolve();else fail();});
  child.stdin.end(JSON.stringify({path:target,directory}));
 });
}
