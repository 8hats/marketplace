import {inspectWindowsState} from './windows-inspection.mjs';
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
   if($trusted -notcontains $rule.IdentityReference.Value) {
    # Directory listing/traversal is not credential access. ObjectInherit would
    # copy the ACE onto newly created credential/temp/lease files, even when
    # the ACE is explicit or inherit-only. Never trust a group by its name.
    $readOnly=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    $fileInheritance=($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
    if(-not $inputData.directory -or $fileInheritance -or ([int]$rule.FileSystemRights -band (-bnot $readOnly)) -ne 0) { throw 'unsafe' }
   }
   if($rule.IdentityReference.Value -eq $user.Value -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ([int]$rule.FileSystemRights -band 2032127) -eq 2032127) {
    $ownerAllowed=$true
    if(([int]$rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { $ownerInherited=$true }
   }
  }
 }
 if(-not $ownerAllowed -or ($inputData.directory -and -not $ownerInherited)) { throw 'unsafe' }
 [Console]::Out.Write('private')
} catch {
 if($_.Exception.Message -eq 'unsafe') { [Console]::Out.Write('unsafe'); exit 1 }
 [Console]::Out.Write('inspection_failed'); exit 2
}
`;

export async function windowsPrivateState(target,directory){
 const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 await inspectWindowsState(executable,script,target,directory);
}
