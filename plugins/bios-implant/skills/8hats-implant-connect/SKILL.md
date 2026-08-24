---
name: 8hats-implant-connect
description: Invoke when the user asks to connect, activate, or bind BIOS Implant to the exact current workspace in a supported local session.
allowed-tools: mcp__plugin_bios-implant_implant-local__local_doctor, mcp__plugin_bios-implant_implant-local__local_activate, mcp__plugin_bios-implant_implant-local__local_connect, mcp__plugin_bios-implant_implant-local__local_selection, mcp__plugin_bios-implant_implant-local__local_status
---

# Connect

## State

`TRIGGER`
- Enter when the user asks to connect, activate, or bind BIOS Implant.

`PREREQ`
- Require a Local Cowork, Claude Code, or Codex session with `implant-local` available.
- Treat unqualified Cowork as Local Cowork in Claude Desktop.
- Remote Cowork is unsupported. Fail closed and tell the owner to continue in a local supported session.

`INPUTS`
- Require the exact active folder or repository path. Never infer it.
- Require an owner-provided one-use setup URL before any binding write.
- Treat the capability as a single-use secret. Never echo, store, log, quote, or restate it.

## Tool Boundary

`LOCAL`
- `local_doctor`
- `local_activate`
- `local_connect`
- `local_selection`
- `local_status`

`REMOTE`
- No remote activation MCP tool is part of this contract.
- Do not invent or call any remote activation MCP operation.

`FORBIDDEN`
- Never write user or repository instruction files.
- Never install software from this skill.
- Never use workspace shell, `curl`, Web Fetch, or browser automation for activation.
- Never mutate host configuration with arbitrary shell commands.
- Never display or persist tokens, capabilities, or activation URLs.

## Protocol

`CHECK`
1. Confirm the session is local and `implant-local` is available.
2. Confirm the exact folder path and the owner-provided one-use setup URL.
3. Call `local_doctor` and `local_selection` for the exact folder before any write to prove the companion is healthy, the root is exact, and the local path is writable through the supported boundary.
4. If the companion or exact-root check is unhealthy, stop before activation.

`ACTIVATE`
1. Pass the owner-provided setup URL exactly once to `local_activate`.
2. Let `local_activate` fetch and validate the setup document, perform its single activation request from the native host, and chain the folder binding for the current workspace root.
3. Do not fetch the setup document separately and do not reconstruct or run its `curl` command in the Cowork workspace sandbox.
4. Never restate, store, or log the one-use URL or capability.
5. If `local_activate` cannot safely validate or follow the setup document, stop before binding. An `AGENT_ID_UNSERVABLE` refusal means the agent's id can never be served — the link is NOT spent; tell the owner to recreate the agent under a servable name (Latin letters, digits, hyphen, 64 chars max) and issue a fresh link.
6. Require activation success and the returned `agent_id` before treating the workspace as connected.
7. Read BOTH flags in the result: `registry_bound` (server-side owner binding) and `folder_bound` (local workspace binding). They are different writes; never collapse them into one "bound".

`BIND`
1. Skip this step when `local_activate` reported `folder_bound: true` — the binding is already written; re-running `local_connect` is the sanctioned repair, not the default.
2. If `folder_bound` is false, call `local_connect` with the returned `agent_id` for the exact confirmed folder.
3. Pass only the exact binding inputs the local tool declares.
4. Let `local_connect` own validation and exact folder binding.
5. Never infer a folder, agent, or label from repo name, cwd ancestry, or prior sessions.

`VERIFY`
1. After success, re-query `local_status` or `local_selection` for the exact folder.
2. Report the bound agent id, label if present, and exact bound folder.
3. Never include secrets in the report.

`REMOTE-AUTH`
1. Binding and remote authorization are separate: the folder can be bound while the remote `implant` server (which serves `bios_load` / `wm_load`) still needs OAuth.
2. The one reliable authorization surface is the host's own plugin UI, which runs the flow with a live callback listener. In Claude Code, tell the owner exactly: run `/plugin` → Installed → **bios-implant** → MCP server `implant` → **Authenticate**. In Claude Desktop: the plugin browser's Authorize action on bios-implant. A native OAuth prompt the host raises on its own is the same flow — approving it is fine.
3. Never call the harness-injected `authenticate` tool, and never relay, print, or ask the owner to open a raw `…/auth?…` authorization URL from chat. That URL's PKCE challenge, state, and localhost callback belong to the one flow that minted it; the moment authorization runs anywhere else — or that flow's listener dies — the pasted link is a challenge that cannot complete. (Observed 2026-08-11, MEOW-20: the owner authorized through `/plugin`, which minted its own client and port; the URL sitting in chat was already dead.)
4. Never enter or echo client ids, callback URLs, scopes, or tokens.
5. Only when no plugin UI exists on the surface (driven/no-TTY sessions), give the owner this exact command for a regular terminal: `claude mcp login plugin:bios-implant:implant` — wrapped as `script -q /dev/null claude mcp login plugin:bios-implant:implant` where no TTY exists at all.
6. Know the false signal: `claude mcp list` reporting `connection timed out after 30000ms` for this server almost always means an unauthorized 401, not a network fault.

`RESTART`
1. The session's tool registry is fixed at session start: authorization completed mid-session does NOT make `bios_load` / `wm_load` appear in the running session.
2. Finish by telling the owner the literal last step: start a fresh session and run the `8hats-implant-boot` skill there. Authorization and the binding persist; the one-use link is never needed again.

## Failure Paths

`AUTHENTICATED`
- Binding exists and the companion reports the folder is connected to a specific agent.

`INSTALLED-BUT-AUTH-REQUIRED`
- The local companion is present, but activation or remote auth is still required.
- Report one exact next action for the owner. For remote auth that action is the REMOTE-AUTH
  step 2 instruction verbatim (`/plugin` → Installed → bios-implant → `implant` → Authenticate,
  or the Desktop plugin browser) — never a pasted authorization URL.

`BROKEN`
- The local companion is missing, invalid, or the binding state cannot be trusted.
- Stop and report the exact broken prerequisite.

`PARTIAL-FAILURE`
- If setup-document activation or local validation fails at any point, do not claim success and do not leave a partial binding in the response.

## Completion Gate

Complete only when:
- the exact folder was owner-specified,
- the folder binding exists (`folder_bound: true` from `local_activate`, or a successful `local_connect` repair),
- post-write status was re-checked,
- the response distinguishes `AUTHENTICATED`, `INSTALLED-BUT-AUTH-REQUIRED`, or `BROKEN`,
- the response states the remote-auth state and, unless already authenticated in a fresh session, ends with the literal restart instruction (new session, then `boot`),
- and no secret was echoed or persisted.
