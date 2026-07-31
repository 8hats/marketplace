# AGENTS.md — 8hats implant boot protocol

This file exists for hosts that have no hook runner. Codex, Cursor, Zed and
Gemini CLI read `AGENTS.md`; Claude Code does not need it, because the
`bios-implant` plugin injects the same protocol from a `SessionStart` hook and
resolves the agent id from the local store first.

If you are on such a host, copy this file to your project root (or
`~/.codex/AGENTS.md` for a global rule) and replace `<AGENT_ID>` below with the
`agent_id` your owner provisioned.

Prerequisite: the `implant` MCP server must be configured and authenticated. See
[`docs/multi-host.md`](docs/multi-host.md) — note that on hosts other than Claude
Code, authentication is currently blocked at the identity provider.

---

## Boot protocol

Before any substantive work in this session, load your current BIOS, then your
worldmodel.

1. Call the `bios_load` tool with `agent_id="<AGENT_ID>"`.

2. On success, treat the returned body as your BIOS for this session — it defines
   who you are and how you work.

3. Otherwise read `structuredContent.code` and follow EXACTLY ONE of these — never
   invent a repair, and never re-run activation:

   - `not_found` — you are registered, but your BIOS has not been published yet.
     This is normal and expected. Do NOT re-activate, do NOT reinstall, do NOT ask
     for a new install link. Keep working without a BIOS; it will be picked up
     automatically on a later session.
   - `unauthorized` — if `structuredContent.reason` is `unknown_owner` or
     `not_owner`, re-authenticating cannot help: report it to your owner and keep
     working. Otherwise complete the OAuth sign-in for the `implant` server EXACTLY
     ONCE and retry; if it recurs, report it to your owner and keep working.
   - `unavailable` — the service is temporarily unreachable. Say plainly that no
     local last-good copy exists and continue without a BIOS — do NOT announce a
     degraded boot with nothing loaded.
   - any other code, including `bad_shape` and `too_large` — this is a defect in
     the install, not something this session can repair. Report the exact code to
     your owner and keep working without a BIOS.

4. Then call `wm_load` (no arguments) to load your worldmodel bundle. Its agent is
   derived from your token, so it takes no `agent_id`. On success, treat the bundle
   as your current world knowledge for this session.

5. `wm_load` has THREE outcomes, and one of them is not what it looks like:

   - `not_found` — your worldmodel has not been published yet. Same as BIOS: wait
     quietly, change nothing, keep working.
   - `unauthorized` — if step 1 returned success or `not_found`, your token is
     provably valid (both tools use the SAME bearer), so this means your worldmodel
     binding is missing, NOT an auth problem. Do NOT re-authenticate, do NOT
     re-activate, do NOT ask for a new install link. Report "worldmodel not bound"
     to your owner and keep working. Only if step 1 was ALSO `unauthorized` should
     you do the single re-authentication described above.
   - anything else — report the code to your owner and keep working.

Do not skip these steps, and keep them in this order: the BIOS result is what tells
you how to read the worldmodel result.

---

## What you do not get on this host

Claude Code stages every successful `bios_load` to a local store, so a later
session can fall back to the last-good BIOS when the service is down. No other
host does this. On `unavailable`, you have nothing cached — say so rather than
implying a BIOS was loaded.

Activation (binding an `agent_id` to an owner) is a separate, one-time flow driven
by a one-use link the owner hands you. It is described in the served document
itself, not here. The local write step it delegates to requires
`scripts/connect_agent.py` from the `bios-implant` plugin, invoked with a real
path on hosts that have no `${CLAUDE_PLUGIN_ROOT}`.
