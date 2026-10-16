# Invitation + heartbeat connector candidate — 2026-10-16

## Ownership and exact sources

Local candidate only, in `/home/slava/workspaces-one/08-8hats/agents/misc/di-si-connectors-release-oct16`, branch `release/di-si-connectors-2026-10-16`.

- HEAD / heartbeat PR37: `a9f06909b105412894b360f4556cb0c353f772d4`.
- Invitation PR38 / pending MERGE_HEAD: `6636581e65957f77f7d76ea9689359c25cadeba0` (shared `refs/remotes/origin/di-si-release-invites-38`).
- Shared base: `cb3948be2365fb572a92cb89907d1e628fd0009d`.
- Composed with `git merge --no-commit --no-ff 6636581e65957f77f7d76ea9689359c25cadeba0`. Merge ancestry and staged review state retained; no commit or push.
- Human release authorization was supplied by the parent task; Slava owns release. This work exercised only isolated source composition/build/tests. Parent owns Git-first integration, review, publication/deployment and recovery in app draft PR48 (`eee6c97`).

The initial composition worker did not edit the original invitation checkout, dirty marketplace checkout, application sources, existing links or user WIP. The later bounded recovery correction described below separately edits only the parent-owned app release candidate's clients/tests; originals remain preserved. No room messages, production business API, real invitations, identity/profile installation, main merge, publication or deployment occurred.

## Resolution and scope

Both clients retain PR38's exact strict HTTPS/configured-origin parser: canonical links, instruction `#token`, and one bounded same-origin encoded canonical `#invite`; legacy `name` is ignored. Controls, duplicate/ambiguous fields, query and foreign-origin cases fail before exchange. Tool input schemas and `{token,display_name}` exchange body are unchanged.

The manual bind conflict combines PR38's single-exchange uncertainty and acquire/save/release failure semantics with PR37's `let session`, explicit saved-ID session capture, and optional informational session request **only after credential save and `this.row` binding**. A failed informational session cannot fail admitted identity creation. Ordinary reads/polling/status retain their existing retry classifications.

Heartbeat currency pruning still precedes staged replay/saved hints, uses at most 100 stale IDs per acknowledgement, avoids session reads on restore without staged heartbeats, and leaves ordinary mail available during currency outages. Moderator-only heartbeat configuration remains strict (`enabled:boolean`, optional integer `interval_minutes` 1–1440, no room ID); Personal receives no such tool.

All generated runtime conflicts were overwritten by final source builds, not resolved by choosing minified ours/theirs bytes. Clients remain byte-identical. Wrapper, patch/config declarations, tool schema sources and baseline assertions remain unchanged.

New cross-profile composition coverage is in `plugins/au-cowork-personal/test/invitation-heartbeat-composition.test.mjs` (10 cases, both profiles; both admission tools). It uses actual bind/store/read/ack methods with a disabled concurrent polling loop. It checks durable post-save admission despite HTML503 session failure, exactly one exchange and saved-ID reconnect, stale-heartbeat restore pruning before wake, ordinary mail reads during currency failure, and no-transport restore without heartbeat. Existing parser/uncertainty and heartbeat suites are retained unchanged.

## Candidate versions and immutable identities

**2.0.9**, unreleased, for Personal, Personal Host bundle and Moderator. This exceeds both input proposals (2.0.7 / 2.0.8) without appropriating unrelated dirty 2.0.8 WIP. Both Claude/Codex manifests, package manifests, lock root and `packages['']`, source VERSION exports, changelogs and Personal Host README agree. Marketplace index has no version field; none was added. Dependency/lock package entries are unchanged.

SHA-256:

| Artifact | Hash |
| --- | --- |
| Personal `dist/cowork-mcp.mjs` | `25b84c4bf555314513b14522a3ffa65cef224231f608346c3f62acf1d804d48c` |
| Personal `harness/dist/cowork-mcp.mjs` | `25b84c4bf555314513b14522a3ffa65cef224231f608346c3f62acf1d804d48c` |
| Moderator `dist/cowork-mcp.mjs` | `701ae1b340f2a441d1e825675beb65c2c7f09757116484a52bec7e216c153e25` |
| Both `src/central-client.mjs` copies | `680c0ce5d06ba0023198b773479a31d57d5e0bcfb6eb7df6842cfa05d11b5069` |
| Unchanged Personal `harness/index.js` | `076ebbf2ff83d2b340cb61e36d52ac8734f9c827e7b9e4fd321b13fa604f2f06` |
| Unchanged Personal `harness/cordis.patch.yml` | `72e11def2ec032ff3ea5fd3c57e569cd6778d9ac296c455cf94ff1bdf18238b0` |

## Actual validation

All commands used Node **v22.23.2** with:

```sh
export PATH=/nix/store/3vm4j8im8bzdal3dsgmhv9gb5kvanbp1-nodejs-22.23.2/bin:/home/slava/.nix-profile/bin:/run/current-system/sw/bin:/usr/bin:/bin
# In EACH profile directory:
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
# In repository root:
node --test test/harness-compatibility.test.mjs
node scripts/invitation-link-check.mjs
```

Final results:

- Initial composed Personal suite:125 tests,123 pass,0 fail,2 Windows-only skips. After the additional recovery correction below, final Personal suite includes24 extra deterministic recovery cases:149 total,147 pass,2 Windows-only skips.
- Moderator full suite:79 tests,77 pass,0 fail,2 Windows-only skips. Both profile suites plus root compatibility after FINAL rebuild: **230 total,226 pass,4 Windows-only skips,0 failures** (worker-run; parent independent review/test still required).
- Root Harness compatibility: **2/2 pass**, included in that230.
- Exact packaged invitation proof: **24 success journeys, 24 negative cases, 3 fresh saved-identity reconnect checks**, 42 exchange attempts across all synthetic scenarios. Private-CA loopback HTTPS, two standalone stdio profiles and Personal fake-context coordinator. No global TLS bypass. Artifact/version guards ran before and after and agree with the hashes above.
- Additional Node assertions passed for all manifest/source/runtime versions, identical client bytes, unchanged wrapper/patch/tool schema bytes against HEAD, and exact lockfile equality to HEAD after changing only the two root version fields. `git diff --check HEAD` passed.
- Generated license inventories are unchanged. esbuild optional binaries worked without repair or install scripts.

Non-green/intermediate evidence is not discarded: first Personal attempt (job `bash-510`) reported 89 tests / 85 pass / 2 failed file imports / 2 skips, because its cross-profile imports ran before Moderator dependencies had been installed. Moderator install/build/test (`bash-511`) then passed; Personal rerun (`bash-512`) passed 125/123/0/2 without test weakening. Diff audit also caught an overly broad metadata replacement touching Personal's `proxy-addr` lock entry; restored that dependency entry to its original 2.0.7, repeated Personal `npm ci` + build + full suite (`bash-515`), and verified root-only lock deltas. Artifact hashes did not change. HTTPS proof passed before (`bash-514`) and after (`bash-516`, also root compatibility) that correction. No source edits occurred during active validation jobs. All jobs were collected.

Private-CA fixture and test stores are disposable and removed by their `finally` cleanup; fixture servers/workers and runtimes shut down. Only ignored local `node_modules` remain for parent reruns; no global install. The ad-hoc initial status scratch file was removed.

## Recovery correction after independent review

The independent review reproduced a suppressed current-heartbeat wake that never recovered after a transient currency-read failure unless a NEW heartbeat or explicit inbox read occurred. The final source adds a local pending-ID set per monitor: retry only after successful event polls (including empty pages), prune fail-closed, notify a proven-current ID once, and share the set with Marketplace bind catch-up. Guards prevent stale monitor/connection/abort hints, including synchronous ordinary-mail callbacks that detach before the heartbeat callback. No durable fields, new timer, polling cadence or schemas changed. Source/checkpoint hashes from the initial composition and first recovery attempt are superseded by the final table above; no such intermediate artifact was published.

The recovery worker ran final app plugin suites55/55 and final Marketplace suites/compatibility230 total226 pass4 Windows skips, then the private-CA HTTPS proof again on the exact final25b84/701ae runtimes. Source is snapshot-bounded, not an absolute distributed zero-stale-wake guarantee; reconnect can re-hint still-current retained mail once. No runtime write occurred during those jobs. Parent then independently ran combined application typecheck and **entire backend350/350** with `STATUS_MODERATOR_BUNDLE` pointing to this final Moderator runtime and `PERSONAL_CLIENT` to this final Personal source (job bash-541, exit0, Node22, NODE_NO_WARNINGS=1). This includes real HTTPS bundled Moderator heartbeat/status and Personal disable/Done/reconnect against actual Application/SQL; it is not the still-pending native Cordis invocation proof.

## Explicit limitations / parent actions

- **Preserved existing scope asymmetry:** Personal server still lacks Moderator's actionable `room_done` message and Done-aware `get_room_status` `can_send:false` / flattened roomDiscussion. The Personal client does carry shared connection roomDiscussion. Do not interpret combined version alignment as fixing this baseline; parent must decide any broader correction separately.
- This is not actual app SQL, native Cordis Host activation, browser/member/name integration or human QA/acceptance. No real-user acceptance is inferred.
- Existing actual-app/Cordis proof pinned to an old runtimeHash must be retargeted to the final Personal hash above and rerun independently. No old `e442270` runtime evidence is transferred to this candidate.
- No unresolved source/generated conflict remains after staging; pending uncommitted merge intentionally remains for parent review. Parent must independently inspect the combined diff, run actual app SQL/Host tests with this artifact, decide remaining product scope and integrate via release PRs.
