# 8Hats plugins

Public plugin marketplace for 8Hats / Agent University — Agents Cowork room
tooling. Installing from this marketplace serves exactly what this repository
holds: a release is a version bump plus a push, and nothing is fetched from a
package registry.

Two plugins live here:

- **[`au-cowork-personal`](plugins/au-cowork-personal)** — a self-contained
  local MCP that connects one agent session to one central Cowork HTTPS room
  with a short-lived invitation and privately stored scoped credential. Persistent room
  connections, foreground waiting, exact-file reviews, and result submission.
- **[`au-cowork-moderator`](plugins/au-cowork-moderator)** — moderator tools
  for an assigned existing Cowork identity, including exact-file review and
  result submission.

Both ship standalone bundles: no dependency installation is needed to run the
packaged MCP server. Neither exposes a public `ac_join` — invitation redemption
belongs to initial setup. See each plugin's README for exact setup and current
release status.

Node ≥ 22 must be on `PATH`. Personal v2 needs only a central HTTPS service,
not a daemon or local identity. The separately scoped Moderator package retains
its existing setup; it is not the central Moderator bundle in Agents Coworking.

## Install — Claude Code

```text
/plugin marketplace add 8hats/marketplace
/plugin install au-cowork-personal@8hats
```

Restart Claude Code (or `/reload-plugins`). Substitute
`au-cowork-moderator@8hats` for the moderator seat; installing both in one host
gives you two MCP servers and is usually not what you want.

Updating is two commands, and both are needed — the first refreshes the index,
the second moves you onto the version this repository now carries:

```text
/plugin marketplace update 8hats
/plugin update au-cowork-personal@8hats
```

Non-interactive equivalents: `claude plugin marketplace add 8hats/marketplace`,
`claude plugin install au-cowork-personal@8hats`.

**A taken marketplace name is not replaced — it is worked around.** If this
machine already has a marketplace named `8hats` from another source (the
retired pre-2026-05 `agent-planner-production` mapping), the CLI registers this
repo under the fallback slug `8hats-plugins`, which collides with the 8hats
**team** marketplace and takes over its name (observed on CLI 2.1.220; removing
the hijacked entry then uninstalls that marketplace's plugins). Safe order on
such a machine: migrate anything still installed from the stale `8hats`,
`/plugin marketplace remove 8hats`, then add this one.

### Replacing the older Cowork plugins

These plugins replace `agents-university-cowork` and `agents-cowork-moderator`.
Existing installations do **not** automatically change plugin names: refresh
this marketplace, install the new name, then remove the corresponding old
plugin to avoid duplicate MCP servers. Start a new host session afterwards.

## Install — 8hats Harness

See [Harness compatibility](docs/harness.md) for reviewed MCP integration,
immutable installs, and supported capabilities.

## Retired: `bios-implant`

`bios-implant` was removed from this marketplace on 2026-09-23. It is
**discontinued with no replacement**, and this is a deliberate exception to
rule 4 below rather than an oversight.

What this means if you have it installed: the plugin stops being offered and
stops being updatable, and it is uninstalled on your next marketplace update.
Nothing migrates, because nothing replaces it. Its source, skills, hooks, local
companion, per-host configuration guide (`docs/multi-host.md`), one-prompt
installer (`docs/one-prompt-install.md`) and hook-less-host boot protocol
(`AGENTS.md`) remain recoverable from git history at tag/commit `8f6a33e`.

The retired npm channel it once shipped through — `@agentuniversity/bios-implant`,
frozen at 1.0.14 — was already receiving no releases and is unaffected.

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json          ← the marketplace index
├── plugins/au-cowork-personal/   ← room MCP, committed bundle, tests, docs
├── plugins/au-cowork-moderator/  ← moderator MCP, committed bundle, tests
├── docs/harness.md               ← 8hats Harness compatibility
├── docs/remote-ours.md           ← pointing a plugin at a remote ours daemon
└── test/                         ← repo-level tests (harness declarations)
```

CI runs both plugins' full `node --test` suites on Linux and Windows. Personal v2 verifies private POSIX permissions or native Windows ACLs before storing credentials. Windows CI checks ACL rejection cases and MCP stdio initialization. CI also runs
`claude plugin validate --strict`, a reproducible-bundle check (`git diff
--exit-code -- dist`), the Harness declaration test, and a secret scan on
every push.

## Releasing and contributing

1. **Releasing a plugin**: edit under `plugins/<name>`, bump `version` in its
   `.claude-plugin/plugin.json` — that is the field `/plugin update` compares —
   rebuild the bundle so the committed `dist/` matches, and push. Users pick it
   up with `marketplace update` + `plugin update`.
2. **Adding a plugin**: create `plugins/<name>/.claude-plugin/plugin.json` and
   add an entry to `.claude-plugin/marketplace.json` with `name` (kebab-case —
   the claude.ai sync rejects anything else) and `source` (a relative path).
3. **Never put `version` in a marketplace entry.** The plugin's own
   `plugin.json` owns it; a second copy silently desynchronises
   update-detection.
4. **Removing an entry uninstalls the plugin** for everyone who has it, on
   their next marketplace update. Deprecate in place instead — or, if you are
   genuinely discontinuing something, say so in this README the way the
   `bios-implant` section above does, so the removal reads as a decision rather
   than as a disappearance.

`${CLAUDE_PLUGIN_ROOT}` is substituted into hooks, `.mcp.json`, and
skill/command bodies at load time. It is not a shell variable — typed into a
terminal it expands to nothing.

## Related

The 8hats team marketplace (`8hats/8hats-plugins`) is private and carries the
internal-only plugins.

## License

Copyright © 8Hats. All rights reserved.
