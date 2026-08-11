# Changelog

All notable changes to BIOS Implant are documented in this file.

## 1.0.20 - 2026-08-11

Everything here traces to the MEOW-20 onboarding transcript (2026-08-11).

- `local_activate` absorbs transient network failures itself: three attempts with 300/900ms
  backoff for the setup fetch and the activation request, and the error message now names the
  concrete cause (`ECONNREFUSED`, `ENOTFOUND`, …) and the attempt count. MEOW-20's first
  activation died on one hiccup and surfaced a scary failure whose whole remedy was "run it
  again 24 seconds later"
- An activation TIMEOUT is deliberately NOT auto-retried and gets its own code
  (`ACTIVATION_TIMEOUT`, `link_spent: null`): the request may have reached the registry with
  only the response lost, and a blind resend of a one-use capability reads back as "spent",
  turning a successful activation into a reported failure. The message routes the operator
  through a state check instead. `BIOS_IMPLANT_ACTIVATION_TIMEOUT_MS` makes the contract
  testable
- Remote authorization instructions now name the host plugin UI as THE action — Claude Code:
  `/plugin` → Installed → bios-implant → server `implant` → Authenticate; Claude Desktop: the
  plugin browser's Authorize — in boot (where an unauthorized `bios_load` surfaces) and in
  connect's REMOTE-AUTH. Both skills ban calling the harness-injected `authenticate` tool and
  relaying its raw `…/auth?…` URL into chat: that URL's PKCE challenge and localhost callback
  belong to the one flow that minted it, and MEOW-20's owner authorized through `/plugin`,
  which minted its own client and port — the pasted URL was already a challenge that could
  never complete

## 1.0.19 - 2026-08-11

Everything in this release traces to one onboarding (agent `TVP_TEST_2-paired-2026-08`, 2026-08-10) that activated cleanly and never booted.

- Hold agent ids and labels to the alphabet bios-server actually serves — Latin letters, digits, hyphen, 64 chars max. The wider local rule bound ids the server 422s on every `bios_load`, after the one-use link was spent. Tool schemas derive from one shared constant; cross-repo parity tests pin byte-identity with app-v2's creation gate and behavioural identity with bios-server's slug
- Refuse a setup document naming an unservable agent id as `AGENT_ID_UNSERVABLE` BEFORE the activation request — the link stays unspent and the message names the remedy (recreate the agent), instead of activating into a permanently dead binding
- `local_activate` now finishes the job: it chains the folder binding for the current workspace root and reports `registry_bound` and `folder_bound` apart. The registry's bare `bound: true` had taught callers to stop with the workspace unbound and nothing left to retry
- Skills carry `allowed-tools`, so a first-run activation is not denied by the harness permission classifier before the owner ever sees a prompt
- connect gains the two missing legs: REMOTE-AUTH (native OAuth first; the `script -q /dev/null claude mcp login …` recovery for no-TTY surfaces) and a literal RESTART step — the session tool registry is fixed at start, so mid-session authorization never surfaces `bios_load` in the running session
- doctor and boot read remote codes as vocabulary: `bad_shape` = unservable id (never auth — do not re-login), `unauthorized` = token vs ownership, `not_found` = calm waiting state; doctor also names the false signal where `claude mcp list` prints `connection timed out after 30000ms` for a server that is really answering 401

- boot passes the bound `agent_id` to `wm_load` — the authenticated selector that resolves an owner with several agents, for whom the parameterless worldmodel path answers a deterministic `unauthorized`

Server-side halves released alongside, outside this package: bios-server names every 422's reason in `x-bios-error`; implant-mcp forwards it as `bad_shape: <reason>` and carries the `agent_id` selector on every wm tool; worldmodel verifies the selector against the token's subject.

## 1.0.18 - 2026-08-11

- Boot status now follows whether the agent HAS the knowledge its BIOS names, not whether `wm_load` answered: a BIOS that carries its own knowledge reaches `LOADED` without the worldmodel service, instead of reporting itself degraded while holding a complete firmware
- Forbid credential archaeology during boot — no keychain reads, no token or OAuth config files; report the refusal and the recovery action instead. An opaque `unauthorized` had sent a booted agent reading the OS keychain for the host's OAuth credentials
- Pin both rules in the bootstrap contract tests

## 1.0.17 - 2026-08-10

- Report one version everywhere: the plugin manifest, the package manifest, and the runtime constant were 1.0.16 / 1.0.15 / 1.0.15, so the companion announced itself over MCP as `implant-local 1.0.15` while the host showed 1.0.16
- Pin the three version sources against each other in the bootstrap contract tests, so a release that bumps only the plugin manifest fails instead of shipping
- No behaviour change: `dist/local-mcp.mjs` is a shim over `src/`, so the runtime picks the corrected constant up without a build step

Server-side fixes released the same day, outside this package: the remote MCP now returns the BIOS body in the structured payload instead of only in the text block, which is what made `bios_load` look like it returned an empty body (`8hats/implant-mcp` PR #5, `8hats/bios-server` PR #10).

## 1.0.16 - 2026-08-10

- Retire the npm channel from every install surface: README, INSTALL.md, SETUP.md, and the install skill teach only the 8hats/plugins marketplace
- Point repair and update guidance at the host's own plugin machinery instead of the retired npx installer
- Pin the marketplace-only contract in the bootstrap tests, with a guard against any runnable npx command returning

## 1.0.15 - 2026-08-10

- Move one-use setup activation from the Cowork Linux sandbox to the native Local Companion
- Advertise honest MCP safety annotations so Auto mode can run read-only local health probes
- Keep activation URLs and capabilities out of Local Companion results and diagnostics
- Cover the packaged symlink entrypoint and real host-network activation path without mocks
- Stay silent on client notifications and accept the spec `notifications/initialized` name
- Restore the `$boot`, `$connect`, and `$doctor` Codex prompt references
- Ask for the full one-use setup URL in every surface that used to say "or capability"

## 1.0.14 - 2026-08-07

- Keep the local MCP entrypoint alive when Claude Desktop stages the plugin through a symlink
- Make the doctor use actual callable capability probes instead of duplicate connector display status
- Render the in-session doctor result as a compact emoji health table with explicit evidence
- Cover the Cowork symlink launch path with a real child-process JSON-RPC integration test

## 1.0.13 - 2026-08-04

- Remove embedded OAuth Client ID, callback, and scope fields from the Claude/Cowork plugin manifest
- Use the remote MCP's OAuth discovery and automatic public-client registration so users only approve native sign-in
- Make doctor reject regressions that reintroduce user-visible Claude connector settings
- Document that Claude users must never configure OAuth fields manually

## 1.0.12 - 2026-08-04

- Replace the broken Cowork file-attachment bootstrap with native Local Cowork plugin registration
- Resolve the active Claude Desktop account and organization profile without editing Desktop state directly
- Install from the public npm catalog through Claude CLI Cowork mode with a package-owned npm cache and no Git dependency
- Verify the plugin from the native Cowork plugin list before reporting installation success
- Require Claude CLI 2.1.220 or newer for the automatic Local Cowork compatibility path
- Update installer, doctor, setup skill, human output, and regression coverage to remove the false `.plugin` attachment flow

## 1.0.11 - 2026-08-04

- Clarify that the public distribution path is npm and does not require repository access or Git
- Keep the private GitHub marketplace manifest available for authorized organization distribution only

## 1.0.10 - 2026-08-04

- Separate Claude Desktop Local Cowork registration from Claude Code registration
- Always build a native `.plugin` bundle for Cowork and open an official `claude://cowork/new` bootstrap with that bundle attached
- Report `COWORK_CONFIRMATION_REQUIRED` instead of claiming a Claude Code CLI registration installed Cowork
- Inspect Cowork Desktop state read-only in host doctor and report an unobserved plugin as a warning rather than a false success
- Add a GitHub-compatible marketplace manifest at the repository root
- Make `--harness all` include Local Cowork, Claude Code, and Codex
- Add `--no-open` for preparing a Cowork bootstrap without launching Desktop

## 1.0.9 - 2026-08-04

- Replace the terse human install result with a visually separated status dashboard using emoji and TTY colors
- Show each harness in an aligned installation table with its installed state and remaining setup work
- Render numbered next-action blocks with highlighted commands, expected outcomes, and security guidance while keeping JSON output unchanged
- Separate technical report links from the human summary and keep raw diagnostic details in the private report file

## 1.0.8 - 2026-08-04

- Pin Codex MCP OAuth to an installer-managed exact loopback callback compatible with the static `bios-implant` client
- Accept the current Codex CLI nested MCP transport schema while treating hidden auth fields as runtime probe warnings
- Preserve conflicting user callback settings instead of overwriting them, and remove only exact package-owned settings on uninstall
- Add callback derivation, reconciliation, ownership, uninstall, and installer integration coverage

## 1.0.7 - 2026-08-04

- Replace repetitive human `doctor` sections with one aligned multi-harness status table
- Add color-coded PASS, WARN, and FAIL states for interactive terminals while honoring `NO_COLOR` and keeping non-TTY and JSON output free of ANSI codes
- Present follow-up work as named action blocks with highlighted commands, expected outcomes, and a distinct security warning for one-use setup capabilities

## 1.0.6 - 2026-08-04

- Make host `doctor` check every detected supported harness by default instead of preferring Cowork when Claude Desktop is present
- Replace the generic human doctor summary with a detailed per-harness English report while keeping persisted JSON and `--json` stdout unchanged
- Update CLI regression coverage and command examples to use plain `doctor` for the default host check

## 1.0.5 - 2026-08-03

- Fix Claude/Cowork uninstall so an exact user-scope BIOS Implant installed by an earlier package version can be removed safely
- Separate canonical plugin identity checks used by uninstall from current-version health checks used by install and update verification
- Add a regression test for uninstalling an older canonical Claude plugin through the native CLI

## 1.0.4 - 2026-08-03

- Add English human-mode progress, concise status summaries, and actionable next steps for install, doctor, and uninstall
- Persist sanitized JSON reports with private permissions and print `file://` links, including dedicated error-report links on failure
- Preserve clean `--json` automation output while saving the same structured payload to disk
- Update the Local Cowork bootstrap and install skill to read saved reports instead of exposing raw JSON in the terminal

## 1.0.3 - 2026-08-03

- Add the required marketplace `owner` object so current Claude CLI releases accept the generated Agent University catalog
- Extend doctor and regression coverage to validate the owner contract in both bundled and materialized marketplace files

## 1.0.2 - 2026-08-03

- Added the public Local Cowork bootstrap at `https://app.agents.university/bios-implant/SETUP.md` so an unauthenticated agent can fetch one URL before BIOS authorization exists
- Moved the npm README Local Cowork handoff to lead with that absolute public setup URL, with the terminal install flow kept as fallback

## 1.0.1 - 2026-08-03

- Added an autonomous Local Cowork `install` skill that drives the real host Terminal, interprets installer and doctor JSON, and asks the user only for native permissions, OAuth approval, or binding inputs
- Added the plugin-native `SETUP.md` handoff recommended for Cowork MCP setup
- Exposed the agent bootstrap contract directly in the npm README so Cowork can discover it from Registry metadata before the plugin exists locally
- Made `instructions` print `skills/install/SKILL.md` with `INSTALL.md` as a compatibility fallback
- Added an app-only Claude Desktop fallback that prepares an uploadable `.plugin` bundle when Claude Code CLI is unavailable
- Changed automatic Claude selection to prefer the Local Cowork target whenever Claude Desktop is present

## 1.0.0 - 2026-08-03

- Defined the `@agentuniversity/bios-implant` `1.0.0` npm installer and runtime contract for one-command host setup with `npx`
- Standardized the canonical install flow as `npx -y @agentuniversity/bios-implant@latest install --yes`
- Established native Claude Desktop / Local Cowork, Claude Code, and Codex reconciliation as the default installer scope
- Added the packaged local `implant-local` Node stdio MCP and the native registration contract for the remote `implant` MCP
- Defined the portable `connect`, `boot`, and `doctor` skill set, plus the Claude session-start hook and Codex manual boot fallback
- Set the local state contract under `AGENT_UNIVERSITY_HOME` or `~/.agent-university`, including conservative uninstall and digest-checked purge behavior
- Formalized the split between local installation success and later in-harness OAuth and runtime verification
