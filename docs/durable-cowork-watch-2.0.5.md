# Durable Cowork watching — 2.0.5

## Delivered

- Persisted watch intent with automatic restart/crash restoration, retaining private credentials and the durable inbox.
- Explicit disconnect disables watching; runtime/transport shutdown preserves intent.
- Continuous bounded-backoff recovery for transient HTTP and response-body failures; authorization, unsafe storage and uncertain credential rotation remain fail-closed.
- A self-contained Cordis Host bundle for 8Hats/DeepSeek, with exact-Agent scoped tools and coalesced plugin-sourced wake notices. It uses the owning Agent's canonical tools registry, not another checkout's scope symbols.
- Own-message suppression, bounded queues, typed failures, secret-free diagnostics and teardown that drains started mutations before releasing the binding.
- Matching Personal and Moderator versions/manifests and rebuilt standalone distributions. The Host bundle supports either tool profile without granting room permissions.

## Verification

Local Linux checks:

- Personal: 42 passing tests, two Windows-only checks skipped.
- Moderator: 37 passing tests, two Windows-only checks skipped.
- Marketplace Harness declarations: two passing tests.
- Both packed/standalone MCP stdio probes passed.
- An offline check against the real deployed Harness Cordis/tools registries passed: no global registration, separate chat/fork tool definitions, exact session diagnostics and complete cleanup.
- Regression coverage includes killed-process lease recovery, explicit opt-out, ambiguous identities, old-state exclusion, stale/live leases, staged-backlog wake without acknowledgement, more than six fetch and body-stream failures, malformed protocol/size/cancellation distinctions, callback isolation and in-flight mutation teardown.

The running profile was activated and verified independently of file-level checks. Its requested room automatically restored its saved connection without invitation exchange. Real room updates produced plugin-sourced wake notices in the owning chat. Mail was drained and files inspected. Disabling and re-enabling the profile's watcher configuration restored the same connection with `watch_enabled: true`, `monitoring: running`, and an empty caught-up inbox.

No invitation, credential, room content, private connection file, or machine-specific deployment configuration is included in this repository. Native Windows execution is left to repository CI, not claimed from Linux skips. Dependency audit findings in the existing lockfiles are not addressed by this monitoring change.

## Boundaries

Watching is live while the Host and owning Agent are live; the server/local backlog is caught up when the same session resumes after downtime. It does not monitor while the computer is off or automatically resurrect closed sessions. Model wake notices can incur model costs and are not human authorization. Forks/new agents do not inherit another chat's identity. Human approval rules for room results remain unchanged.

Use the profile plugin manager to install the Personal plugin's `harness` directory, replacing competing MCP/coordinator registrations. Existing unmarked records require one deliberate saved-ID reconnect; migration between stores must be explicit with both identities released, never by replaying an accepted invitation. Existing installed JavaScript module generations may require a Harness restart after a package upgrade; check saved selection and activation outcomes separately.
