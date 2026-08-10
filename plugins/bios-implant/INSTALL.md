# Local Cowork installation contract

Use Computer Use to open the host Terminal application. On macOS, use Terminal.app or another terminal attached to the host. Do not use an isolated Linux shell, a repo sandbox shell, or a remote terminal. BIOS Implant must inspect and update the real host Claude/Codex installation state.

1. Verify Node.js `>=20` on the host:

   ```sh
   node --version
   ```

2. Run the installer exactly once. An agent can print and follow the packaged install skill with `npx -y @agentuniversity/bios-implant@latest instructions`:

   ```sh
   npx -y @agentuniversity/bios-implant@latest install --yes
   ```

3. Wait for the command to finish. Do not try to authorize OAuth during this step. For Local Cowork, success means the report contains `registration_state: "installed_and_verified"`; the installer has registered and read the plugin back from the active Desktop profile.

4. When native CLI registration completed, run the host-side doctor:

   ```sh
   npx -y @agentuniversity/bios-implant@latest doctor
   ```

   Plain `doctor` checks every detected supported harness on the host. Use `--harness` only when you want to scope doctor to one harness. Install and uninstall keep their own default target semantics.

5. Fully quit and reopen Claude Desktop, then open a new Local Cowork session after install completes.

6. In that new session, run the BIOS Implant `doctor` skill.

7. Complete native OAuth only if the harness prompts for it. In Claude Desktop Local Cowork and Claude Code, never enter a Client ID, callback URL, scope, or other connector setting; the remote MCP discovers and registers OAuth automatically.

8. Obtain the owner-provided one-use setup URL. Give it only to the BIOS Implant `connect` skill—never to the installer or doctor. Change to the exact folder you want BIOS Implant to bind, then run `connect` from that folder.

Success and warning semantics:

- `PASS` means the host-side installer or doctor found the expected local registration state.
- `WARN AUTH_REQUIRED` means local registration is in place, but the host could not yet prove authenticated remote runtime state. Open a new harness session, run the `doctor` skill, and complete native OAuth only if prompted.
- `WARN BINDING_REQUIRED` means install succeeded, but the target workspace is not bound yet. Obtain the owner-provided one-use setup URL, open the intended folder, and give that secret only to the `connect` skill there.
- `WARN RUNTIME_PROBE_REQUIRED` means host-side checks cannot prove authenticated runtime health. Open a new harness session and run the `doctor` skill.
- `FAIL` means the local install or doctor did not complete the expected contract and should be repaired before use.

Exact remediation commands:

- Repair or update all detected harnesses:

  ```sh
  npx -y @agentuniversity/bios-implant@latest install --yes
  ```

- Repair Local Cowork specifically:

  ```sh
  npx -y @agentuniversity/bios-implant@latest install --yes --harness cowork
  ```

- Repair the Claude CLI-managed harness:

  ```sh
  npx -y @agentuniversity/bios-implant@latest install --yes --harness claude
  ```

- Repair Codex only:

  ```sh
  npx -y @agentuniversity/bios-implant@latest install --yes --harness codex
  ```

- Re-run the host-side doctor:

  ```sh
  npx -y @agentuniversity/bios-implant@latest doctor
  ```

  Plain `doctor` checks every detected supported harness. Add `--harness cowork`, `--harness claude`, or `--harness codex` only when you want to limit the check.

`--yes` means noninteractive consent for installer actions. It does not grant OAuth authorization and it does not bypass native harness prompts.

## Manual Install

For direct manual use on a supported host, the same flow applies:

```sh
node --version
npx -y @agentuniversity/bios-implant@latest install --yes
npx -y @agentuniversity/bios-implant@latest doctor
```

Then open a new Claude Desktop, Local Cowork, Claude Code, or Codex session, run the BIOS Implant `doctor` skill, and complete native OAuth only if prompted. To bind a workspace, obtain the owner-provided one-use setup URL and give it only to the `connect` skill from the exact workspace folder you want bound.

No Git checkout, global install, Python runtime, chained shell command, or npm login is required.

## What The Installer Does

The installer detects supported local harnesses and reconciles their native registration state. In version 1, that means:

- Claude Desktop / Local Cowork by default, when present on the host
- Claude Code, when the native CLI is available
- Codex, when the native CLI is available

It installs or reconciles:

- The native plugin registration for `bios-implant@agent-university`
- The local `implant-local` Node stdio MCP
- The remote `implant` MCP registration
- The exact Codex MCP OAuth callback settings when Codex is selected
- The `install`, `connect`, `boot`, and `doctor` skills
- The plugin-native `SETUP.md` handoff for Local Cowork
- The Claude session-start hook
- The Codex portable boot fallback
- The local Agent University catalog snapshot under `AGENT_UNIVERSITY_HOME` or `~/.agent-university`

For Local Cowork, the installer resolves the active Claude Desktop account and organization profile, uses Claude CLI Cowork mode against that profile, keeps npm downloads in a package-owned cache, and verifies `bios-implant@agent-university` from the native Cowork plugin list. It does not attach a `.plugin` file to a chat and does not edit Claude Desktop's internal JSON files directly. Local Cowork automatic installation currently requires Claude CLI `2.1.220` or newer.

The installer does not install the remote service. It never launches a browser, never copies credentials, and never performs OAuth outside the harness.

## Update And Repair

Update and repair use the same command as first install:

```sh
npx -y @agentuniversity/bios-implant@latest install --yes
```

Authorized organizations can also distribute the private repository through a managed Cowork marketplace. Public end users should use the npm command; it requires neither repository access nor a local Git checkout.

The command is intended to be idempotent. Re-running it is the supported way to reconcile drift, update the packaged payload, or repair harness registration.

For version 1, this canonical `npx ...@latest` command is the only supported update mechanism. Optional direct or global binaries run their installed package version; they do not query the registry or re-execute a newer release.

## Harness Selection

Use `--harness` to limit the target set:

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --harness auto
npx -y @agentuniversity/bios-implant@latest install --yes --harness all
npx -y @agentuniversity/bios-implant@latest install --yes --harness cowork
npx -y @agentuniversity/bios-implant@latest install --yes --harness claude
npx -y @agentuniversity/bios-implant@latest install --yes --harness codex
```

Notes:

- `auto` is the default; when Claude Desktop is present it selects Local Cowork only, otherwise it selects detected CLI harnesses
- `all` expands to Local Cowork, Claude Code, and Codex
- `cowork` targets Claude Desktop / Local Cowork specifically
- Remote Cowork is unsupported in version 1

## Human Output, Reports, JSON, Timeout, And Verbose

Operational commands use human mode by default. In a terminal they show a loader, then a concise English result and one actionable next step. The full JSON result is written automatically to `~/.agent-university/bios-implant-reports` with private permissions, while terminal output remains sanitized. The terminal prints a `file://` report link. Failures use an `Error report:` link so diagnostics can be shared without copying terminal noise.

Preview planned actions without changing harness state:

```sh
npx -y @agentuniversity/bios-implant@latest install --dry-run --json
```

Useful options:

- `--dry-run` previews reconciliation work
- `--json` keeps stdout as machine-readable JSON with no loader and also saves the same report to disk
- `--timeout <seconds>` adjusts native CLI command timeouts
- `--verbose` keeps full paths and detailed output

Set `BIOS_IMPLANT_REPORT_DIR` to choose another report directory. Human mode never prints the full JSON payload.

Example:

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --json --verbose --timeout 30
```

## Doctor

Host-side doctor checks local package state, harness registration state, and remote reachability:

```sh
npx -y @agentuniversity/bios-implant@latest doctor
```

Use the host-side doctor after install and whenever you need to confirm local registration. Plain `doctor` checks every detected supported harness; add `--harness` to scope it. It cannot prove authenticated runtime health on its own. Always finish by opening a new harness session and running the BIOS Implant `doctor` skill.

Host doctor inspects Cowork Desktop state separately and never treats a Claude Code CLI plugin as proof of Cowork installation.

For Codex, the installer pins a dedicated loopback callback in `CODEX_HOME/config.toml` or `~/.codex/config.toml`; it preserves a conflicting user value instead of overwriting it. The host still cannot always observe session-owned OAuth credentials. Open a new Codex session and run the `doctor` skill; complete native OAuth only if Codex prompts for it. If authorization is still required, run `codex mcp login implant`. If you need to reconcile Codex registration or callback policy again, rerun:

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --harness codex
```

## Uninstall

Remove harness registrations:

```sh
npx -y @agentuniversity/bios-implant@latest uninstall --yes
```

Attempt to remove package-owned unchanged local state too:

```sh
npx -y @agentuniversity/bios-implant@latest uninstall --yes --purge-data
```

Uninstall preserves user data by default. It removes Codex callback lines only when installer ownership and their exact current values are both proven. `--purge-data` is conservative: it only removes state the installer can prove is package-owned and unchanged from the recorded digest. Shared marketplace/catalog state may be retained when the native CLIs cannot prove safe removal.

## Privacy And Security

- BIOS Implant stores local installer, catalog, and binding data under `AGENT_UNIVERSITY_HOME` or `~/.agent-university`
- OAuth remains in the native harness credential store
- The installer never opens a browser, never copies credentials, and never exports tokens
- The local `implant-local` MCP runs as on-demand Node stdio, not as a background daemon

## Troubleshooting

Node too old:

```sh
node --version
```

Install fails because no supported harness is detected:

- Install or expose Claude Desktop / Local Cowork, Claude Code, or Codex on the host
- Rerun:

  ```sh
  npx -y @agentuniversity/bios-implant@latest install --yes
  ```

Doctor reports `AUTH_REQUIRED`:

- Open a new harness session
- Run the BIOS Implant `doctor` skill
- Complete native OAuth only when prompted

Doctor reports `BINDING_REQUIRED`:

- Obtain the owner-provided one-use setup URL
- Open the intended project folder in the harness
- Give the one-use setup URL only to the BIOS Implant `connect` skill from that exact folder; never pass it to the installer or doctor

Doctor reports `RUNTIME_PROBE_REQUIRED`:

- Open a new harness session
- Run the BIOS Implant `doctor` skill

Codex does not boot BIOS automatically:

- This is expected in version 1
- Run the BIOS Implant `boot` skill manually at session start or before substantive work
