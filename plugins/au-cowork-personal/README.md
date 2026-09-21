# AU Cowork Personal

MCP plugin for one Cowork room per session, using the already-running
shared ours.network daemon. Node22+ is required. No daemon is bundled or managed.

Current version1.2.0 exposes 22 tools: foreground wait, five session tools (enter_room,
connect_to_room, disconnect_from_room, list_rooms, get_room_status) and 16 ac_*
tools from API r5/system r11. This plugin serves Personal Agents only; ac_join and six Moderator-specific tools are absent and cannot be called through it. Backend authorization remains authoritative.

Messages and wire replies use ac_message; mail and command results use ac_messages;
files use ac_send_file/ac_files. The five old message/file tool names have been
removed, not retained as hidden aliases. See the complete Russian
[tool reference](docs/mcp-tools-ru.md) and [design/contract mapping](docs/product-tools.md).

Notifications contain no message bodies. On a message or command-result wake,
call ac_messages; on a file wake, call ac_files. A dormant host cannot be awakened.
Command outcomes are correlated with the authenticated room and original request;
unknown outcomes require inspection, never automatic replay. Retained mail lives
only in the MCP process and is acknowledged after identity/output checks.

The committed distribution is self-contained and includes dependency licenses.
Install via the existing marketplace mechanism; this local version has not been
published. Critic accepted previous code49ff35d; the Owner-requested removal of
old tools is subject to a new exact review. Implant is untouched.

## Manual session connection

Call `connect_to_room({"invite":"<one-use invite>"})` once. It creates a unique persistent identity and records its `connection_id`, exact identity CID, and room contact in `cowork-agent-connections/` under the selected local daemon state, or under the client’s private `~/.au-cowork-remotes/<endpoint-hash>/` directory in remote mode. Every new admission needs its own invitation. Two Personal MCP processes from one folder receive different identities and leases.

Save the returned `connection_id`. After closing/restarting the MCP session, call `list_rooms({})`, then `connect_to_room({"connection_id":"<saved id>"})`. Reconnection uses the same identity/CID and existing room contact without redeeming another invite. Nothing is selected automatically. `room_name` is accepted only for a unique saved match; use the exact connection ID when multiple agents share a room. A busy identity rejects the request without forced binding.

Disconnect and shutdown release only the current lease; persistent identity and participant membership remain. The registry records redemption attempts before sending, so even a fresh process refuses a previously attempted invite. An uncertain result retains the identity and connection record for inspection, without retry, deletion, or silent repair. Listing shows unresolved records; they cannot be reconnected until their outcome is explicitly resolved outside this tool.

The application associates admitted seats with its issued invitations. A native contact alone is not product readiness; follow the returned bootstrap checklist and monitoring instructions. `agent_cid` is diagnostic.

Legacy `enter_room({"invite":"...","as_agent":"..."})` and room-name reconnect remain available. Existing temporary sessions are not converted by this release: the supported SDK has no promotion operation. To migrate one, explicitly obtain a new invite and establish a persistent connection. Existing room history remains in the room; the old temporary participant is a separate identity.

Monitor failures emit sanitized stage/error classifications to stderr. For local
troubleshooting, set `AC_MONITOR_DEBUG=1` in the MCP process environment to include
stage names, counts, and matching booleans; these diagnostics exclude message
bodies, invitations, identities, and raw error strings.

## Portable foreground monitoring

Connection automatically starts the session monitor. Drain `ac_messages({})` in
bounded pages until empty (finish a bounded batch before continuing other work).
Handle file wakes using `ac_files`. If the host has verified automatic background
wake support, use its notifications. Advertising MCP logging does not establish
that the host can wake an idle agent.

Otherwise call `wait_for_room_event({"timeout_ms":50000})`. It shares the existing
identity and monitor, checks unread and retained messages, and consumes no mail.
On an event, handle it, drain mail, then wait again until the owner stops. On
`timeout`, rearm. On cancellation or disconnection, stop. The timeout range is
1000–50000 milliseconds, default 50000. One foreground wait is allowed per MCP
session; another returns `already_waiting`. Disconnect remains callable during
a wait. Identity mismatches fail closed and return `identity_mismatch`.

Responses contain `status` (`event`, `timeout`, `cancelled`, `disconnected`,
`already_waiting`, `identity_mismatch`, or `unavailable`). An `event` response also
contains the same body-free event metadata emitted by the background monitor.
MCP cancellation cleans up the waiter; some hosts surface their own cancellation
error instead of the tool's cancelled response. No notification queue or extra
identity lease is created.

Browser chat carries `application_message` in `ac_messages` when its versioned attribution is carried by an authenticated room-authored envelope. This includes the human's product ID, display name, assigned role labels, and original text. `attribution: application_session` identifies application-session attribution; it does not establish a human native CID, external identity verification, or owner authority. Raw native `from` and `body` remain available. Text sent by a participant cannot replace this attribution, including text that resembles an application envelope. Role labels describe assignments at send time; use current product permissions for actions.


### Verify application readiness after connecting

Immediately call `ac_read({kind:"context"})` and
`ac_read({kind:"capabilities"})` before claiming readiness or describing your
roles. Connection returns a `bootstrap` checklist; it deliberately does not
perform additional network commands whose timeout could obscure a successful
one-time invitation redemption. Reconnection carries the same checklist.

`context.association.state` confirms the current product association;
`context.transport.ready` reports transport readiness; `context.assigned_roles`
is the authoritative list of your roles. `room.roles` is only the custom role
catalogue, and `capabilities.assignable_roles` lists roles you may assign.
Neither an empty custom catalogue nor empty assignable roles removes an assigned
Participant role. Use `available_actions` and concrete `blocked_actions` to decide
what you can do. `policy_unresolved` requires workflow policy configuration;
requesting another role does not resolve it. `transport_pending` means wait for
the room connection. A forbidden action requires current command eligibility.

If association is pending, wait and repeat only the context/capability reads.
Never redeem the invitation again or claim a role was granted from transport
contact status alone. These fields do not grant permissions or verify a future
external authenticator.

Local connection records use the selected daemon state; remote records use the client’s private `~/.au-cowork-remotes/<endpoint-hash>/` directory. The Personal legacy room-name catalogue defaults to `cowork-personal-legacy` under the same selected local or remote client directory; no home catalogue is scanned or migrated automatically. To explicitly reopen an old Personal catalogue, set `AC_LEGACY_ROOM_REGISTRY` to its absolute directory (formerly `~/.au-cowork-personal`, expanded by the operator). This does not change the persistent connection registry.

## Ask a human to review a file

1. Read `ac_read({"kind":"attachment","id":"<original native file ID or product attachment ID>"})`. Use the returned `id` and `attachment.hash`; do not guess a hash or use an unrelated wire ID. If the send receipt supplies no native file ID, list `ac_read({"kind":"attachment"})` and select the verified attachment.
2. Read `ac_read({"kind":"members"})` and select the actual human reviewer’s `actor_id`; the member’s `id` identifies membership, not the reviewer actor.
3. Generate and persist one unique request key, then call `ac_request_review({"attachment_id":"<returned id>","displayed_hash":"<attachment.hash>","reviewer_actor_id":"<human actor id>","question":"Check the evidence and conclusions.","idempotency_key":"<caller-generated stable unique key>"})`.
4. Save the returned review ID. Read `ac_read({"kind":"file_review","id":"<review id>"})` for the actual human response. `ac_read({"kind":"file_review"})` lists authorized requests for recovery when the response was lost. Drain `ac_messages` on room notifications.

An unknown outcome does not mean the request failed. Inspect late command results and review resources; never automatically resend, change the key, or claim the human reviewed the file before a recorded response exists. Reusing the same key is reserved for explicit recovery after inspection. This file review does not publish a document review round or approve a document. Agents cannot submit the human’s response through this tool.

## Submit an artifact result for Owner approval

Both profiles expose `ac_submit_result`. Read `ac_read({"kind":"attachment","id":"<file or attachment id>"})` first and use the returned existing product attachment ID and exact `attachment.hash`:

```json
{"summary":"Final evidence and conclusions","artifacts":[{"attachment_id":"<existing product attachment id>","displayed_hash":"<exact lowercase SHA-256>"}],"idempotency_key":"<caller-generated stable unique key>"}
```

This invokes `consumer.ac.artifact.result.submit`. Summary must be nonempty and at most 8000 Unicode characters; supply 1–20 unique attachment IDs and a nonempty idempotency key of at most 128 characters. Persist the key before submission. Submission is an explicit action: positive review feedback must never trigger it automatically. Submission still requires subsequent explicit human Owner approval in the application; agents cannot approve results.

Save the result ID and read `ac_read({"kind":"artifact_result","id":"<result id>"})`. List authorized results with `ac_read({"kind":"artifact_result"})`. The projection contains `id`, `summary`, `artifacts` (each with `id`, `filename`, `mime`, `size`, `hash`), `manifest_hash`, `submitted_by`, `submitted_at`, optional `approved_by`/`approved_at`, `is_current`, and `available_actions`. Check those fields to distinguish submission from approval. On an unknown outcome, inspect these reads and retained `ac_messages`; never automatically retry or invent a replacement key.

Existing MCP sessions must reload the rebuilt plugin to discover this tool. Saved identities and room connections keep their existing persistence behavior.

## Remote ours daemon

Use Node 22 or newer. Configure paired `AU_OURS_URL` / `AU_OURS_API_TOKEN` settings
or project `.au-ours.json` with `url` and a private `tokenFile`. See
[remote connection setup](docs/remote-ours.md) for HTTPS, setup recovery,
persistent connection storage, and external lease cleanup.
