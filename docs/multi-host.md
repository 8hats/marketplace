# Using these plugins outside Claude Code

Every plugin in this marketplace is built the same way: the capability is a
**remote MCP server**, and the plugin is a thin wrapper that registers it, adds
skills, and wires host-specific hooks. Since 1.0.x there is a second portable
half: the **local companion** (`implant-local`), an on-demand Node stdio MCP
shipped inside the npm package — it owns folder binding, one-use activation,
and last-good BIOS staging, and it runs anywhere Node ≥ 20 runs.

So the question for any other host is never "does it support Claude Code
plugins" — none of them do. It is: **can this host authenticate to the remote
server, and can it run the local companion?**

## The status, as of 2026-08-10

The 2026-07-31 revision of this document said Claude Code was the only host
that could connect, because the IdP had no Dynamic Client Registration and the
`bios-implant` client accepted exactly one redirect URI. Both facts have since
changed on the IdP, and both are directly observable:

```console
$ curl -s https://id.agents.university/.well-known/openid-configuration | jq -r '.registration_endpoint'
https://id.agents.university/reg
```

1. **RFC 7591 Dynamic Client Registration is live.** Hosts that self-register —
   VS Code, Cursor, Gemini CLI, hosted Claude connectors, `mcp-remote`, Codex's
   generic flow — can now obtain a `client_id` on the fly. The endpoint
   validates registrations (an empty one is rejected with
   `redirect_uris is mandatory property`); it is not a stub.

2. **The static `bios-implant` client now accepts two pinned redirect URIs**,
   still matched literally:

   | `redirect_uri` presented to `/auth` (client `bios-implant`) | Result |
   |---|---|
   | `http://localhost:8484/callback` | `303` — accepted (Claude Code) |
   | `http://127.0.0.1:8486/callback/dXk1HafgCxhy` | `303` — accepted (Codex, installer-pinned) |
   | `https://claude.ai/api/mcp/auth_callback` | `400` — rejected on this client; hosted surfaces register their own client via DCR instead |

The hard IdP-side blocker is gone. What remains is per-host verification: a
configuration below is **prepared** until someone completes an OAuth
round-trip on that host and sees tools.

Current standing:

- **Verified end-to-end**: Claude Code — marketplace install, server-managed
  OAuth, boot protocol, local staging.
- **Installer-managed**: Claude Desktop / Local Cowork (native plugin
  registration, verified by plugin-list readback) and Codex (registration +
  pinned callback). Run
  `npx -y @agentuniversity/bios-implant@latest install --yes` — see the
  [README](../README.md). The npx channel serves the last npm release (1.0.14,
  frozen); this marketplace is the live channel.
- **Prepared, awaiting first verified round-trip**: hosted Claude connectors,
  Cursor, VS Code, Gemini CLI, Zed, Windsurf, `mcp-remote`.

---

## Claude Code — works today

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
```

Then `/mcp` → `implant` → authenticate. This path gets the session boot
protocol from a hook and BIOS staging through the bundled local companion.

Non-interactive equivalent, for provisioning a fleet via `settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "8hats": { "source": { "source": "github", "repo": "8hats/plugins" } }
  },
  "enabledPlugins": { "bios-implant@8hats": true }
}
```

## Claude Desktop / Local Cowork — installer-managed

Use the npm installer from the README; it registers the native desktop plugin
and verifies it. Do **not** use Settings → Connectors → *Add custom connector*
for Local Cowork — the native plugin path is the supported one and carries the
skills and the local companion.

## Hosted Claude connectors (claude.ai / desktop connectors) — prepared

The mechanism is Settings → Connectors → *Add custom connector* → the server
URL:

```
https://implant.agents.university/mcp
```

How the connector obtains an OAuth client decides the outcome. Anthropic's
current docs describe custom connectors as using a **pre-registered client
id** rather than DCR; on this IdP that means a dedicated client carrying the
hosted callback (`https://claude.ai/api/mcp/auth_callback`) must be registered
first — the static `bios-implant` client rejects that callback (`400`,
probed). If the surface performs DCR after all, it can self-register today.
Either way this gives the remote half only: no skills, no hooks, no local
companion, no staged fallback. Verify a full OAuth round-trip before handing
this to a user as a working step. (Claude Code sessions on claude.ai/code do
not load plugins at all — use the terminal or desktop app.)

## OpenAI Codex — installer-managed

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --harness codex
```

The installer registers `implant` and `implant-local` for Codex and pins the
callback pair in `~/.codex/config.toml`. In a new session:

```console
$ codex mcp login implant
```

Codex reads `AGENTS.md`, not hooks — see the
[repository `AGENTS.md`](../AGENTS.md) for the boot protocol in a form Codex
will actually load, and run the `boot` skill at session start.

## Cursor — prepared

`~/.cursor/mcp.json` (or `<repo>/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "implant": { "url": "https://implant.agents.university/mcp" }
  }
}
```

## VS Code + GitHub Copilot — prepared

`<repo>/.vscode/mcp.json` — note the key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "implant": {
      "type": "http",
      "url": "https://implant.agents.university/mcp"
    }
  }
}
```

VS Code has the most complete OAuth implementation of any host here (DCR +
PKCE, tokens in the OS keychain). It was blocked only by the missing
`registration_endpoint`, so it is the first candidate to verify.

## Gemini CLI — prepared

`~/.gemini/settings.json`. Use `httpUrl`; plain `url` means SSE and will not
negotiate against a streamable-HTTP server:

```json
{
  "mcpServers": {
    "implant": { "httpUrl": "https://implant.agents.university/mcp" }
  }
}
```

## Zed — prepared

`~/.config/zed/settings.json`. Zed calls these *context servers*:

```json
{
  "context_servers": {
    "implant": {
      "source": "custom",
      "url": "https://implant.agents.university/mcp"
    }
  }
}
```

## Windsurf — prepared

`~/.codeium/windsurf/mcp_config.json`. Note the key is `serverUrl`:

```json
{
  "mcpServers": {
    "implant": { "serverUrl": "https://implant.agents.university/mcp" }
  }
}
```

## Any stdio-only host — prepared

`mcp-remote` proxies a remote OAuth server over stdio and performs DCR itself:

```json
{
  "mcpServers": {
    "implant": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://implant.agents.university/mcp"]
    }
  }
}
```

Tokens cache in `~/.mcp-auth/`; clear that directory to force
re-authentication.

## Running the local companion on other hosts — advanced

The remote configs above give `bios_load` / `wm_load` only. Folder binding,
one-use activation, and last-good staging need the local companion. It is not
Claude-specific — any host that can spawn a stdio MCP can run it:

```sh
npm install -g @agentuniversity/bios-implant
```

```json
{
  "mcpServers": {
    "implant-local": {
      "command": "node",
      "args": ["<global npm root>/@agentuniversity/bios-implant/dist/local-mcp.mjs"]
    }
  }
}
```

(`npm root -g` prints the global root. The companion is on-demand stdio; it
never runs as a daemon. State lives under `~/.agent-university`.)

---

## What only Claude Code automates

- The **SessionStart boot protocol** fires from a hook. On every other host the
  agent must be told to boot — that is what `AGENTS.md` is for.
- **Skills** (`install` / `connect` / `boot` / `doctor`) load natively in
  Claude Code and Cowork. Codex gets portable variants from the installer;
  bare-MCP hosts get none and follow `AGENTS.md` instead.
- Everything else — activation, binding, staging, health — is the local
  companion, and it runs wherever Node does.
