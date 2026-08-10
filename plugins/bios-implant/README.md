# BIOS Implant

> **Where this comes from.** The live home of this plugin is the public
> marketplace [`8hats/plugins`](https://github.com/8hats/plugins). Installing
> from that marketplace serves exactly this tree, and a release is a version
> bump plus a push — no package registry sits in the path.

BIOS Implant gives an agent its identity. It loads the BIOS document the
agent's owner publishes, keeps the agent's worldmodel current, and owns the
exact-folder → agent binding on the host.

## What the plugin provides

- The remote **`implant`** MCP registration
  (`https://implant.agents.university/mcp`), OAuth-backed. Discovery, client
  registration, scopes, and callbacks are server-managed: the user never
  enters or edits connector settings.
- The local **`implant-local`** companion MCP — on-demand Node stdio, never a
  background daemon. It owns folder binding, one-use setup-link activation,
  last-good BIOS staging, and health checks. State lives under
  `AGENT_UNIVERSITY_HOME` or `~/.agent-university`.
- The portable `install`, `connect`, `boot`, and `doctor` skills.
- A Claude Code `SessionStart` hook that injects the session boot protocol,
  plus the plugin-native `SETUP.md` handoff used by Local Cowork.

What it does not include:

- The remote implant service
- OAuth credentials or an already authenticated remote MCP session
- Git, Python, or a global package
- Any background daemon

## Install

**Claude Code** — the verified path:

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
```

Restart Claude Code (or `/reload-plugins`). Updating is two commands and both
are required — the first refreshes the index, the second moves you onto the
version this repository now carries:

```text
/plugin marketplace update 8hats
/plugin update bios-implant@8hats
```

Non-interactive equivalents: `claude plugin marketplace add 8hats/plugins`,
`claude plugin install bios-implant@8hats`. Uninstall with
`claude plugin uninstall bios-implant@8hats`.

**Claude Desktop / Local Cowork** — the desktop app's plugin browser takes
the same marketplace source (`8hats/plugins`). This path is prepared, not yet
proven end to end. Fully quit and reopen Claude Desktop after a first install
or update so the UI starts from the reconciled plugin state.

**Codex and other MCP hosts** — no marketplace mechanism exists there.
Per-host configuration, and how far each host is actually proven, live in
[`docs/multi-host.md`](../../docs/multi-host.md); hosts without a hook runner
boot via [`AGENTS.md`](../../AGENTS.md).

Node ≥ 20 must be on `PATH`; the local companion runs under it.

## After installing — in a fresh session

1. Run the `doctor` skill. Complete native OAuth for the `implant` server
   only if prompted; never enter a client id, callback URL, or scope by hand.
2. To bind a workspace: open the **exact folder** you want bound, obtain the
   owner-provided one-use setup URL, and give it only to the `connect`
   skill — never to a shell command, a log, or normal chat.
3. `boot` fires from the SessionStart hook in Claude Code; on hook-less hosts
   run the `boot` skill manually at session start.

`WARN AUTH_REQUIRED`, `WARN BINDING_REQUIRED`, and
`WARN RUNTIME_PROBE_REQUIRED` from `doctor` mean the install is healthy and
one in-app step remains; [INSTALL.md](INSTALL.md) gives the remediation for
each.

## Agent bootstrap for Local Cowork

If you are the Local Cowork agent, fetch and follow the public setup document first:

https://app.agents.university/bios-implant/SETUP.md

Do not stop after fetching or summarizing it. Perform the setup and keep
working until that document tells you to finish. If you cannot fetch the
public URL for a transient reason, follow [SETUP.md](SETUP.md) in this tree —
it is the same document.

The complete durable agent workflow is packaged at
[`skills/install/SKILL.md`](skills/install/SKILL.md).

## Local And Remote

BIOS Implant has two parts:

- Local: the packaged plugin payload, local `implant-local` MCP, skills,
  hooks, and catalog snapshot stored under `AGENT_UNIVERSITY_HOME` or
  `~/.agent-university`
- Remote: the `implant` MCP endpoint used for authenticated BIOS and
  worldmodel access

The plugin carries only the remote MCP URL: OAuth discovery, client
registration, scopes, and callbacks are server-managed. Actual OAuth and
remote health verification happen inside a live session, so an install can
finish with an `AUTH_REQUIRED` warning and still be correct.

## Scope

- Verified end to end: Claude Code
- Prepared: Claude Desktop / Local Cowork through the plugin browser, Codex
  and other MCP-OAuth hosts — see
  [`docs/multi-host.md`](../../docs/multi-host.md)
- Remote Cowork: not supported
- Node runtime: `>=20`
- Platform scope: macOS GA; Windows and Linux preview

## Privacy And Security

- Local catalog and binding data live under `AGENT_UNIVERSITY_HOME` or
  `~/.agent-university`
- OAuth remains in the native harness credential store; the plugin never
  copies credentials, opens a browser on its own, or exports tokens
- The local `implant-local` MCP runs as on-demand Node stdio, not as a
  background daemon

## The retired npm channel

Earlier versions shipped as the npm package `@agentuniversity/bios-implant`
with an npx installer. That channel is retired: the package is frozen at
1.0.14, receives no releases, and is no longer an offered install path. A
machine that still carries an npx-era install runs the same plugin under the
`bios-implant@agent-university` name — running both means duplicate skills
and duplicate MCP servers. Move such a machine onto the marketplace:

```text
claude plugin uninstall bios-implant@agent-university
claude plugin install bios-implant@8hats
```
