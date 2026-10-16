# Stable invitation links — additive connector build

Owning product specification/ledger: [Agents Coworking PR #37](https://github.com/8hats/agents-coworking/pull/37), INVURL-1 revision4 (agent-owned preflight wording; connector runtime remains the revision3 functional candidate). Requesting human in the Harness session owns product review (identity not supplied); coding agent owns implementation/checks/QA handoff after “yes, take ownership on the whole feature”. Explicit request: adversarially review the design, address findings and build. Publication, live profile installation, merge and production deployment are not authorized. Independent implementation acceptance is pending.

## Baseline and boundaries

This branch starts at marketplace main `cb3948be` (Personal2.0.6, Moderator2.0.7), not stale app-repo source. Another worktree has uncommitted2.0.8 completion/heartbeat work; remote PR #37 also advances that feature. Neither was overwritten or implicitly published. Reconcile both branches before choosing a final monotonic release version; current versions remain baseline identifiers, **not claims this feature is available in those released versions**. No UI may ship a minimum/pin until exact release identity and availability are verified.

Changes are local standard-library URL parsing and uncertainty guidance only. Preserve existing tool schemas, backend exchange payload, role/name authority, credential lifecycle and watch behavior. No new resolver, updater, token type or backend migration.

## Contract and adversarial corrections

Accept canonical HTTPS invitations and instruction `#token=` URLs; ignore one historical instruction name. Support bounded same-origin `#invite=` wrapping a canonical URL, decoded once. Reject controls, duplicates/conflicts, unknown fragment keys, HTTP/userinfo/query, malformed tokens, foreign configured/nested origins and recursive/unsupported shapes before transport. No invented canonical name alias or prose scanning.

Use one exchange per deliberate invocation; backend single use guarantees one successful admission. Lost/malformed response and post-exchange lease/storage failure are non-retryable and tell the human to inspect membership, not repeat an invitation. No durable prevention of a later deliberate replay across calls/restarts is claimed. Private input is not echoed in errors.

## Evidence so far

Node22 local `npm run check` on both profiles passed: Personal108 pass/2 Windows-only skip, Moderator72 pass/2 Windows-only skip. Personal suite includes4 parser matrix tests covering both profiles and28 uncertainty tests covering both public entry tools/profiles. Existing schemas unchanged. Both builds passed and whitespace check passed. These are Linux/source/builder checks, not human acceptance or full backend E2E.

Invitation-specific exact-artifact check now passes: `node scripts/invitation-link-check.mjs` exercises24 successful journeys,24 negative cases and3 fresh-process/coordinator saved-ID reconnects through Personal stdio, Moderator stdio and the actual copied Personal Harness coordinator/default bundled runtime. Both joining tools and canonical/instruction/historical-name/encoded-canonical forms are covered;42 exchange attempts total, zero on malformed input/reconnect. Real transport/MCP/adapter registration/lifecycle are tested against an explicitly simulated trusted loopback HTTPS backend (scoped generated CA, no TLS bypass). This is not application SQL/role-policy validation or real installed-host acceptance.

Observed unchanged functional candidate `e442270`: Personal2.0.6 top-level/Harness runtime SHA256 `1bfb5e04f5c36de30c52c89e2f9d1881bbd76ad6346c5e3e0afea4f5ecb57f0e`; Moderator2.0.7 SHA256 `9448c7b677c892091760a680a29ee167c1e91f7428b7bdf2e4b45a9403fa13f7`. Script checks runtime identity, same bundle hash and guards against concurrent artifact/metadata rebuilds. `get_watch_status` already includes runtime VERSION; no new identity API added. Package versions are baseline values, not a claim those published versions contain this feature. App's technical setup instructions use exact immutable build `e442270` until release reconciliation. Revision4 compact handoff now says “Follow this link's instructions to choose a supported join path.” A Git hash is not an ordered version: agents must inspect actual loaded runtime/adapter bytes, not infer patched support from tool names or the baseline version. Missing/unknown support leads to host-supported setup/restart/reverification or the independent browser path before any exchange; no automatic negotiation API or updater was added.

Independent implementation review identified that a bare intermediary HTTP429 was still reported retryable during exchange. An in-memory regression reproduced four failing public-tool/profile cases before the fix; the rate-limit exception was removed for exchange only. Added HTML429/503 fixtures now pass across both tools/profiles; normal read/monitor retry suites remain passing. No live traffic was used.

## Remaining before acceptance/release

- Exact transport checks above pass against the simulated backend. App-led PR46 proof was adopted into PR37's feature branch and corrected after review: copied packaged stdio also crosses real application SQL/agent HTTP over disposable trusted-CA HTTPS (16 joins,20 exchanges,16 memberships; saved-ID/fresh-process reconnects). Signal cleanup and copied-hash tampering faults are checked separately. This supplements—not relabels—the simulated coordinator proof; no installed Harness/real tester-host or production acceptance is implied. Human installed-host joining acceptance remains an app-led gate.
- Source/manifest/runtime version reconciliation and exact commit/artifact hashes after newer2.0.8 work is reconciled; no version placeholder in shipped UI.
- App name-free generation, complete two-line selectable/copy fallback handoff, save-queue and real desktop/mobile/browser checks, prepared reachable human host QA.
- Independent implementation review, then separately authorized publication/integration/UI deployment. Production remains rolled back. No automatic release is implied by this branch or passing tests.
