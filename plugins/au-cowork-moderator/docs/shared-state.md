# Shared local state and Windows permissions

Several harnesses can use the same absolute `AC_COWORK_HOME` on one local
machine. Run their MCP servers as the **same owning OS user**. Each concurrent
agent needs its own invitation and saved `connection_id`, even in the same
room. Personal and Moderator can share this directory; installing Moderator
never grants a role. Reconnect only the identity assigned to that session.
`room_name` selection fails when multiple identities have that name: use the
explicit ID from `list_rooms`.

One connection has one process lease, one credential, and one durable inbox.
Other connections progress independently. A live lease is never stolen; a
crashed lease can be recovered only when its PID is absent. PID reuse,
unreadable/malformed leases and interrupted recovery fail closed. Never remove
a live lease. Before removing a leftover empty `<connection_id>.json.lease.recovery`
directory, stop all harnesses using that connection and verify its owner process
is gone. Preserve the JSON credential/state file.

This is cooperative isolation between agents under one OS account, not a
security boundary between mutually hostile programs running as that account.
Do not share this directory between OS users or machines, or on a network drive.
Different sandbox users cannot inherit the owner's credentials. If an MCP server
is being launched as a sandbox account, configure the harness to launch its MCP
server as the owning user through its normal MCP integration. Do not fix this
by granting the sandbox group access to credential files or disabling sandboxing.

## Windows ACL boundary

The current user's SID must own the state directory and each state file. Only
that SID, LocalSystem (`S-1-5-18`) and built-in Administrators
(`S-1-5-32-544`) may have allow ACEs on credential/temp/lease files. The root
must retain the owner's full control inherited by files and subdirectories.
Existing directory and file permissions are **validated, never rewritten**.
New roots are created private. POSIX checks remain owner-only (0700/0600).

An extra **directory-only** read/list/traverse ACE is allowed on the Windows
root. It can reveal connection filenames and directory metadata, but not file
contents. It must contain only ReadAndExecute/Synchronize rights and must not
have ObjectInherit (`OI`), which would grant rights on new credential files.
ContainerInherit (`CI`) alone affects directories and is allowed for these
read-only rights. Any foreign write/create/delete/change-permissions/ownership
grant is rejected. An untrusted allow ACE is rejected even if a deny ACE might
cancel it; this is a conservative policy, not an effective-access calculator.

`IsInherited=false` does **not** mean an ACE is safe: explicit ACEs may propagate
to files. `OI`, `CI`, inherit-only and no-propagate flags determine propagation.
An inherited directory-only read ACE can be safe. A group called
`CodexSandboxUsers` has no special status: decisions use actual numeric SIDs,
rights and propagation, not names or group membership. Credential files still
reject every foreign allow ACE, regardless of inheritance provenance.

Paths containing junctions/reparse points are rejected, including ancestors.
Ancestor ownership and replacement permissions remain checked. Every new temp
file is validated before a credential is written. Existing credential files
are rechecked before reading or replacing them. If permissions change during
use, storage may stop; the plugin does not broaden ACLs to keep running.

## Diagnosing and recovering

The reported directory-only read grant can now coexist with private files
without moving state, changing connection IDs, or obtaining new invitations.
An explicit ACE alone is insufficient to establish that this is the reported
machine's actual situation; inspect its inheritance and the files separately.

These PowerShell commands inspect metadata only (substitute your actual path):

```powershell
$statePath = 'C:\Users\you\.au-cowork-central'
[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Get-Item -LiteralPath $statePath -Force | Select-Object FullName, Attributes
Get-Acl -LiteralPath $statePath | Select-Object Owner, AccessToString
(Get-Acl -LiteralPath $statePath).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
  Select-Object IdentityReference, FileSystemRights, IsInherited, InheritanceFlags, PropagationFlags, AccessControlType
# Inspect the ACL of your own saved connection; do not read or paste its contents.
Get-Acl -LiteralPath (Join-Path $statePath '<connection_id>.json') | Select-Object Owner, AccessToString
```

For `unsafe_state_directory`, check the MCP process's owning user, every path
component, directory rights and propagation. Have the owner/administrator
review only the affected ACL; do not recursively reset the home directory or
apply an Everyone/full-control grant. If a read rule is intended only for the
directory, it must not propagate to files. The plugin makes no automatic ACL
repair. Preserve state and configuration while investigating.

For `unsafe_connection_state`, a saved credential file is unsafe. If a foreign
principal had read access, treat that credential as potentially exposed: ask
the inviter to revoke the agent and provide a fresh invitation after storage
is private. Merely tightening ACLs does not revoke a copied credential. Keep
unaffected identities and state. Do not export credentials to another directory,
agent, issue or room message.

A security/storage failure now stops monitoring and notifies waiters immediately.
`get_room_status` reports the stopped reason and `can_read/can_send=false`.
Transport/service failures retry with exponential backoff and jitter, stopping
after six consecutive failures; a successful poll resets the count. After fixing
the cause, disconnect and reconnect **your saved connection_id**, unless a
credential was exposed, revoked or renewal was uncertain. Staged events and
unresolved mutation keys remain on disk; inspect uncertain actions before retrying.
If a lease cannot safely be released, restore safe storage first and disconnect
again. Do not delete the saved connection to clear a monitoring error.

## Evidence and scope

Native Windows tests exercise real PowerShell/NTFS ACLs, inheritance, private
files, leases and junctions. Multi-process tests run independent clients against
an isolated in-memory HTTP fixture; no real invitations or production room are
used. Linux tests do not prove Windows behavior. Windows CI is required for
native ACL evidence; running Codex's own sandbox on the reporter's machine is
not part of these tests.

Microsoft documents [ACE inheritance](https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance-rules)
and [file rights](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemrights).
OpenAI documents [Windows sandbox modes](https://learn.chatgpt.com/docs/windows/windows-sandbox):
elevated mode uses dedicated sandbox users; unelevated mode uses a restricted
current-user token. That explains why an account boundary can differ, but does
not prove which component added any particular ACE on the reported machine.

### Windows inspection failures

`state_inspection_failed` means the security inspection could not finish, not that an unsafe ACL was proven. PowerShell startup and inspection have a single 30-second deadline; no automatic retry or credential access follows a failed inspection. Check that Windows PowerShell starts under the owning OS user, then disconnect and reconnect. Do not loosen ACLs to address this error. Actual rejected permissions still report `unsafe_state_directory` or `unsafe_connection_state`.
