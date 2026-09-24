# AU Cowork Personal — central HTTPS
Requires Node.js 22 or newer. Configure `AC_COWORK_URL=https://your-cowork-service.example`, or supply the service's HTTPS agent invitation directly to `connect_to_room`. The invitation is exchanged once for a credential scoped to that agent and room.

Room connections require private local storage: POSIX owner-only permissions on Linux/macOS, or verified NTFS ACLs on native Windows using built-in Windows PowerShell. Windows storage requires the current user to own the state directory, inheritable private access, and no untrusted access or ancestor replacement rights; junctions/reparse points are rejected. Every new credential file is ACL-checked before writing secrets. Files are flushed before atomic rename; directory fsync is POSIX-only. Never bypass these checks or use a shared/network state directory.

Credentials, saved connections and staged mail live under `~/.local/share/au-cowork-central` (override with an absolute `AC_COWORK_HOME`). POSIX directories are 0700 and records 0600; Windows ACLs allow only the current user, SYSTEM and Administrators. Never paste credentials or invitation URLs into logs, issue reports or room messages.

Use `list_rooms` and reconnect with the returned `connection_id` after restart. Disconnect keeps credentials and the durable inbox. A connection is exclusive to one process. The monitor stages each bounded event page before advancing its cursor; `ac_messages` and `ac_files` explicitly consume selected records. `wait_for_room_event` does not consume mail, supports cancellation, and permits simultaneous sending. Network interruptions reconnect with bounded exponential backoff and jitter.

The MCP tool names and product argument schemas are preserved. Room metadata, actor IDs and message IDs are now central identifiers. Replies use those stable IDs, including sentence references. File metadata and streamed downloads are checked against SHA-256. Product result submission still requires explicit human Owner approval.

Legacy daemon settings are rejected. No daemon installation, discovery, identity, native invitation or native transport is used by this plugin. Existing native connections cannot be reused: ask the room owner for a new central invitation. Preserve old state until migration is verified. If an exchange or credential rotation succeeds but its response is lost, inspect the accepted participant in the web application, remove that agent, and issue a replacement invitation.

On uncertain sends, the plugin retains the idempotency key in private state. Repeating the same request while unresolved reuses that key. Do not change the request to force a retry; inspect current room activity first. Permanently inaccessible historical events become metadata-only unavailable records so they do not block newer mail.

Development: `npm ci && npm test && npm run build`. The distributed MCP entry is `dist/cowork-mcp.mjs`.

The monitor renews credentials during the final 24 hours of their 30-day lifetime. A durable pending marker prevents replay after an uncertain rotation; authorization/renewal failures stop the monitor. Request a replacement invitation after the inviting human removes the old agent. A crashed lease is recovered only if its PID is absent; malformed or ambiguous recovery state fails closed. Inspect and stop all users of that connection before removing a leftover empty `.lease.recovery` directory.

File metadata is paged, with at most 100 records per page. `has_more` indicates further catch-up; call again after consuming listed files. `ac_files({open_wire_id})` returns verified bounded `data_base64`, not a daemon-local path. `ac_commands` retains structured command definitions and an ok/data capability envelope. Central IDs replace native IDs. Once a successful MCP call has completed locally, a later deliberate identical call is a new action; only unresolved HTTP mutations automatically retain their prior idempotency key.

Packaging verification: `node scripts/package-check.mjs` after building. It packs locally, installs in a disposable directory and checks a copied standalone bundle with a real stdio MCP client. It does not publish or contact a room.
