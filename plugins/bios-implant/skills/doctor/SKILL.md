---
name: doctor
description: Invoke when the user asks to diagnose, verify, or check BIOS Implant installation, binding, authentication, or boot readiness.
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
- Never construct, edit, copy, or expose the authorization URL.

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
