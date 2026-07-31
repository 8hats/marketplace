# bios-implant

A thin client for the 8hats implant facade. It connects to one remote MCP endpoint
and lets the host perform the OAuth 2.1 authorization code + PKCE flow. No API key,
bootstrap secret, local server, or token file is part of the plugin.

## Install (Claude Code)

```text
/plugin marketplace add 8hats/plugins
/plugin install bios-implant@8hats
/reload-plugins
```

This release targets production: `https://implant.agents.university/mcp`.

## Other hosts

The capability is a plain remote MCP server, so in principle any MCP client can use
it. In practice **Claude Code is the only host that can authenticate today** — the
blocker is the identity provider, not this plugin. See
[`docs/multi-host.md`](../../docs/multi-host.md) for the exact per-host configuration
and what has to change on the IdP to unblock the rest.

## Authenticate

1. Open `/mcp` and select `bios-implant` if Claude Code has not opened the
   browser automatically.
2. Sign in to 8hats and approve the access request.
3. Return to Claude Code. The harness stores and refreshes the OAuth tokens.

The plugin uses the registered public client `bios-implant`, the fixed redirect
URI `http://localhost:8484/callback`, and scopes
`openid offline_access bios:read worldmodel:read worldmodel:write`. `openid` and
`offline_access` cover sign-in and the refresh token; `bios:read` and
`worldmodel:read`/`worldmodel:write` are the facade's per-tool resource scopes
(the issued access token carries only those three). Claude Code owns PKCE, the
callback listener, and refresh-token rotation.

Every field in `.mcp.json` is load-bearing, and none of it is decorative:

- `"type": "http"` — a `url` with no `type` is read as stdio and the server is
  silently skipped.
- `oauth.clientId` — required. The authorization server publishes no
  `registration_endpoint`, so a host cannot register itself dynamically.
- `oauth.callbackPort` — required. `http://localhost:8484/callback` is the only
  redirect URI registered for this client; any other port or path is rejected.
- `oauth.scopes` — required for a refresh token. The facade's protected-resource
  metadata advertises only the three resource scopes, so `openid` and
  `offline_access` have to be pinned here or the session gets no refresh token.

## Use

The facade exposes the agent's BIOS + worldmodel tools. The load-bearing one:

- `bios_load` loads a BIOS body or one of its bundle files for an agent owned by
  the signed-in account.

Example request:

```text
Load the default BIOS for hanuman-demo.
```

The OAuth token is owner-scoped. The `agent_id` remains a tool argument, and the
facade (via the destination service) verifies that the signed-in owner owns that
agent before returning content.

Onboarding a new agent is operator-driven: an owner-scoped `agent_id` is
provisioned for you in the 8hats Registry (agent provisioning) — the plugin has
no self-service `register` tool. Once an `agent_id` exists, activate it with the
Connect flow below.

## Connect an agent

The owner creates the agent in the cabinet and hands over **one line**:

```
follow instructions: https://app.agents.university/setup/<capability>/SETUP.md
```

That is the entire instruction. No variable to export, no sign-in, no browser, no
callback port. The link is one-use and short-lived; the document behind it names
the agent's real `agent_id` and prints a complete command.

The procedure itself is **not repeated here**. It is served fresh with the
document, and the `connect` skill is what reads it — see `skills/connect/SKILL.md`
for the invariants that hold no matter how the server-side flow changes, including
how to repair a lost local selection.

## Verify or recover

- `/mcp` should show `bios-implant` as connected and list its tools.
- If authorization is stale or revoked, choose **Clear authentication** and
  authenticate again in `/mcp`.
- Port `8484` must be free while the browser callback is in progress. Activation
  does not use a callback port at all.

## What this plugin ships

| Component | Path | Portable off Claude Code? |
|---|---|---|
| Remote MCP server | `.mcp.json` | Yes — any MCP client, once auth is possible |
| Session boot protocol | `hooks/hooks.json` → `scripts/boot_protocol.py` | No — Claude Code hooks only |
| BIOS staging | `hooks/hooks.json` → `scripts/stage_bios.py` | No — Claude Code hooks only |
| Connect procedure | `skills/connect/SKILL.md` | Partly — content ports, the loader does not |
| Local identity write | `scripts/connect_agent.py` | Yes — plain `python3`, needs a real path |

On hosts without a hook runner, the boot protocol has to be carried as
instructions instead. The repository's [`AGENTS.md`](../../AGENTS.md) is that
text, in the file most non-Claude hosts already read.
