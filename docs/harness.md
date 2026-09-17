# Harness compatibility

`agents-university-cowork` and `agents-cowork-moderator` declare `harness.json` schema version 1. Harness reads their existing stdio MCP declarations and starts the bundled Node entrypoint as a separate process. The packages remain compatible with their existing native plugin hosts; no Harness-specific runtime is embedded in either package.

Harness's built-in `plugin marketplace` command installs a full immutable Git commit only after explicit `--trust`. It records package content digests, validates paths, rejects symlinks, and checks the bytes before each launch. Approval grants subprocess execution as the user's OS account; it is not sandbox confinement. Updates require another explicit commit and trust flag. Removal affects subsequent launches and retains files used by running processes.

The schema supports `schemaVersion: 1`, `mcp` (a package-relative JSON path), and optional `skills` (a package-relative directory). Version 1 only accepts Node stdio servers with a single bundled entrypoint and `${CODEX_PLUGIN_ROOT}` working directory. Hooks, host installers, remote MCP OAuth, arbitrary commands, and additional manifest fields are rejected. BIOS Implant has no declaration because its remote-implant setup requires separate integration work.

Verify declarations with `node --test test/harness-compatibility.test.mjs`. Publish these declarations only through the Marketplace release process after Owner approval; a local feature branch is not yet installable from the public canonical source.
