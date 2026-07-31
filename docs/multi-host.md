# Using these plugins outside Claude Code

Every plugin in this marketplace is built the same way: the capability is a
**remote MCP server**, and the plugin is a thin wrapper that registers it, adds a
skill, and wires host-specific hooks. The MCP server is the portable part. The
plugin format is not.

So the question for any other host is never "does it support Claude Code
plugins" — none of them do. It is: **can this host authenticate to the server?**

## The honest status, as of 2026-07-31

Claude Code is the only host that can connect today. This is a property of the
8hats identity provider, not of the marketplace or the plugin.

`bios-implant` talks to `https://implant.agents.university/mcp`, which delegates
authentication to `https://id.agents.university`. Two facts about that
authorization server decide everything below, and both are directly observable:

```console
$ curl -s https://id.agents.university/.well-known/oauth-authorization-server | jq '.registration_endpoint'
null
```

1. **No `registration_endpoint`.** The server does not implement RFC 7591 Dynamic
   Client Registration, and does not advertise Client ID Metadata Documents. A
   host cannot register itself as an OAuth client on the fly — which is exactly
   how Cursor, VS Code, Codex, Gemini CLI and the hosted Claude connectors all
   expect to obtain a `client_id`.

2. **The `bios-implant` client has exactly one registered redirect URI**, and it
   is matched literally:

   | `redirect_uri` presented to `/auth` | Result |
   |---|---|
   | `http://localhost:8484/callback` | `303` — accepted |
   | `http://127.0.0.1:8484/callback` | `400` — rejected |
   | `http://localhost:33418/callback` | `400` — rejected |
   | `http://localhost:8484/oauth/callback` | `400` — rejected |
   | `https://claude.ai/api/mcp/auth_callback` | `400` — rejected |

Claude Code succeeds because the plugin pins both halves — `clientId:
"bios-implant"` and `callbackPort: 8484` — producing that one accepted URI.

The consequences are worth stating plainly rather than discovering them in a
support thread:

- **Hosted surfaces (Claude apps / Cowork custom connectors) cannot connect.**
  Their callback is an Anthropic-hosted HTTPS URL, and they rely on DCR. Both
  conditions fail.
- **The usual universal fallback does not rescue this.** `mcp-remote` can pin a
  static client with `--static-oauth-client-info`, but its redirect path is
  `/oauth/callback`, which the IdP rejects on any port.
- **Hosts that pick a random loopback port cannot connect**, even with the right
  client id.

### What would unblock the rest

One of these, on `8hats/auth` — not in this repository:

1. **Enable RFC 7591 Dynamic Client Registration.** Broadest fix: nearly every
   host below starts working generically, with no per-host registration.
2. **Add redirect URIs to the `bios-implant` client** — at minimum
   `http://127.0.0.1:8484/callback` and `http://localhost:8484/oauth/callback`
   (the `mcp-remote` path), which together cover most desktop hosts.
3. **Register a separate public client per host family**, including the hosted
   Claude callback for Cowork.

Until one of those lands, treat the configurations below as *prepared and
verified-as-syntax*, not as working installs.

---

## Claude Code — works today

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
```

Then `/mcp` → `bios-implant` → authenticate. This is the only path that gets the
session boot protocol and BIOS staging, because those are hooks.

Non-interactive equivalent, for provisioning a fleet via `settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "8hats": { "source": { "source": "github", "repo": "8hats/plugins" } }
  },
  "enabledPlugins": { "bios-implant@8hats": true }
}
```

## Claude Cowork / Claude desktop & web connectors — blocked on the IdP

The mechanism is Settings → Connectors → *Add custom connector* → the server URL:

```
https://implant.agents.university/mcp
```

This is the correct instruction and it will fail at the redirect check until the
hosted callback is registered or DCR is enabled. Do not hand this to a user as a
working step yet.

Skills are the portable half of the plugin — `SKILL.md` is a shared format across
the Anthropic stack. Hooks and the Python scripts are not portable: a hosted
surface has no hook runner and no local filesystem, so the local identity write
has no meaning there.

## OpenAI Codex — blocked on the IdP

`~/.codex/config.toml`:

```toml
[mcp_servers.implant]
url = "https://implant.agents.university/mcp"
```

```console
$ codex mcp add implant --url https://implant.agents.university/mcp
$ codex mcp login implant
```

`codex mcp login` performs authorization-code + PKCE with Dynamic Client
Registration. With no `registration_endpoint`, it cannot obtain a `client_id`.

Codex has no hooks and no `SKILL.md` loader. It does read `AGENTS.md` — see the
[repository `AGENTS.md`](../AGENTS.md) for the boot protocol in a form Codex will
actually load.

## Cursor — blocked on the IdP

`~/.cursor/mcp.json` (or `<repo>/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "implant": { "url": "https://implant.agents.university/mcp" }
  }
}
```

## VS Code + GitHub Copilot — blocked on the IdP

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

VS Code has the most complete OAuth implementation of any host here (DCR + PKCE,
tokens in the OS keychain). It is blocked only by the missing
`registration_endpoint`, so it would be the first to work if option 1 above is
taken.

## Gemini CLI — blocked on the IdP

`~/.gemini/settings.json`. Use `httpUrl`; plain `url` means SSE and will not
negotiate against a streamable-HTTP server:

```json
{
  "mcpServers": {
    "implant": { "httpUrl": "https://implant.agents.university/mcp" }
  }
}
```

## Zed — blocked on the IdP

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

## Windsurf — blocked on the IdP

`~/.codeium/windsurf/mcp_config.json`. Note the key is `serverUrl`:

```json
{
  "mcpServers": {
    "implant": { "serverUrl": "https://implant.agents.university/mcp" }
  }
}
```

## Any stdio-only host, once redirect URIs are added

`mcp-remote` proxies a remote OAuth server over stdio. It becomes viable the
moment `http://localhost:<port>/oauth/callback` is a registered redirect URI:

```json
{
  "mcpServers": {
    "implant": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://implant.agents.university/mcp", "8484",
        "--static-oauth-client-info", "{\"client_id\":\"bios-implant\"}"
      ]
    }
  }
}
```

Tokens cache in `~/.mcp-auth/`; clear that directory to force re-authentication.

---

## What no other host gets, regardless of auth

Claude Code hooks have no equivalent anywhere else. On every other host:

- The **SessionStart boot protocol** does not fire. The agent must be told to
  call `bios_load` itself — that is what `AGENTS.md` is for.
- **BIOS staging** (`PostToolUse`) does not fire, so there is no local last-good
  BIOS to fall back on when the service is unreachable.
- `${CLAUDE_PLUGIN_ROOT}` does not exist. `scripts/connect_agent.py` still runs
  under plain `python3`, but it must be invoked with a real path.
