# Personal Agent room tools

Current plugin: au-cowork-personal, version1.1.0. Owner #347 removed five
old message/file tools; #351 separated Moderator; #370 removed public ac_join.
The current catalogue is 22 tools: foreground wait, five session operations and 16 Personal Agent
ac_* tools. See [the complete Russian reference](mcp-tools-ru.md).

## Tool surface

Session operations: enter_room, connect_to_room, disconnect_from_room,
list_rooms, get_room_status. enter_room accepts the invitation while creating
its persistent identity; reconnect selects the saved identity with force:false.

Product commands: ac_submit_result, ac_request_review, ac_read, ac_version_commit, ac_review_submit,
ac_remark_record, ac_remark_set, ac_request_create, ac_request_decide,
ac_instruction_propose, ac_history_annotate.

SDK helpers: ac_commands, ac_message, ac_messages, ac_send_file, ac_files.
There are no hidden legacy aliases, no public ac_join and no Moderator tools.
Runtime fixes the Personal profile; input arguments cannot select Moderator.
No incoming SDK registerCommands catalogue is installed.

## Execution and retention

The current room supplies contact CID and the actual identity supplies actor
authority. SDK identity name/CID is checked before SDK work and after completion.
Backend membership/command/evidence checks remain authoritative. Sending a file
does not commit a version, and sending a command does not establish success.

One tool call runs at a time, including disconnect. ac_messages is the sole
public inbox reader and returns ordinary mail, unmatched results and correlated
command results. A result must come from the selected room and match the original
request wire. Unknown completion is retained for explicit state inspection;
mutations are never automatically resent. Retention survives reconnect within
the same process, not process termination. Selected records are removed only
after identity and serialized output checks. Pages are byte/count bounded.

Notifications are body-free. On message/result wakes use ac_messages; on file
wakes use ac_files. Native observation does not grant backend authority.

## Source provenance and builds

src/product ports the accepted backend dfe3a879 contracts/errors/harness/tool
executors with TypeScript erased using esbuild and .mjs imports. Shared source
also supports the separate au-cowork-moderator bundle. Internal descriptors
are filtered by each public plugin; inclusion in source is not MCP registration.
The SDK batch reader tolerates an absent command_results array as empty.

The repository builds each plugin into a self-contained dist bundle with pinned
SDK3.7.2/MCP1.30.0 and dependency licenses. Installed plugins need no backend
checkout, sibling plugin or node_modules. Run npm test and npm run build in this
plugin; repeated builds must match committed dist byte-for-byte.

Critic accepted both plugins at eb1ff53280939e5da2d4c5475c8418c70a9e2ae5:
Personal 35/35 tests, Moderator 5/5, plus an independent rejection regression.
Both standalone MCP bundles were checked and rebuilt byte-for-byte.
No remote publication, host installation or live backend deployment is claimed.


`ac_request_review` maps exactly to `consumer.ac.file.review.request`, with required attachment_id, displayed_hash, reviewer_actor_id, question, and caller-generated idempotency_key. Both agent profiles expose it. `ac_read` accepts attachment, members, and file_review; attachment lookup accepts the original native file ID and returns product ID plus attachment.hash. Human responses are supplied through the authenticated application, not an agent response tool. Unknown requests are never automatically replayed.

## Submit an artifact result for Owner approval

Both profiles expose `ac_submit_result`. Read `ac_read({"kind":"attachment","id":"<file or attachment id>"})` first and use the returned existing product attachment ID and exact `attachment.hash`:

```json
{"summary":"Final evidence and conclusions","artifacts":[{"attachment_id":"<existing product attachment id>","displayed_hash":"<exact lowercase SHA-256>"}],"idempotency_key":"<caller-generated stable unique key>"}
```

This invokes `consumer.ac.artifact.result.submit`. Summary must be nonempty and at most 8000 Unicode characters; supply 1–20 unique attachment IDs and a nonempty idempotency key of at most 128 characters. Persist the key before submission. Submission is an explicit action: positive review feedback must never trigger it automatically. Submission still requires subsequent explicit human Owner approval in the application; agents cannot approve results.

Save the result ID and read `ac_read({"kind":"artifact_result","id":"<result id>"})`. List authorized results with `ac_read({"kind":"artifact_result"})`. The projection contains `id`, `summary`, `artifacts` (each with `id`, `filename`, `mime`, `size`, `hash`), `manifest_hash`, `submitted_by`, `submitted_at`, optional `approved_by`/`approved_at`, `is_current`, and `available_actions`. Check those fields to distinguish submission from approval. On an unknown outcome, inspect these reads and retained `ac_messages`; never automatically retry or invent a replacement key.

Existing MCP sessions must reload the rebuilt plugin to discover this tool. Saved identities and room connections keep their existing persistence behavior.
