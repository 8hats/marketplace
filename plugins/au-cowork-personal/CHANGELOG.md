## 1.3.5 — a transient lockout no longer reads as permanent

- `identity_in_use` is reported as **retryable**, with an action telling you to wait and warning you
  not to force-rebind. It was `retryable: false`, which is false: a session that dies without
  disconnecting leaves the daemon holding the lease and it clears by itself. Telling a caller the
  condition was permanent did not merely waste time — it sent an agent looking for another way out,
  into a force-rebind that *succeeds* and leaves the identity without its room contact, which no
  tool can restore. The escape was worse than the lockout. Measured on a clean-Windows QA run: over
  an hour held with no process alive, ~50 minutes of retries, one identity permanently destroyed.

- A missing `AU_OURS_CONFIG` file now names the path it actually looked at, and the cwd it resolved
  against. The value is resolved against the MCP server's working directory — the *installed plugin
  root* — so a relative path, or an MSYS-style `/c/Users/...` on Windows, silently becomes a path
  inside the plugin directory and your real config is never read. The failure surfaced as
  `remote_configuration`, which reads like "the daemon is misconfigured" rather than "we disagree
  about which file that was". No path translation is attempted; guessing intent would be worse.

- `.gitattributes` keeps committed `dist/` bundles byte-identical across platforms. A Windows
  checkout was converting LF to CRLF, so a sha256 taken there disagreed with the one CI built —
  which briefly looked like a QA run had tested the wrong artifact. Execution was never affected;
  verifiability was.

## 1.3.4 — an unmapped failure now leaves a trace

- Make `request_id` mean something. An unmapped error collapses to `internal_error`, whose message
  tells the caller to "use request_id for diagnostics" — while that id was written nowhere at all:
  no log line, no stderr, no trace. It was a handle on a door with no room behind it, and it is why
  three separate people independently resorted to patching the shipped bundle to diagnose anything.
  The correlation — `request_id`, the real error code, the message — now goes to the operator's
  stderr. The client payload is deliberately unchanged: `PUBLIC_CODES` is an allowlist that keeps
  internal detail away from an MCP client, so widening it would trade an opacity bug for a
  disclosure one. Pinned by a test that fails if the stderr line disappears **or** if internal
  detail reaches the client.

## 1.3.3 — the plugin now actually serves on Windows

**1.3.2's Windows fix did not hold for installed users.** It fixed the crashes that stopped the
plugin starting, but the server still never connected its transport when run the way it ships, so
on Windows an installed 1.3.2 exits instead of serving. If you are on Windows, 1.3.2 is not enough.

- Fix the plugin not serving MCP on Windows once installed. The server decides whether to connect
  its transport by comparing `import.meta.url` against a file URL it built by string concatenation
  (``new URL(`file://${process.argv[1]}`)``). When that comparison fails the module loads, connects
  nothing, and exits 0 with an empty stderr -- no crash, no output, no server. Probed on a Windows
  runner: from inside the repo it served, but copied to a directory with no `node_modules` beside
  it -- which is how the plugin is installed -- it exited without serving. `pathToFileURL` fixes
  it, which `au-cowork-moderator` already used. Reproducible on any platform by running the bundle
  from a directory containing `#` or `?`, and now pinned by a test that does exactly that.
  Verified on the Windows runner: the installed configuration now answers `initialize`.


## 1.3.2 — Windows follow-ups to 1.3.1

- Recover from an orphaned invite marker. A reserve interrupted between its two writes leaves an
  `invite-<sha>.attempt` marker with no connection record, permanently rejecting that one-use
  invite with `invite_already_attempted`. Such a marker is now reclaimed once it is demonstrably
  stale. Upgrading is enough; no manual cleanup.
  Scope, corrected after release: this residue was NOT reachable by Windows users on 1.3.1.
  `reserve()` calls `init()` first, and `init()` called `process.getuid()`, which does not exist
  on Windows, so it threw before writing anything. Producing the residue needed a build with that
  check fixed but the directory-fsync abort not, which is a mid-debugging state rather than a
  shipped one. The recovery is still correct and worth having: the crash window between the two
  writes is real on every platform, and it now fails safe.
- Guard the reclaim against replaying a real redemption. The marker now records a stage and is
  flipped to `attempted` before the invite is handed to the daemon, so a marker that ever
  reached the daemon is never reclaimable even if its connection record is deleted by hand.
  Reclaim additionally requires the marker to be older than 30 seconds, so a concurrent reserve
  in flight is never stolen. Markers written before 1.3.2 carry no stage and are read as
  `reserved`; for those only, deleting a connection record by hand can still replay an invite.
- `invite_already_attempted` now explains itself and names the recovery path.
- Reject a symlinked token file and a symlinked connection record explicitly. `O_NOFOLLOW` is
  absent from `fs.constants` on Windows, so the flag silently degraded to a plain read there.
  On POSIX this only replaces a raw `ELOOP` with the typed `connection_registry_unsafe`.
- Document the Windows token-file caveat honestly. `docs/remote-ours.md` promised owner and
  permission enforcement that Windows cannot provide; it now states what is actually checked
  and makes ACL restriction the operator's responsibility. The guarantee is unchanged on
  POSIX and this release does not add a Windows equivalent.
- Make the Windows-only test skips visible. Three tests were hidden behind `if` statements or
  could not hold on Windows, so a Windows run reported them as passing. They now report as
  skipped. Note this proves the suite RUNS on Windows, not that the skipped assertions hold.
- Add a `windows-latest` CI job so the platform claim is checked by a runner rather than asserted.
- Pin the advertised server version to `package.json`. The version lives in four places and only
  three were tested, so a partial bump could leave clients told the previous version.
- Stop opening the registry directory on Windows only to skip the fsync. Writes there are not
  ordered against a directory flush; this is now stated in the code.

## 1.3.0 — remote daemon connections

## 1.3.1

- Include remote setup guidance in MCP initialization and ship the complete guide inside each plugin. Clarify configuration paths and private token provisioning for fresh installations.

- Add shared HTTPS/loopback remote configuration with protected token files.
- Defer selection until use and explain missing local setup with recovery steps.
- Retain persistent identities/reconnect records in private endpoint-scoped client storage.
- Pin SDK 3.8.1-nightly.9 and require Node 22; rebuild standalone bundles.

## Unreleased — artifact result submission

- Add `ac_submit_result` and `ac_read` kind `artifact_result` for explicit submission of verified existing artifacts.
- Require subsequent human Owner approval; positive review feedback never triggers submission automatically.
- Validate unique attachment IDs and exact hashes; retain unknown outcomes without automatic retry.
- Rebuild standalone bundles. Existing MCP sessions need a reload; connection persistence is unchanged.

## 1.1.0 — product room commands

- Remove public ac_join; invitation redemption remains part of entry.

- Expose14 Personal Agent ac_* tools and retain five persistent session tools.
- Exclude six Moderator tools from discovery and invocation; Moderator becomes a separate plugin.
- Remove five old message/file tools per Owner decision; no hidden aliases.
- Read bounded retained mail and command results through ac_messages.
- Check current identity, serialize calls and preserve unknown outcomes without resend.
- Wake on typed room command results without consuming unread mail.
- Pin ours SDK3.7.2; ship regenerated self-contained bundle and regression coverage.

# Changelog

## 1.0.0

- Initial room-centric MCP with persistent identities, messages, files, and default live wake.
