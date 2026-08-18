---
name: install
description: Install, update, or repair Agent University BIOS Implant from the public 8hats/marketplace marketplace and verify the result in a fresh session. Use when the user asks to install or update BIOS Implant, or says BIOS is missing or broken.
---

# Install BIOS Implant

Complete the installation autonomously where the host allows it, and hand the
user exact native steps where it does not. Ask the user only for a platform
permission, an unavailable prerequisite, native OAuth approval, an exact
workspace folder, or an owner-provided one-use setup URL.

## Boundaries

- The only distribution channel is the public marketplace
  [`8hats/marketplace`](https://github.com/8hats/marketplace). Never install through
  npm or npx: the former npm package is retired and frozen at an old version.
- Do not require Git, a repository checkout, a global install, Python, or a
  background daemon.
- Never ask for OAuth tokens, passwords, or browser cookies in chat.
- Never send a one-use setup URL to a shell command or a log. Give it only to
  the `connect` skill.

## Workflow

### 1. Check the only prerequisite

Node.js 20 or newer must be on `PATH` (`node --version`) — the local
companion MCP runs under it. If Node is missing or older, explain the exact
blocker and ask permission to install or update it, then resume.

### 2. Install or update by host

- **Claude Code**: run `claude plugin marketplace add 8hats/marketplace`, then
  `claude plugin install bios-implant@8hats` (slash equivalents:
  `/plugin marketplace add 8hats/marketplace`, `/plugin install
  bios-implant@8hats`). To update an existing install, run
  `claude plugin marketplace update 8hats`, then
  `claude plugin update bios-implant@8hats` — both commands are required.
- **Claude Desktop / Local Cowork**: the desktop plugin browser takes the
  same marketplace source, `8hats/marketplace`. Walk the user through it; this
  path is prepared rather than proven, so verify the result in a fresh
  session afterwards. Never use Settings → Connectors → Add custom
  connector — it registers the remote server without the skills, the hooks,
  or the local companion.
- **Codex and other MCP hosts**: no marketplace mechanism exists; follow the
  per-host configuration in the repository's `docs/multi-host.md` and boot
  via `AGENTS.md`.
- A machine that still carries the retired npx-era install
  (`bios-implant@agent-university`) must drop it first:
  `claude plugin uninstall bios-implant@agent-university`. Running both
  copies means duplicate skills and duplicate MCP servers.

### 3. Hand off to a fresh session

1. Have the host reload the plugin: restart Claude Code (or
   `/reload-plugins`), or fully quit and reopen Claude Desktop before a new
   Local Cowork session.
2. In the fresh session, invoke the installed `doctor` skill.
3. If the native remote MCP presents OAuth, ask the user to approve that
   native flow. Never request or copy the resulting credential.
4. Rerun `doctor` after OAuth and classify the result. Treat
   `AUTH_REQUIRED`, `BINDING_REQUIRED`, and `RUNTIME_PROBE_REQUIRED` as a
   successful install with one in-app step remaining.

### 4. Bind the intended workspace

1. Ask for the exact workspace folder only when it is not already explicitly
   supplied by the user.
2. Ask for the owner-provided one-use setup URL only when no binding exists.
3. Invoke `connect` from the exact workspace and give the one-use setup URL
   only to that skill.
4. Invoke `doctor` again after binding.

## Completion

Finish with one status:

- `INSTALLED`: plugin, MCPs, hooks, and skills are registered; OAuth or
  binding may still be an explicitly named next action.
- `READY`: a fresh session passes doctor, native OAuth is available when
  required, and the intended workspace is bound.
- `BLOCKED`: a prerequisite, permission, or exact failing check prevents
  further autonomous progress.

Report only the installed version, the doctor classification, the binding
status, and the one remaining user action, if any. Do not tell the user to
rerun steps already completed by this workflow.
