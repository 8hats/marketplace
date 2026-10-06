# Cowork connectivity recovery and monitor health — 2.0.6

Closes #32.

## Implementation

Both Personal and Moderator classify HTTP 408/425/429 and 5xx except 501/505 as transient before reading/parsing a response body. HTML gateway failures no longer become permanent protocol failures. Supported JSON service errors and network/body-stream outages continue bounded-backoff recovery. Retry-After seconds and HTTP dates supply a floor capped at 60 seconds; exponential jitter remains capped at 30 seconds. Body cancellation is best-effort and never blocks classification or shutdown.

Malformed successful JSON/envelopes/event-page shapes have a three-malformed-attempt budget, reset only by a valid page. Authentication (including oversized/error-labeled 401/403), unsafe storage, uncertain credential rotation and invalid/missing/backward cursors or event ordering remain immediately fail-closed. Invalid pages never advance the durable cursor or alter the inbox. Mutation requests are not automatically replayed; uncertain sends retain their idempotency keys for deliberate reconciliation.

Wait results add `monitor`. Watch/status results add `health`; watch status also exposes the loaded runtime `version`. These are additive outputs, not input schema changes. Queued mail can return `status: event` while `monitor.live` is false. Protocol-stopped monitors leave queued message fetching and acknowledgement usable, but authorization/storage failures still block reads. Diagnostics include only endpoint templates, HTTP status, allowlisted base MIME (or null), fixed validation reason and timestamp, plus separate failure counts, next delay and last successful poll time. No response bodies, arbitrary MIME tokens, credentials, invitation/query values, origin URLs or message contents are included.

## Verification

Synthetic/private-state regression coverage includes HTML 502 recovery with exactly-once staging, the complete transient HTTP-status policy, numeric/date Retry-After limits, more than six mixed outages, malformed-response budgets/reset, malformed budget persistence across transport failures, cursor/order/sequence rejection, queued mail during stopped polling, auth-label/oversized-auth handling, hanging/rejecting body cancellation, arbitrary MIME redaction and no automatic mutation replay with durable key reuse.

Linux checks: Personal 76 passing tests and two Windows-only skips; Moderator 71 passing tests and two Windows-only skips. Both standalone/packed MCP probes and reproducible builds pass. The real deployed Harness registry integration probe passes offline. Native Windows execution is verified by repository CI separately from Linux skips. Test fixtures contain no real invitations or credentials and do not contact a production room.

The independent audit found oversized-auth classification and unbounded cancellation waits; both were corrected and have regression tests. The release preserves the Host adapter and durable watch lifecycle from 2.0.5.

## Installation and boundaries

This repository ships releases through updated manifests and committed rebuilt distributions. Existing processes can retain a cached JavaScript module generation; update/restart the owning MCP runtime or Harness, then confirm `get_watch_status.data.version` is `2.0.6`. A browser refresh alone does not establish a Host-runtime upgrade. Resume the same session/store so its saved watched connection catches up automatically; do not replay an accepted invitation.

No live runtime upgrade or real production HTTP 502 reproduction is claimed by the synthetic tests. The exact triggering response in the original report remains unknown. Host/chat liveness and the computer-off boundary are unchanged: this is not an OS daemon or automatic resurrection of closed chats. Existing dependency-audit findings are outside this connectivity release.
