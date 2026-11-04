# Harness compatibility

`au-cowork-personal` and `au-cowork-moderator` declare `harness.json` schema version 1 for their standalone stdio MCP entrypoints. The MCP server requires Node.js 22+ and remains usable by other hosts supporting local stdio MCP; running it does not require Cordis. The optional [Cordis Host adapter](../plugins/au-cowork-personal/harness/README.md) is a separate integration with Host-specific APIs, not a portable replacement for that server.

## Important prerequisites and constraints

- The host must permit local subprocess execution and provide writable, appropriately isolated local storage and central HTTPS access. Configure an absolute `dist/cowork-mcp.mjs` entrypoint when not using marketplace path substitution. No ours daemon or native identity is required.
- Per-chat room isolation requires one separately owned/routed MCP process or embedded runtime per chat. A host's shared profile-wide MCP server shares its active room. Use stable per-chat `AC_COWORK_HOME` directories or separate injected `ConnectionStore` instances. A deliberately shared store requires explicit watched identity assignment; each concurrent agent has its own invitation/connection ID and lease.
- Automatic model wake requires host-specific routing of hints to the exact session; MCP logging alone is insufficient. Otherwise, use explicit message/file reads and `wait_for_room_event`. Monitoring runs only while the owning runtime lives, and restoration requires the same durable state and unambiguous watched identity.
- The Cordis adapter requires compatible Agent lifecycle, scoped tools, and steering APIs. An optional `scopeModule` path does not adapt these APIs for unrelated harnesses. Browser access is tab-scoped, not chat-scoped MCP state, and provides no automatic model wake or MCP reconnect ID.
- Protocol compatibility is not a claim of live verification for every harness/version. Installation never grants central roles or replaces human approval for results.

State belongs to the central HTTPS plugin's local connection store, not a daemon directory. See [shared-state guidance](../plugins/au-cowork-personal/docs/shared-state.md). Hosts embedding an older reviewed artifact at a pinned revision must update that artifact explicitly; merging compatibility declarations does not replace it.

## Marketplace declaration and installation

Harness's built-in `plugin marketplace` command installs a full immutable Git commit only after explicit `--trust`. It records package content digests, validates paths, rejects symlinks, and checks the bytes before each launch. Approval grants subprocess execution as the user's OS account; it is not sandbox confinement. Updates require another explicit commit and trust flag. Removal affects subsequent launches and retains files used by running processes.

The schema supports `schemaVersion: 1`, `mcp` (a package-relative JSON path), and optional `skills` (a package-relative directory). Version 1 only accepts Node stdio servers with a single bundled entrypoint and `${CODEX_PLUGIN_ROOT}` working directory. Hooks, host installers, remote MCP OAuth, arbitrary commands, and additional manifest fields are rejected. Every plugin in this marketplace carries a declaration.

CI checks these declarations against the shipped manifests on every push; to run it locally: `node --test test/harness-compatibility.test.mjs`. Publish declarations only through the Marketplace release process after Owner approval.
