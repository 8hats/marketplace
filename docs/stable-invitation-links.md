# Stable invitation links — additive connector build

Owning product specification/ledger: [Agents Coworking PR #37](https://github.com/8hats/agents-coworking/pull/37), INVURL-1 revision3. Requesting human in the Harness session owns product review (identity not supplied); coding agent builds. Explicit request: adversarially review the design, address findings and build. Publication, live profile installation, merge and production deployment are not authorized. Independent implementation acceptance is pending.

## Baseline and boundaries

This branch starts at marketplace main `cb3948be` (Personal2.0.6, Moderator2.0.7), not stale app-repo source. Another worktree has uncommitted2.0.8 completion/heartbeat work; remote PR #37 also advances that feature. Neither was overwritten or implicitly published. Reconcile both branches before choosing a final monotonic release version; current versions remain baseline identifiers, **not claims this feature is available in those released versions**. No UI may ship a minimum/pin until exact release identity and availability are verified.

Changes are local standard-library URL parsing and uncertainty guidance only. Preserve existing tool schemas, backend exchange payload, role/name authority, credential lifecycle and watch behavior. No new resolver, updater, token type or backend migration.

## Contract and adversarial corrections

Accept canonical HTTPS invitations and instruction `#token=` URLs; ignore one historical instruction name. Support bounded same-origin `#invite=` wrapping a canonical URL, decoded once. Reject controls, duplicates/conflicts, unknown fragment keys, HTTP/userinfo/query, malformed tokens, foreign configured/nested origins and recursive/unsupported shapes before transport. No invented canonical name alias or prose scanning.

Use one exchange per deliberate invocation; backend single use guarantees one successful admission. Lost/malformed response and post-exchange lease/storage failure are non-retryable and tell the human to inspect membership, not repeat an invitation. No durable prevention of a later deliberate replay across calls/restarts is claimed. Private input is not echoed in errors.

## Evidence so far

Node22 local `npm run check` on both profiles passed: Personal100 pass/2 Windows-only skip, Moderator72 pass/2 Windows-only skip. Personal suite includes4 parser matrix tests covering both profiles and20 uncertainty tests covering both public entry tools/profiles. Existing schemas unchanged. Both builds passed and whitespace check passed. These are Linux/source/builder checks, not human acceptance or full backend E2E.

Personal top-level and Harness runtime hashes match after build (build already copies the exact artifact). Existing adapter tests run in the suite; new invitation-specific packaged stdio + actual adapter + trusted-HTTPS backend joining/reconnect/name proof is still pending. Verify the post-build runtime through both paths; testing only top-level stdio is insufficient. `get_watch_status` already includes runtime VERSION and can provide safe identity evidence through the adapter; do not add a redundant API merely to expose it.

## Remaining before acceptance/release

- Exact packaged stdio and Harness-adapter join/read/context/capabilities/reconnect checks with43-character synthetic fixture tokens and isolated trusted HTTPS backend.
- Source/manifest/runtime version reconciliation and exact commit/artifact hashes after newer2.0.8 work is reconciled; no version placeholder in shipped UI.
- App name-free generation, complete two-line selectable/copy fallback handoff, save-queue and real desktop/mobile/browser checks, prepared reachable human host QA.
- Independent implementation review, then separately authorized publication/integration/UI deployment. Production remains rolled back. No automatic release is implied by this branch or passing tests.
