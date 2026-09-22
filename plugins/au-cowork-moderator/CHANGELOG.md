## 1.2.2 — Windows follow-ups to 1.2.1

- This plugin bundles `au-cowork-personal`'s sources, so every 1.3.2 change to the connection
  registry, invite-marker recovery and token-file handling applies to it as well. This was also
  true of the 1.2.1 Windows fix, which was described only as a build change: the moderator's
  shipped runtime changed then too. Recorded here so the release history is accurate.
- Add a manifest test. The moderator had no test tying its three version locations together,
  and no check that the version it advertises matches `package.json`.

## 1.2.0 — remote daemon connections

## 1.2.1

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

# 1.0.0

Separate Moderator plugin with20 product tools, explicit assigned-client inputs,
identity verification, bounded retained command results, notifications and a
self-contained bundle. No public join or identity lifecycle tools.
