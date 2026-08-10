# 8Hats plugins

Public plugin marketplace for 8Hats / Agent University — agent identity and
continuity tooling.

The flagship plugin is **bios-implant**. Its payload is distributed as the
public npm package
[`@agentuniversity/bios-implant`](https://www.npmjs.com/package/@agentuniversity/bios-implant);
the marketplace entry here **sources that npm package directly**, so an install
always pulls the latest published release and there is no vendored copy in this
repository to drift out of date.

## What bios-implant is

An agent gets its identity from a BIOS document its owner publishes.
`bios-implant` gives a host two MCP servers and four skills:

- **`implant`** — the remote MCP (`https://implant.agents.university/mcp`),
  OAuth-backed, which loads the agent's BIOS and keeps its worldmodel current
  over one facade.
- **`implant-local`** — a local companion MCP (on-demand Node stdio, no
  daemon) that owns the exact-folder → agent binding, performs the one-use
  setup-link activation from the native host, stages a last-good BIOS copy so a
  service outage degrades quietly instead of silently, and answers health
  checks.
- **Skills** `install`, `connect`, `boot`, `doctor`, plus a `SessionStart`
  hook (Claude Code) that injects the session boot protocol.

Requires an Agent University account and an owner-provisioned agent: binding a
workspace consumes a **one-use setup URL** handed to you by the owner. There is
no self-service registration — the plugin is public, the service behind it is
not open to the public.

## Install — Claude Code

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
```

Restart Claude Code (or `/reload-plugins`). Then, inside a session:

1. Run the `doctor` skill. Complete native OAuth for the `implant` server only
   if prompted (`/mcp` → `implant`). Never enter a client id, callback URL, or
   scope by hand — OAuth discovery and registration are server-managed.
2. To bind a workspace: open the **exact folder** you want bound, obtain the
   owner-provided one-use setup URL, and give it only to the `connect` skill.
   Activation runs through the local companion; the URL is a single-use secret.
3. `boot` fires from the SessionStart hook automatically; run the `boot` skill
   manually to refresh mid-session.

Updating is two commands, and both are needed — the first refreshes the index,
the second moves you to the latest npm release:

```text
/plugin marketplace update 8hats
/plugin update bios-implant@8hats
```

Non-interactive equivalents: `claude plugin marketplace add 8hats/plugins`,
`claude plugin install bios-implant@8hats`.

Two caveats:

- **Pick one install path per host.** The npx installer (below) registers the
  same plugin as `bios-implant@agent-university`. If you already installed that
  way, keep it — do not add a second copy from this marketplace; two copies
  mean duplicate skills and MCP servers.
- If this machine already has a marketplace named `8hats` from a different
  source (the retired pre-2026-05 `agent-planner-production` mapping), the CLI
  does **not** replace it — it registers this repo under the fallback slug
  `8hats-plugins` instead, which collides with the 8hats **team** marketplace
  and hijacks its name (observed on 2.1.220; removing the hijacked entry also
  uninstalls its plugins). On such machines: migrate anything still installed
  from the stale `8hats`, `/plugin marketplace remove 8hats`, and only then
  add this one.

## Install — Claude Desktop / Local Cowork

The supported path is the npm installer, run in the real host terminal (not a
sandbox shell):

```sh
npx -y @agentuniversity/bios-implant@latest install --yes
```

It resolves the active Claude Desktop profile, registers the native Local
Cowork plugin, and verifies the registration by reading the plugin list back.
Requires Node ≥ 20 and Claude CLI ≥ 2.1.220. Fully quit and reopen Claude
Desktop, then in a new Local Cowork session run the `doctor` skill → OAuth if
prompted → `connect` with the one-use setup URL from the exact workspace →
`boot`.

Agent-driven bootstrap: point the agent at
<https://app.agents.university/bios-implant/SETUP.md> and let it follow the
document to completion.

## Install — Codex

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --harness codex
```

The installer registers the MCPs and pins the exact OAuth callback Codex needs
in `~/.codex/config.toml` (an existing conflicting value is preserved, never
overwritten). In a new Codex session, run `codex mcp login implant` if
authorization is required, then run the `boot` skill — Codex has no hook
runner, so boot does not fire by itself (expected in v1).

## Host-side doctor, update, uninstall

```sh
npx -y @agentuniversity/bios-implant@latest doctor
npx -y @agentuniversity/bios-implant@latest install --yes     # update / repair
npx -y @agentuniversity/bios-implant@latest uninstall --yes
```

These commands manage installs made by the npx installer. A marketplace
install updates via the two `/plugin` commands above instead, and the host-side
`doctor` may flag its missing persistent catalog — expected for that path, not
a fault.

`WARN AUTH_REQUIRED` / `WARN BINDING_REQUIRED` / `WARN RUNTIME_PROBE_REQUIRED`
mean the local install is correct and an in-app step remains — see the
package's `INSTALL.md` for the exact remediation per warning.

## Other hosts

As of 2026-08-10 the identity provider publishes a `registration_endpoint`, so
hosts that implement MCP OAuth with Dynamic Client Registration can obtain a
client automatically. Claude Code is verified end-to-end; Cowork and Codex are
installer-managed; everything else (hosted Claude connectors, Cursor, VS Code,
Gemini CLI, Zed, Windsurf, `mcp-remote`) is a prepared configuration awaiting a
first verified OAuth round-trip. [`docs/multi-host.md`](docs/multi-host.md)
carries the exact snippets and the current per-host status.

For hosts with no hook runner, [`AGENTS.md`](AGENTS.md) carries the session
boot protocol that Claude Code injects from a hook.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json   ← the marketplace index; bios-implant sources npm
├── docs/multi-host.md     ← per-host configuration and verification status
└── AGENTS.md              ← boot protocol for hook-less hosts
```

The plugin payload does not live in this repository. Source of truth is the
private `8hats/bios-implant` repo, which publishes
`@agentuniversity/bios-implant`; each npm release is immediately what this
marketplace installs.

## Adding or updating a plugin

1. **Updating bios-implant** = publishing a new npm package version. Nothing to
   commit here; installs and `/plugin update` follow the npm `latest` tag.
2. **A new plugin** needs an entry with `name` (kebab-case — the claude.ai sync
   rejects anything else) and `source` (an npm package or a relative path with
   a `.claude-plugin/plugin.json`). CI validates the manifest shape.
3. Never put `version` in a marketplace entry — the plugin.json inside the
   package owns it, and a stale marketplace copy silently breaks
   update-detection.
4. **Removing an entry silently uninstalls the plugin** for everyone who has
   it, on their next marketplace update. Deprecate in place.

## Related

The 8hats team marketplace (`8hats/8hats-plugins`) is private and carries the
internal-only plugins. `bios-implant` used to be duplicated there; it now lives
here (npm-sourced) only. Team installs migrate with
`/plugin install bios-implant@8hats` or the npx installer.

## License

Copyright © 8Hats. All rights reserved.
