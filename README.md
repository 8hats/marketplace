# 8Hats plugins

Public plugin marketplace for 8Hats — agent identity and continuity tooling.

Everything here is built the same way: the capability is a **remote MCP server**,
and the plugin is a thin wrapper that registers it, adds a skill, and wires
host-specific hooks. That makes the useful half portable to any MCP client;
[`docs/multi-host.md`](docs/multi-host.md) covers what that takes per host, and
what currently stands in the way.

## Install (Claude Code)

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
/reload-plugins
```

Updating is two commands, and both are needed — the first refreshes the index,
the second pulls plugin files:

```text
/plugin marketplace update 8hats
/plugin update bios-implant@8hats
```

## Plugins

### 🧬 bios-implant

OAuth-authenticated remote MCP access that loads an agent's BIOS and keeps its
worldmodel current, over one implant facade.

An agent gets its identity from a BIOS document its owner publishes. The plugin
loads that document at session start, stages a local last-good copy so a service
outage degrades quietly instead of silently, and carries the one-time `connect`
flow that binds an owner-provisioned `agent_id` to this machine.

Requires an 8hats account and an `agent_id` provisioned by an owner. There is no
self-service registration — the plugin is public, the service behind it is not
open to the public.

Details: [`plugins/bios-implant/README.md`](plugins/bios-implant/README.md).

## Other hosts

Claude Code is the only host that can authenticate to these servers today. That
is a property of the 8hats identity provider — it publishes no
`registration_endpoint`, so hosts that expect Dynamic Client Registration cannot
obtain a client id, and the one registered redirect URI is matched literally.

[`docs/multi-host.md`](docs/multi-host.md) gives the exact configuration for
Cowork, Codex, Cursor, VS Code, Gemini CLI, Zed, Windsurf and the `mcp-remote`
fallback, states which are blocked and why, and names the three IdP changes that
would unblock them.

For hosts with no hook runner, [`AGENTS.md`](AGENTS.md) carries the session boot
protocol that Claude Code injects from a hook.

## Repository layout

```
plugins/
├── .claude-plugin/
│   └── marketplace.json      ← the marketplace index (must be at repo root)
├── plugins/
│   └── bios-implant/
│       ├── .claude-plugin/plugin.json
│       ├── .mcp.json         ← the remote MCP server + pinned OAuth client
│       ├── hooks/hooks.json  ← Claude Code only
│       ├── scripts/          ← plain python3, portable
│       └── skills/connect/SKILL.md
├── docs/multi-host.md
└── AGENTS.md
```

## Adding a plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json` with `name`, `description`
   and a semver `version`.
2. Add an entry to `.claude-plugin/marketplace.json` with `name` and `source`.
3. Push. CI validates manifests, frontmatter and script syntax.

Two things that bite, both learned the hard way:

- **`version` lives in `plugin.json`, not in the marketplace entry.** It is what
  `/plugin update` compares. A stale one makes update-detection report "already at
  latest" while users never pull new code.
- **Removing an entry from `marketplace.json` silently uninstalls the plugin** for
  everyone who has it, on their next marketplace update. Deprecate in place.

`${CLAUDE_PLUGIN_ROOT}` is substituted into `hooks.json` and into skill/command/agent
bodies at load time. It is not a shell variable — retyping it literally into a
terminal expands to nothing.

## Related

The 8hats team marketplace (`8hats/8hats-plugins`) is private and carries the
internal-only plugins. `bios-implant` is published in both; this public copy is
the one to use unless you are on the team.

## License

Copyright © 8Hats. All rights reserved.
