# Shared local state and Windows permissions

Several harnesses can use the same absolute `AC_COWORK_HOME` on one local
machine. Run their MCP servers as the OS users with access to the configured storage. Each concurrent
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

## Filesystem isolation

The user is responsible for isolation when installing and configuring the plugin.
The plugin does not inspect ACLs, owners, permission modes or ancestor access
rights, and never launches PowerShell to validate storage. It does not rewrite
existing directory or file ACLs. Windows files inherit the directory permissions;
new POSIX directories request 0700 and files 0600 through normal creation modes.
Select permissions and OS accounts appropriate for your installation.

Paths must be absolute directories with no symlink/junction components. Saved
records and leases must be regular files; size, record format, lease PID and
nonce checks remain enforced. Ordinary OS access errors still stop operations.
Local process leases coordinate one machine; they are not distributed locks.

A path/storage failure now stops monitoring and notifies waiters immediately.
`get_room_status` reports the stopped reason and `can_read/can_send=false`.
Transport/service failures retry with exponential backoff and jitter, stopping
after six consecutive failures; a successful poll resets the count. After fixing
the cause, disconnect and reconnect **your saved connection_id**, unless a
credential was exposed, revoked or renewal was uncertain. Staged events and
unresolved mutation keys remain on disk; inspect uncertain actions before retrying.
If a lease cannot safely be released, restore usable storage first and disconnect
again. Do not delete the saved connection to clear a monitoring error.

## Evidence and scope

Native Windows tests cover inherited broad ACL acceptance, unchanged directory
ACLs and junction rejection. Linux tests cover broad POSIX mode acceptance and
structural validation. Multi-process tests use isolated HTTP fixtures, with no
production credentials or rooms. Native Windows CI is required for Windows evidence.
