---
name: connect
description: Invoke when the user asks to connect, activate, or bind BIOS Implant to the exact current workspace in a supported local session.
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
2. Let `local_activate` fetch and validate the setup document and perform its single activation request from the native host.
3. Do not fetch the setup document separately and do not reconstruct or run its `curl` command in the Cowork workspace sandbox.
4. Never restate, store, or log the one-use URL or capability.
5. If `local_activate` cannot safely validate or follow the setup document, stop before binding.
6. Require activation success and the returned `agent_id` before any local binding write.

`BIND`
1. Call `local_connect` only after the exact folder path is confirmed and `local_activate` returned success with an `agent_id`.
2. Pass only the exact binding inputs the local tool declares.
3. Let `local_connect` own validation and exact folder binding.
4. Never infer a folder, agent, or label from repo name, cwd ancestry, or prior sessions.

`VERIFY`
1. After success, re-query `local_status` or `local_selection` for the exact folder.
2. Report the bound agent id, label if present, and exact bound folder.
3. Never include secrets in the report.

## Failure Paths

`AUTHENTICATED`
- Binding exists and the companion reports the folder is connected to a specific agent.

`INSTALLED-BUT-AUTH-REQUIRED`
- The local companion is present, but activation or remote auth is still required.
- Report one exact next action for the owner.

`BROKEN`
- The local companion is missing, invalid, or the binding state cannot be trusted.
- Stop and report the exact broken prerequisite.

`PARTIAL-FAILURE`
- If setup-document activation or local validation fails at any point, do not claim success and do not leave a partial binding in the response.

## Completion Gate

Complete only when:
- the exact folder was owner-specified,
- `local_connect` succeeded,
- post-write status was re-checked,
- the response distinguishes `AUTHENTICATED`, `INSTALLED-BUT-AUTH-REQUIRED`, or `BROKEN`,
- and no secret was echoed or persisted.
