---
name: connect
description: Activate (connect) this agent so its BIOS and worldmodel resolve — fetch the SETUP.md document the owner handed you and follow it exactly. Triggers EN+RU ("connect me", "activate this agent", "follow instructions <URL>", "активируй агента", "подключи агента", "вот ссылка на установку").
---

# Connect this agent

## When to invoke

EN triggers:
- "connect me" / "connect this agent" / "activate this agent"
- the owner pastes a line of the form `follow instructions: <URL>`
- the owner pastes a URL ending in `/SETUP.md`

RU triggers:
- "активируй агента" / "подключи агента" / "вот ссылка на установку"

When NOT to invoke: a BIOS that returns `not_found`. That is a waiting state, not a
missing activation — see invariant 5.

## Invariants

These hold regardless of how the server-side flow changes. Everything about the registry —
the activation step, the endpoint, the failure table — lives in the served document, in
exactly one place. The one thing that lives here is the local write step, because its
command depends on where this plugin is installed and the server cannot know that.

1. **The link is the whole instruction.** The owner hands you one URL and nothing else.
   No environment variable to export, no sign-in, no browser, no callback port. If you
   find yourself about to ask the owner for a second thing during activation, you have
   misread the document. Two things are outside that rule and are not second instructions:
   this plugin being installed (the owner's prerequisite — you can read this file, so it is
   already met), and asking for your `agent_id` when you are repairing a lost local identity
   rather than activating, since the owner can read it off the cabinet.

2. **The document is self-sufficient and authoritative.** It names your real `agent_id`
   and prints a complete command. Run it exactly as written. Do not reconstruct it from
   memory, do not substitute an endpoint you remember, and do not "fix" it.

3. **Activation happens once and is irreversible.** The first owner to activate an agent
   wins; there is no unbind path in code. Never activate an agent you were not handed.

4. **A failed activation does not burn the link.** The registry verifies the capability,
   binds, and only then spends it — so a failure before `200` leaves the same link usable
   and never requires a fresh one. That does **not** mean retry blindly: the document's
   table marks two outcomes non-retryable (`REGISTRY_E_SEED_UNCONFIGURED` and
   `REGISTRY_E_OWNER_UNRESOLVED`), and both mean the deployment is misconfigured — stop and
   tell an operator, because a fresh link fails the same way. Read the table's
   retryable column before repeating anything. Once it has returned `200`, delete the
   document: it has no second use.

5. **A `not_found` BIOS is a waiting state.** It means no BIOS has been published for you
   yet. Do not re-activate, do not reinstall, do not ask for a new link. A later session
   will pick it up automatically.

6. **Re-running the local write is the repair; re-activating never is.** If a machine's
   local selection is lost, re-run the local write step below with your `agent_id`. It
   makes no network call, it is idempotent, and it needs neither a link nor a capability.

## Workflow

Fetch the URL you were given and **follow it exactly**. It is served fresh and it is the
only source of truth for the procedure.

If you were given only an `agent_id` and no URL, ask the owner for the setup link from the
cabinet. There is no offline procedure: activation needs the registry, and a cached copy
of the steps would only be a second copy that can drift.

## The local write step

The document's activation step is complete in itself. Its local-write step is not, and
deliberately so: it sends you here, because the invocation depends on where this plugin is
installed and the server cannot know that. This section is that command. It is the only
part of the procedure this skill owns — everything about the registry stays in the
document, in one place.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/connect_agent.py" \
  --write-only --agent-id <your agent_id>
```

`${CLAUDE_PLUGIN_ROOT}` above is already an absolute path by the time you read it — Claude
Code substitutes it into this file when it loads the skill, so copy the line as it appears
to you. Do NOT retype the literal `${CLAUDE_PLUGIN_ROOT}` into a shell: it is not an
environment variable, and there it expands to nothing.

Run it from the directory you want this agent bound to — normally the repository root. The
in-repo marker is written to `./CLAUDE.md` relative to your current directory, and the boot
protocol looks for it in the session's working directory.

`<your agent_id>` is the one the document named, verbatim. `--write-only` is accepted and
ignored — local writes are all this script does — and is kept because the boot protocol
prescribes the identical flags for repair, and the two must not drift apart.

The registry base decides which facade this identity points at, and it is resolved
`--registry-url` → `BIOS_REGISTRY_URL` → prod. So **omitting the flag is not the same as
choosing prod**: on a machine where `BIOS_REGISTRY_URL` is set, the environment wins
silently.

Check it first (`echo $BIOS_REGISTRY_URL`) and compare it with the host in the activation
URL the document gave you. If they disagree — or if it is unset and the document was
staging — pass the host from the document explicitly:

- staging → `--registry-url https://registry.staging.agentsuniversity.io`
- prod → `--registry-url https://registry.agents.university`

It makes no network call, and it writes four things: the agent's `identity.json`, the
store's `default` selector, an `@path` block in your user `CLAUDE.md`, and a `BIOS:managed`
marker in the repository's `CLAUDE.md` (suppress that last one with `--no-repo-marker`).

Re-running it is safe, and it is the repair for a lost local selection — but know what it
does and does not restore. `identity.json` and the `default` selector are rewritten every
time. The two `CLAUDE.md` blocks are written **once per agent**: if one is missing it is
restored, and if one is present but stale or hand-edited it is left alone and the command
still reports success. Repairing those means removing the old `BIOS:managed` block first.
Never hand-write any of these four artefacts.

## Reading the outcome

The command prints the response body, then the HTTP status on its own last line. The
document carries the full status table; two cases are worth knowing before you read it:

- `200` — bound. Continue to **The local write step** above, then start a new session.
- `404` — unknown, expired, or already-spent, and deliberately indistinguishable. Ask the
  owner for a fresh link; nothing you can do locally recovers it.

Anything else: read the document's table rather than guessing, and honour its
retryable/non-retryable column instead of retrying blindly.
