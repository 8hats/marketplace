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
