# Shared local state and Windows permissions

Several harnesses can use the same absolute `AC_COWORK_HOME` on one local
machine. Run their MCP servers as the OS users with access to the configured storage. Each concurrent
agent needs its own invitation and saved `connection_id`, even in the same
room. Personal and Moderator can share this directory; installing Moderator
never grants a role. Reconnect only the identity assigned to that session.
`room_name` selection fails when multiple identities have that name: use the
explicit ID from `list_rooms`.

## Durable watch and startup selection

A successful connect persists `watch_enabled=true` alongside the credential and
inbox. Runtime shutdown releases the lease while preserving the watch; the next
`createRuntime` automatically restores it. Explicit `disconnect_from_room` (or
`client.disconnect()`) persists `watch_enabled=false` and prevents automatic
reconnection, without deleting credentials, staged events or mutation keys.
Old records with no watch flag are not adopted; explicitly connect your own saved
ID once to enable this behavior.

Startup selects exactly one watched record. With several watched identities in a
shared directory, configure each session's `AC_COWORK_CONNECTION_ID` with its own
watched ID. An explicit startup ID never enables an unwatched record and never
falls back to another identity. Host integrations may call
`client.restore({connection_id})`. Selection ambiguity, lease conflicts, unsafe
state, origin mismatch and pending credential rotation fail closed. The MCP
runtime remains available, emits an unavailable notice and exposes the restoration
error through `get_room_status`; it does not silently pick another identity.

Restore skips the online `/session` check so a central outage does not prevent
startup recovery. Durable backlog triggers a wake without an acknowledgement or
read; use `ac_messages` and `ac_files` to consume it. Wake callback failures cannot
stop polling.

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
Transport/service failures retry indefinitely with capped exponential backoff and
jitter; a successful poll resets the backoff and malformed-response budget. Jitter
spans 75–125% of the exponential base, capped at 30 seconds. Valid `Retry-After`
seconds or HTTP dates supply a floor capped at 60 seconds. HTTP 408/425/429 and
5xx except 501/505 retry before any JSON parsing, including HTML gateway bodies.
Successful JSON/envelope/event-page-shape faults have a three-malformed-attempt
budget; intervening transport errors do not erase it. Cursor/sequence integrity,
authorization, rotation and local storage/security failures remain immediately
terminal. No automatic mutation replay is introduced. No manual reconnect is needed
for a transient outage. After fixing a stopped monitor's cause,
disconnect and reconnect **your saved connection_id**, unless a
credential was exposed, revoked or renewal was uncertain. Staged events and
unresolved mutation keys remain on disk; inspect uncertain actions before retrying.
If a lease cannot safely be released, restore usable storage first and disconnect
again. Do not delete the saved connection to clear a monitoring error.

## Health and queued mail

Every wait result adds `monitor`; status tools add `health`. A queued event can be
returned even while polling is stopped, but its health snapshot reports
`live: false`, the actual state and last successful poll time. Failure counts,
next retry delay and sanitized diagnostics are distinct from queue availability.
Diagnostics contain only endpoint templates, HTTP status, allowlisted base MIME
(or null), fixed reason and timestamp; never URLs, headers, bodies or secrets.
Protocol-only stops leave queued message fetch/ack usable. Authorization, rotation
and storage stops remain fail-closed for reads. `get_watch_status.version` confirms
which runtime generation is loaded after an installed package update/restart.
Tool input schemas are unchanged; consumers should tolerate these additive outputs.

## Evidence and scope

Native Windows tests cover inherited broad ACL acceptance, unchanged directory
ACLs and junction rejection. Linux tests cover broad POSIX mode acceptance and
structural validation. Multi-process tests use isolated HTTP fixtures, with no
production credentials or rooms. Native Windows CI is required for Windows evidence.
