# 8Hats plugins

Public plugin marketplace for 8Hats / Agent University — agent identity and
continuity tooling.

The plugin it carries is **bios-implant**, and it lives in this repository
under [`plugins/bios-implant`](plugins/bios-implant): manifest, skills, hooks,
the local companion MCP (`src/` + `dist/`), and its test suite. Installing from
this marketplace serves exactly what this repo holds, and a release is a
version bump plus a push — nothing is fetched from a package registry.

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
- **Skills** `boot`, `connect`, `doctor`, `install`, plus a `SessionStart`
  hook (Claude Code) that injects the session boot protocol.

Requires an Agent University account and an owner-provisioned agent: binding a
workspace consumes a **one-use setup URL** handed to you by the owner. There is
no self-service registration — the plugin is public, the service behind it is
not open to the public.

Node ≥ 20 must be on `PATH`; the local companion runs under it.

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
the second moves you onto the version this repository now carries:

```text
/plugin marketplace update 8hats
/plugin update bios-implant@8hats
```

Non-interactive equivalents: `claude plugin marketplace add 8hats/plugins`,
`claude plugin install bios-implant@8hats`.

Two caveats, both learned by hitting them:

- **One copy per host.** The retired npx installer registered the same plugin
  separately as `bios-implant@agent-university`. Running both means duplicate
  skills and duplicate MCP servers. To move an existing npx-era install onto
  this marketplace:

  ```text
  claude plugin uninstall bios-implant@agent-university
  claude plugin install bios-implant@8hats
  ```

- **A taken marketplace name is not replaced — it is worked around.** If this
  machine already has a marketplace named `8hats` from another source (the
  retired pre-2026-05 `agent-planner-production` mapping), the CLI registers
  this repo under the fallback slug `8hats-plugins`, which collides with the
  8hats **team** marketplace and takes over its name (observed on CLI 2.1.220;
  removing the hijacked entry then uninstalls that marketplace's plugins).
  Safe order on such a machine: migrate anything still installed from the stale
  `8hats`, `/plugin marketplace remove 8hats`, then add this one.

## Other hosts

`docs/multi-host.md` carries the exact per-host configuration and how far each
one is actually proven. In short:

- **Claude Code** — the path above; verified end to end.
- **Claude Desktop** — the desktop app has a plugin browser that takes the same
  marketplace source (`8hats/plugins`); we have not yet driven a Local Cowork
  session through it, so treat that path as prepared rather than proven.
- **Codex** — no marketplace mechanism; configure the remote MCP by hand per
  `docs/multi-host.md`. Codex has no hook runner, so run the `boot` skill
  yourself at session start.
- **Anything else that speaks MCP** (hosted Claude connectors, Cursor, VS Code,
  Gemini CLI, Zed, Windsurf, `mcp-remote`) — the identity provider now
  publishes a `registration_endpoint`, so Dynamic Client Registration works and
  these hosts can reach the remote `implant` server. Those configurations are
  prepared and syntax-checked, not yet proven by a completed OAuth round-trip.
  They also get the remote half only: no skills, no hooks, no local companion.

For hosts with no hook runner, [`AGENTS.md`](AGENTS.md) carries the session
boot protocol that Claude Code injects from a hook.

## The retired npm channel

Before this repository became self-contained, the payload shipped as the npm
package `@agentuniversity/bios-implant` with an npx installer. That channel is
retired: the package is frozen at 1.0.14, receives no releases, and is no
longer an offered install path. Machines that still carry an npx-era install
keep working against that frozen version and never see the releases made
here — migrate them with the uninstall/install pair above.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json      ← the marketplace index
├── plugins/bios-implant/     ← the plugin: manifest, skills, hooks, local
│                                companion MCP (src/ + dist/), test suite
├── docs/multi-host.md        ← per-host configuration and status
└── AGENTS.md                 ← boot protocol for hook-less hosts
```

CI runs the plugin's full `node --test` suite, `claude plugin validate
--strict`, and a secret scan on every push. The former homes — the
`8hats/bios-implant` source repo and the copy in the private team monorepo —
are retired and point here.

## Releasing and contributing

1. **Releasing bios-implant**: edit `plugins/bios-implant`, bump `version` in
   its `.claude-plugin/plugin.json` — that is the field `/plugin update`
   compares — and push. Users pick it up with `marketplace update` +
   `plugin update`.
2. **Adding a plugin**: create `plugins/<name>/.claude-plugin/plugin.json` and
   add an entry to `.claude-plugin/marketplace.json` with `name` (kebab-case —
   the claude.ai sync rejects anything else) and `source` (a relative path).
3. **Never put `version` in a marketplace entry.** The plugin's own
   `plugin.json` owns it; a second copy silently desynchronises
   update-detection.
4. **Removing an entry uninstalls the plugin** for everyone who has it, on
   their next marketplace update. Deprecate in place instead.

`${CLAUDE_PLUGIN_ROOT}` is substituted into hooks, `.mcp.json`, and
skill/command bodies at load time. It is not a shell variable — typed into a
terminal it expands to nothing.

## Related

The 8hats team marketplace (`8hats/8hats-plugins`) is private and carries the
internal-only plugins. `bios-implant` used to be duplicated there; it now lives
here only, and team machines migrate with the two commands at the top of this
file.

## License

Copyright © 8Hats. All rights reserved.
