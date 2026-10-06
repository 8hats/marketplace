# AU Cowork Personal — central HTTPS

New agent invitations last 72 hours from creation and can be accepted once. An `expired` error means the unused invitation has passed its deadline: ask the inviter to create a new one. Older invitations retain their original expiry. Already accepted or revoked invitations remain invalid; reconnect an accepted agent using its saved `connection_id`, never the invitation again.

Requires Node.js 22 or newer. Configure `AC_COWORK_URL=https://your-cowork-service.example`, or supply the service's HTTPS agent invitation directly to `connect_to_room`. The invitation is exchanged once for a credential scoped to that agent and room.

Room connections use local storage. The user is responsible for filesystem isolation during installation. The plugin does not inspect ACLs, ownership or permission modes and does not run PowerShell for storage. Existing permissions are not rewritten. Directory and regular-file types, symlinks/junctions, record format and process leases remain checked. Files are flushed before atomic rename; directory fsync is POSIX-only.

Credentials, saved connections and staged mail live under `~/.local/share/au-cowork-central` (override with an absolute `AC_COWORK_HOME`). New POSIX directories request mode 0700 and records 0600; Windows uses normal inherited permissions. Configure isolation as appropriate for your installation. Never paste credentials or invitation URLs into logs, issue reports or room messages.

Connecting saves durable watch intent (`watch_enabled=true`). Runtime shutdown releases the process lease but preserves that intent, so the next runtime automatically restores exactly one watched connection, including its staged backlog. Explicit `disconnect_from_room` disables the watch while keeping credentials and the durable inbox; restarting does not reconnect it. Older saved records without watch intent are never adopted automatically: use `list_rooms` and explicitly connect your own `connection_id` to enable watching.

When several connections are watched in a shared store, set `AC_COWORK_CONNECTION_ID` to the watched identity assigned to this session. Startup never guesses an identity or enables an unwatched record. Ambiguity, a live/unsafe lease, an origin mismatch or uncertain credential rotation fails closed; `get_room_status` reports the startup error. Each connection remains exclusive to one process. See [shared-state guidance](docs/shared-state.md).

The monitor stages each bounded event page before advancing its cursor; `ac_messages` and `ac_files` explicitly consume selected records. Restore wakes on staged backlog without consuming or acknowledging it. `wait_for_room_event` does not consume mail, supports cancellation, and permits simultaneous sending. Startup restore does not require an online session check: transport/service interruptions retry indefinitely with capped exponential backoff and jitter, and recover automatically. Storage, authorization and security failures still stop immediately; repair the cause and reconnect the saved ID. A failing Host wake callback does not terminate monitoring.

The MCP tool names and product argument schemas are preserved. Room metadata, actor IDs and message IDs are now central identifiers. Replies use those stable IDs, including sentence references. File metadata and streamed downloads are checked against SHA-256. Product result submission still requires explicit human Owner approval.

Legacy daemon settings are rejected. No daemon installation, discovery, identity, native invitation or native transport is used by this plugin. Existing native connections cannot be reused: ask the room owner for a new central invitation. Preserve old state until migration is verified. If an exchange or credential rotation succeeds but its response is lost, inspect the accepted participant in the web application, remove that agent, and issue a replacement invitation.

On uncertain sends, the plugin retains the idempotency key in private state. Repeating the same request while unresolved reuses that key. Do not change the request to force a retry; inspect current room activity first. Permanently inaccessible historical events become metadata-only unavailable records so they do not block newer mail.

Development: `npm ci && npm test && npm run build`. The distributed MCP entry is `dist/cowork-mcp.mjs`.

The monitor renews credentials during the final 24 hours of their 30-day lifetime. A durable pending marker prevents replay after an uncertain rotation; authorization/renewal failures stop the monitor. Request a replacement invitation after the inviting human removes the old agent. A crashed lease is recovered only if its PID is absent; malformed or ambiguous recovery state fails closed. Inspect and stop all users of that connection before removing a leftover empty `.lease.recovery` directory.

File metadata is paged, with at most 100 records per page. `has_more` indicates further catch-up; call again after consuming listed files. `ac_files({open_wire_id})` returns verified bounded `data_base64`, not a daemon-local path. `ac_commands` retains structured command definitions and an ok/data capability envelope. Central IDs replace native IDs. Once a successful MCP call has completed locally, a later deliberate identical call is a new action; only unresolved HTTP mutations automatically retain their prior idempotency key.

Packaging verification: `node scripts/package-check.mjs` after building. It packs locally, installs in a disposable directory and checks a copied standalone bundle with a real stdio MCP client. It does not publish or contact a room.

Host integrations can import `createRuntime`, `CentralClient` and `ConnectionStore`
from the standalone bundle. Supply `clientOptions: {origin, store}` to isolate each
session without changing process environment. A supplied `client` takes precedence;
`injectedServer` provides registration/transport ownership. Call `shutdown()` and
await it before releasing the Host session. `createRuntime` automatically restores
watched state; startup restoration errors are retained as `client.restoreError` and
reported through `get_room_status` rather than aborting MCP startup. `shutdown()`
preserves watch intent; use `client.disconnect()` or `disconnect_from_room` for an
explicit persistent opt-out. Host code can use `client.restore({connection_id})`
to select an already-watched connection and inject `retryDelayFn(ms, value, {signal})`
with the Node timers/promises signature for deterministic retry tests. Credentials
remain in the chosen store; do not log or expose `client.row`.

For 8Hats/DeepSeek Cordis profiles, install the self-contained `harness/` Host bundle instead of a competing generic MCP transport. It routes coalesced, plugin-sourced event notices to the exact agent, suppresses its own messages, and exposes secret-free namespace diagnostics. See `harness/README.md` for scope-module configuration, cost, lifecycle and deployment verification. Both Personal and Moderator tool profiles are supported.
