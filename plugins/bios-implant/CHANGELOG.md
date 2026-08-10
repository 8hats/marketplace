# Changelog

All notable changes to BIOS Implant are documented in this file.

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
