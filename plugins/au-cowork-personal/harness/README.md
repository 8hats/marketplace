# Personal Cowork durable Host adapter

`@au-cowork/harness-personal` 2.0.6 is a Cordis **Host** bundle for 8Hats/DeepSeek. Install this directory with the profile's plugin manager. Its generic patch only inserts `au-cowork-harness-personal`; it does not disable deployment-specific MCP/coordinator rows. The operator must disable the old competing bundle locally to avoid duplicate tools or connection leases.

## Deployment configuration

The row accepts:

- `runtimeModule`: optional absolute module filename exporting `createRuntime`, `CentralClient`, and `ConnectionStore`. Default: direct import of `./dist/cowork-mcp.mjs`, shipped inside this installable package. The parent build produces both identical runtime copies; no external runtime path or installation build script is required.
- `scopeModule`: optional absolute module filename exporting `createScope`, for embedders without a Cordis Agent context. Normal 8Hats/DeepSeek activation uses the exact scoped registry returned by `agent.ctx.get('tools')` directly, so workspace-linked packages need no peer-module path and cannot accidentally import another checkout's scope symbols. The exact Agent context takes precedence over this legacy override.
- `stateRoot`: absolute root; default `path.join(homedir(), '.local/share/au-cowork-central/chats')`.
- `origin`: optional central HTTPS origin passed directly to the runtime client.
- `profile`: `personal` (default) or `moderator`; changes tool availability, never central roles or permissions.
- `coalesceMs`: coalescing delay, clamped to 100–250 ms; default 150.
- `retryMs`: transient message-author lookup retry delay, clamped to 250–30000 ms; default 2000.

Each exact `agent.id` gets a private runtime and scope, and state beneath `stateRoot/sha256(agent.id)`. Forks do not inherit a parent's credentials. Resuming the same session restores only that session's runtime state. The adapter neither copies credentials nor changes environment variables nor handles invitations automatically. Model tools still perform explicit invitation exchange when requested by an authorized caller.

The runtime restores `watch_enabled` connections on startup. Adapter shutdown preserves this flag; explicit `disconnect_from_room` disables it. No automatic chat reply is generated.

## Monitoring and cost

Monitoring runs only while the Host process and the exact live agent exist. Closing the agent unloads its scopes, aborts owned work, clears timers, and shuts down its runtime. After Host restart **and session resume**, durable watching auto-restores. Monitoring is not active while the computer is off or while the agent is not live; durable server/local backlog is caught up when resumed.

External message, attachment and command hints are coalesced into plugin-sourced agent notices. A notice may start model work and incur normal model token/call costs; it is **not** human authorization. Room content remains untrusted, and notices explicitly prohibit automatic room replies. Self-authored messages are suppressed via read-only message-author lookup, without consuming mail, acknowledgement or room mutations. Transient lookup errors remain pending with bounded retry delay. Host dedupe and pending queues are each bounded to 5000 IDs. Runtime logging is intercepted directly; ordinary MCP logging alone does not wake the Harness model.

`mcp__au-cowork__get_watch_status` exposes session id, SHA-256 state-directory fingerprint, monitor state, watch flag and Host pending count. When the runtime already provides this tool, the adapter adds these fields under `structuredContent.host_watch` rather than registering a duplicate. The runtime additionally exposes its version and sanitized `health`; wait results include `monitor` health independently of queued-mail status. It never exposes a credential, saved row or filesystem path. Existing installed JavaScript generations may require a Harness restart to load an updated runtime; confirm `get_watch_status` reports the expected version rather than relying only on saved package selection. Startup/unavailable/reconnecting states produce at most one warning per attachment lifetime; module/configuration failures unwind partial registrations. Host activation diagnostics remain the source for import/configuration failures that occur before the status tool is available.

## Verification

Run `node --test test/harness-adapter.test.mjs` from the parent plugin directory. To verify exact real Host registry isolation offline, run `node scripts/harness-check.mjs /absolute/harness/deployment`; this creates disposable empty stores and never contacts a room. Tests use injected factories and exact-agent fake scopes to cover real listing schemas, typed MCP errors, result rendering, restoration hints, coalescing/deduplication, self suppression, bounded pending state, transient read retry, fork isolation and disposal. The adapter tests do not establish live profile activation or a real central room connection; verify those separately after installation and any required restart.
