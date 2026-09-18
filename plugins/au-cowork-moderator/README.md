# AU Cowork Moderator

Separate Moderator product profile with 22 product tools. Standalone `connect_to_room({"invite":"<one-use invite>"})` creates a unique persistent identity and returns a durable `connection_id`. Its identity/CID and room contact are stored in the selected daemon's private `cowork-agent-connections/` registry.

After restarting the MCP session, use `list_rooms({})` and `connect_to_room({"connection_id":"<saved id>"})`. Reconnect preserves the identity/CID and room without redeeming another invitation. Selection is explicit, and a busy identity rejects binding without force. Standalone mode exposes 26 tools including foreground wait, connect, disconnect, and list.

Disconnect/shutdown release the lease, retaining identity and room membership. Invitation attempts are recorded durably before redemption and never retried, including after a process restart. Unknown outcomes retain the identity and record for inspection. Product association can remain pending after native contact establishment; follow the bootstrap checklist.

Existing temporary sessions are not converted. No supported SDK promotion operation exists; migrating one requires an explicitly issued new invite and persistent connection, while old room history remains intact. Operator-supplied already-bound Moderator inputs retain their existing lifecycle.

## Runtime inputs

Set AC_MODERATOR_INPUTS_MODULE in the MCP host environment to an absolute local
ES module exporting async createModeratorInputs(). The module supplies:

- client: the ours SDK client already bound to the assigned Moderator identity;
- identityName and identityCid: exact assigned identity evidence;
- roomCid and roomName: exact selected native room/contact;
- monitor: optional boolean, default true, controlling body-free notification watch.

The integration owns the SDK lease and any initial invitation redemption.
Startup and tool calls verify the assigned identity. Shutdown stops this plugin's
notification watch and MCP server; it does not release the integration's lease.
No secrets or actual installation inputs are shipped in this public repository.

With supplied inputs, discovery lists the 22 product tools plus
`wait_for_room_event`.
Without inputs, product calls return not_connected until manual connection.
Invalid configured inputs or wrong startup identity fail visibly with a redacted
error. No identity repair, forced binding, daemon lifecycle or automatic mutation
retry is attempted. Backend room admission and current Moderator authorization
are required independently of the selected plugin.

## Tools

Shared: ac_commands, ac_read, ac_send_file, ac_files, ac_version_commit,
ac_review_submit, ac_remark_record, ac_remark_set, ac_request_create,
ac_request_decide, ac_instruction_propose, ac_history_annotate, ac_message,
ac_messages.

Moderator additions: ac_request_route, ac_review_publish, ac_publication_propose,
ac_intervention_record, ac_stage_explain, ac_result_create.

Arguments use API r5 section3/4, r11 section7.2/7.3, with public ac_join removed by
Owner #370. Underlying product functions are shared with the Personal source at
build time. The generated bundle contains everything it needs: installing the
Personal plugin alongside it is not required. Use ac_messages after message or
result wakes, ac_files after file wakes. Output/identity checks precede retained
mail acknowledgement; unknown outcomes require inspection before a new command.

## Development

First run `npm ci` in `../au-cowork-personal` for the shared source tests.
Then, from this directory, run `npm ci`, `npm run build`, and `npm test`.
Build resolution includes this plugin's pinned node_modules for shared source imports. CI also checks
byte-identical rebuilds. Tests use mock bound clients and real MCP transports,
including a configured standalone stdio bundle; they do not launch Fleet agents
or touch a live daemon. Critic accepted both plugins at
`eb1ff53280939e5da2d4c5475c8418c70a9e2ae5`, with all 35 Personal tests and
five Moderator tests passing, standalone MCP checks, and byte-identical rebuilds.
Live Fleet integration was not exercised. This local candidate has not been published.

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

Browser chat includes `application_message` in `ac_messages` only after authenticated room-envelope validation. Its author contains the human's product ID, display name, and role labels with `attribution: application_session`. This is application attribution, not a human native CID, external identity verification, or owner authority. Raw native signer and body remain intact. Use current product permissions for actions; role labels are a snapshot at send time.


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

Persistent connection records always use the selected daemon state. The Personal legacy room-name catalogue defaults to `<daemon state>/cowork-personal-legacy`; no home catalogue is scanned or migrated automatically. To explicitly reopen an old Personal catalogue, set `AC_LEGACY_ROOM_REGISTRY` to its absolute directory (formerly `~/.au-cowork-personal`, expanded by the operator). This does not change the persistent connection registry.

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
