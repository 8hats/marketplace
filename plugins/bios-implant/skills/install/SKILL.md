---
name: install
description: Install, update, or repair Agent University BIOS Implant in Claude Desktop Local Cowork by driving the real host Terminal and verifying the result. Use when the user asks to install or update BIOS Implant, says BIOS is missing or broken, or pastes the npm command for @agentuniversity/bios-implant into a local Cowork session.
---

# Install BIOS Implant

Complete the host-local installation autonomously. Keep working through all observable steps and ask the user only for a platform permission, an unavailable prerequisite, native OAuth approval, an exact workspace folder, or an owner-provided one-use setup URL.

## Boundaries

- Require Claude Desktop Local Cowork. Treat Remote Cowork as unsupported and ask the user to open a Local Cowork session.
- Use Computer Use to operate the real host Terminal. On macOS, open Terminal.app. Never run installation in a Cowork sandbox, repository shell, remote shell, or web-fetch tool.
- Request permission once before opening the host Terminal or changing Claude/Codex configuration if permission has not already been granted. Let native Computer Use, terminal, npm, and OAuth permission prompts remain visible for the user to approve.
- Default to the `cowork` harness. Do not ask the user to choose a harness unless they explicitly request Claude Code or Codex too.
- Do not require Git, a repository checkout, npm login, a global install, Python, or a background daemon.
- Never ask for OAuth tokens, passwords, npm credentials, or browser cookies in chat.
- Never send a one-use setup URL to the installer or doctor. Give it only to the installed `connect` skill.

## Workflow

### 1. Establish the host boundary

1. Confirm from available session context that this is Local Cowork. Ask only if the boundary cannot be observed.
2. Request the user's approval for Computer Use and local Claude configuration changes when the platform has not already collected it.
3. Open the host Terminal with Computer Use and keep the installation there. Do not substitute a registry page fetch for command execution.

### 2. Check the only prerequisite

Run this command in the host Terminal:

```sh
node --version
```

- Continue without asking when Node.js is version 20 or newer.
- If Node.js is missing or older than 20, explain the exact blocker and ask permission to install or update Node.js. Resume automatically after the prerequisite is satisfied.
- Do not ask any BIOS, OAuth, or workspace questions before the local payload is installed.

### 3. Install in the background

Run exactly this command in the same host Terminal:

```sh
npx -y @agentuniversity/bios-implant@latest install --yes --harness cowork
```

Wait for the English final status and next step without asking the user to copy commands or interpret logs. Read the JSON report from the exact `Report:` or `Error report:` file URL printed by the CLI. Never ask the user to open or interpret that report.

- Treat `status: "PASS"` as a successful local installation.
- Treat `status: "WARN"` with `AUTH_REQUIRED`, `BINDING_REQUIRED`, or `RUNTIME_PROBE_REQUIRED` as a successful local installation with remaining in-harness setup.
- For Local Cowork, require `harnesses[].details.registration_state: "installed_and_verified"`. This proves the installer read the plugin back from the active Desktop profile.
- Treat `status: "FAIL"` or a nonzero installer `exit_code` as failure. Follow the returned `next_steps` once, then rerun the same install command once to verify repair.
- Do not loop indefinitely. After one failed repair attempt, stop and report the exact failing check and command output needed for diagnosis.

### 3A. Verify native Cowork installation

Claude Code plugin registration is separate and never proves that the plugin is installed in Cowork.

1. Confirm `harnesses[].details.registration_state` is `installed_and_verified`.
2. Confirm the recorded command uses Claude's Cowork mode and the report names the resolved Desktop profile.
3. Run host doctor, which checks Cowork state separately from Claude Code and reports `COWORK_PLUGIN_OBSERVED` when the Desktop state is visible.
4. Fully quit and reopen Claude Desktop so its UI reloads the reconciled plugin state.
5. Start a new Local Cowork session and confirm that `doctor`, `connect`, and `boot` are available.

### 4. Verify host registration

Run exactly this command after the Cowork confirmation or native Claude Code/Codex registration:

```sh
npx -y @agentuniversity/bios-implant@latest doctor
```

Read the saved JSON report from the printed file URL instead of treating process exit alone as health:

- `PASS` means host registration is ready.
- `WARN` with `AUTH_REQUIRED`, `BINDING_REQUIRED`, or `RUNTIME_PROBE_REQUIRED` means installation succeeded and the remaining step belongs in a new Local Cowork session.
- `FAIL` means installation is not complete. Run the install command once more, then repeat doctor once.
- Doctor exit code `2` with JSON `status: "WARN"` is not an installation failure.

### 5. Hand off to a fresh session

1. Tell the user that local installation succeeded before requesting any remaining owner action.
2. Ask the user to fully quit and reopen Claude Desktop, then open a new Local Cowork session so Claude reloads the plugin, MCP registrations, hooks, and skills.
3. In the new session, invoke the installed `doctor` skill.
4. If the native remote MCP presents OAuth, ask the user to approve that native flow. Never request or copy the resulting credential.
   - In Codex, the installer must have pinned its package-owned callback settings first. If OAuth is still required, run `codex mcp login implant`; never construct or edit the authorization URL yourself.
5. Rerun the `doctor` skill after OAuth and classify the result.

### 6. Bind the intended workspace

Perform this phase only after the new session has the installed `connect` skill.

1. Ask for the exact workspace folder only when it is not already explicitly supplied by the user.
2. Ask for the owner-provided one-use setup URL only when no binding exists.
3. Invoke `connect` from the exact workspace and give the one-use setup URL only to that skill.
4. Invoke `doctor` again after binding.

## Completion

Finish with one status:

- `INSTALLED`: local plugin, MCPs, hooks, and skills are registered; OAuth or binding may still be an explicitly named next action.
- `READY`: the new Local Cowork session passes doctor, native OAuth is available when required, and the intended workspace is bound.
- `BLOCKED`: a prerequisite, permission, or exact failing check prevents further autonomous progress.

Report only:

- installed package version,
- Local Cowork registration result,
- doctor classification,
- binding status,
- and the one remaining user action, if any.

Do not tell the user to rerun commands already completed by this workflow.
