## 1.3.2 — Windows follow-ups to 1.3.1

- Recover from an orphaned invite marker. A reserve interrupted between its two writes (the
  failure 1.3.1 fixed on Windows) left an `invite-<sha>.attempt` marker with no connection
  record, permanently rejecting that one-use invite with `invite_already_attempted`. Such a
  marker is now reclaimed once it is demonstrably stale. Upgrading is enough; no manual cleanup.
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
- Verify on Windows that the MCP server actually serves. `scripts/stdio-probe.mjs` writes a real
  `initialize` frame to a spawned entry point; on the Windows runner both the bundle and the
  source answer it in full. An earlier diagnostic suggested the bundle died at startup there --
  that was an artifact of the probe discarding stdout, which makes the server exit on Windows.
  The remaining `dist-smoke` skip is an MCP SDK client-transport limitation in CI, not a server
  fault. Still unverified by a human on real Windows hardware.

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
