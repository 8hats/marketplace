---
name: 8hats-implant-doctor
description: Invoke when the user asks to diagnose, verify, or check BIOS Implant installation, binding, authentication, or boot readiness.
allowed-tools: mcp__plugin_bios-implant_implant-local__local_doctor, mcp__plugin_bios-implant_implant-local__local_status, mcp__plugin_bios-implant_implant__bios_load
---

# Doctor

## State

`TRIGGER`
- Enter when the user asks to doctor, diagnose, verify, inspect, or check BIOS Implant health.

`GOAL`
- Read health only. Do not mutate state beyond harmless health reads.

## Tool Boundary

`LOCAL`
- `local_doctor`
- `local_status`

`REMOTE`
- `bios_load` as an authenticated read probe only

`FORBIDDEN`
- Do not echo BIOS body.
- Do not repair, bind, stage, activate, or rewrite configuration from this skill.

## Protocol

`DISCOVER`
1. Resolve tools by capability suffix, not by server display name: use any callable tool that ends in `local_doctor`, `local_status`, or `bios_load`.
2. Duplicate MCP instances may coexist in Cowork. Prefer a callable connected capability over a sibling plugin instance marked `pending` or `needs authentication`.
3. Tool discovery is not a health probe. Call each applicable tool before reporting its state.

`READ-LOCAL`
1. Call `local_doctor`.
2. Call `local_status`.
3. If either local capability cannot be resolved or called, classify the local companion as broken and state which probe failed.
4. Do not claim that local state is healthy when the local probes did not run.

`READ-REMOTE`
1. If `local_status` returns a binding and any callable `bios_load` is available, call it for the bound agent and label as a read probe.
2. Treat the call as an auth and contract probe only.
3. Never print or restate the returned BIOS body.
4. Report OAuth as missing only when an actual `bios_load` call returns an authentication error.
5. If no binding exists or no callable `bios_load` exists, render the remote checks as `NOT CHECKED`; do not guess their authentication state.
6. Read the probe's error code as its own vocabulary — the codes name different defects with different owners:
   - `bad_shape` — the SERVER rejected the request shape. With a valid label this is almost always an unservable agent_id (a dot, an underscore, or >64 chars — the server admits Latin letters, digits, hyphen, 64 max). This is NOT an auth failure; re-authenticating cannot fix it. See `UNSERVABLE-ID`.
   - `unauthorized` — the token is missing/expired (re-auth fixes it) or the signed-in account is not the agent's owner (re-auth NEVER fixes it; the reason string names `not_owner` / `unknown_owner` when the server provides one).
   - `not_found` — no BIOS has been published for this agent yet. A waiting state, not a failure; never advise re-activation for it.

`CLASSIFY`
1. `HEALTHY`
   - Installation is valid.
   - Local companion and store are valid.
   - Folder binding is valid.
   - Remote implant MCP is available and authenticated.
2. `PARTIAL`
   - Installation is valid, but auth, binding, worldmodel readiness, or remote availability is missing.
   - Missing OAuth is a warning and remains `PARTIAL`, not `BROKEN`.
3. `BROKEN`
   - Payload, config, local companion, or store is invalid or untrustworthy.

## Failure Paths

`NO-AUTH`
- Use this path only when an actual `bios_load` call returns an authentication error.
- Do not report missing authentication from a server merely marked `pending` or `needs auth`, especially when another callable `bios_load` alias exists.
- Classify as `PARTIAL`.
- In Codex, give exactly `codex mcp login implant` after confirming the host installer is current.
- In Claude Code or Local Cowork, tell the owner to approve the harness-native OAuth prompt.
- On a surface with no TTY (Claude Desktop, driven sessions) the interactive flow cannot start: `claude mcp login` aborts with "stdin isn't a terminal" and the `/mcp` panel does not exist. Give the owner the exact recovery to run themselves: `script -q /dev/null claude mcp login plugin:bios-implant:implant` as a background task, then open the authorization URL it prints.
- Know the false signal: `claude mcp list` reporting `connection timed out after 30000ms` for an HTTP server almost always means an unauthorized 401 the client cannot begin OAuth for — not a network fault. Verify with a plain status probe before diagnosing the network.
- Authorization completed mid-session does not surface `bios_load`/`wm_load` in the running session: the tool registry is fixed at session start. When the token is stored but the tools are absent, the next action is exactly: start a fresh session and run `boot`.
- Never construct, edit, copy, or expose the authorization URL.

`UNSERVABLE-ID`
- Use this path when the read probe returns `bad_shape` with a well-formed label.
- The bound agent_id violates the serve-side alphabet (Latin letters, digits, hyphen, 64 chars max) — it was minted before the creation gate existed. Every `bios_load` for it fails permanently; no retry, re-auth, or fresh link changes that.
- Classify as `PARTIAL` with installation and local companion intact.
- Next action: the owner recreates the agent under a servable name and issues a fresh setup link; then `connect` in this folder rebinds it.

`NO-BINDING`
- Classify as `PARTIAL`.
- Give one exact next action: run `connect` for the exact folder.

`LOCAL-DAMAGE`
- Classify as `BROKEN`.
- Name the exact broken local boundary.

`REMOTE-MISSING`
- If the remote implant MCP is unavailable in this harness, classify as `PARTIAL` unless local payload or store is broken.

## Human Output

Render one compact table with these columns and rows:

| Check | Status | Evidence |
|---|---|---|
| 🧩 Installation | `✅ PASS`, `⚠️ PARTIAL`, `❌ FAIL`, or `⏭️ NOT CHECKED` | One factual sentence |
| 🖥️ Local companion | `✅ PASS`, `⚠️ PARTIAL`, `❌ FAIL`, or `⏭️ NOT CHECKED` | Actual probe result |
| 📁 Folder binding | `✅ PASS`, `⚠️ PARTIAL`, `❌ FAIL`, or `⏭️ NOT CHECKED` | Exact selected folder or reason not checked |
| 🔐 Remote OAuth | `✅ PASS`, `⚠️ PARTIAL`, `❌ FAIL`, or `⏭️ NOT CHECKED` | Actual `bios_load` auth result only |
| 🧠 BIOS read probe | `✅ PASS`, `⚠️ PARTIAL`, `❌ FAIL`, or `⏭️ NOT CHECKED` | Success, sanitized failure, or prerequisite |

After the table, print exactly:

`Verdict: HEALTHY|PARTIAL|BROKEN`

`Next action: <one exact command or owner action, or "none">`

## Completion Gate

Complete only when the response contains:
- exactly one classification: `HEALTHY`, `PARTIAL`, or `BROKEN`
- one exact next command or owner action
- evidence from every probe that actually ran, with unrun probes marked `NOT CHECKED`
- no state mutation beyond health reads
- no BIOS body echo
