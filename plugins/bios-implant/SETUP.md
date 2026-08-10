# BIOS Implant Setup

Complete BIOS Implant setup for Claude Desktop Local Cowork. Do not summarize this document. Execute it and keep working until you can report exactly one of `READY`, `INSTALLED`, or `BLOCKED`.

Ask the user only for visible native permissions, a missing Node prerequisite, native OAuth approval, the exact workspace folder, or an owner-provided one-use setup URL. Do not ask for Git, package-registry credentials, a global install, Python, a daemon, passwords, tokens, or cookies.

## 1. Require the supported environment

1. Require a Local Cowork session. Remote Cowork is unsupported.
2. Check that Node is version 20 or newer; the local companion MCP runs under it.

## 2. Install or repair when needed

1. BIOS Implant installs only from the public marketplace `8hats/plugins` (https://github.com/8hats/plugins). Never install through a package registry: the former npm channel is retired and frozen at an old version.
2. If the plugin is not loaded yet, the session predates installation, or the local payload is broken, install or reinstall it through the host's native plugin mechanism: in Claude Desktop, the plugin browser with the marketplace source `8hats/plugins`; in Claude Code, `/plugin marketplace add 8hats/plugins` then `/plugin install bios-implant@8hats`. Ask the user to perform the native app steps you cannot drive yourself.
3. A machine that still carries the retired npx-era install (`bios-implant@agent-university`) must remove it first (`claude plugin uninstall bios-implant@agent-university`): running both copies means duplicate skills and duplicate MCP servers.

## 3. Confirm the loaded plugin in a fresh session

1. Fully quit and reopen Claude Desktop, then require a fresh Local Cowork session after installation or repair.
2. Confirm that the `doctor`, `connect`, and `boot` skills are visible and that `implant-local` is available.
3. Never ask the user to reinstall when a fresh session can load the already installed plugin.

## 4. Run local doctor and complete OAuth

1. Invoke the installed `doctor` skill.
2. Treat a healthy local payload with `AUTH_REQUIRED`, `BINDING_REQUIRED`, or `RUNTIME_PROBE_REQUIRED` as installed, not broken.
3. If Claude presents its native OAuth flow, tell the user why it is needed and ask them to approve it in the app. Never ask the user to open connector customization or enter a Client ID, callback URL, scope, secret, or other OAuth setting; the remote MCP owns discovery and automatic client registration.
4. Never request, copy, display, store, or transmit the resulting token.
5. Invoke `doctor` again after the native flow completes.

## 5. Bind the workspace only when needed

1. Skip this section when doctor confirms an existing binding for the intended workspace.
2. Require the exact workspace folder; never infer it from a recent folder or repository name.
3. Ask for the owner-provided one-use setup URL only when binding is still required.
4. Give that one-use value only to the `connect` skill. Never pass it to a shell command, installer, doctor, log, or normal chat response.
5. Invoke `connect`, then invoke `doctor` again after `connect` completes.

## 6. Boot and finish

1. Invoke `boot` for the exact bound workspace.
2. Report `READY` only when the local companion is healthy, remote authentication is available when required, the intended workspace binding is confirmed, and boot finished.
3. Report `INSTALLED` only when BIOS Implant is installed locally but exactly one remaining owner action is still required.
4. Otherwise report `BLOCKED` with the exact failed prerequisite.

Do not repeat completed steps or ask the user to interpret command output.
