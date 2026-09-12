# Product room tools: API r5 / system r11

Owner's 2026-09-12 request extends **agents-university-cowork** only. The ten
existing room/session tools remain. The plugin now provides all21 local ac_*
tools specified by API r5 section4. No incoming SDK commands are defined by the
MVP; `registerCommands` is never used to call room consumers.

## Design and authority

One MCP process still selects one persistent room through enter_room or
connect_to_room. Product tools use that room's contact CID and the currently
bound identity; they accept no authentication actor override. Current identity
name/CID is checked before SDK work and after completion. Backend current
membership/command/evidence policy is authoritative. A native contact alone is
not product admission, a sent receipt is not a decision, and a file receipt is
not a committed document version.

The implementation ports accepted backend commit
`dfe3a8796561d9651abd0cf2bb14d304121ac797`'s contracts, errors, AgentHarness and
agent-tool executors into readable self-contained JavaScript under src/product.
Their original TypeScript types were erased with esbuild, relative import
extensions changed to .mjs, and absent command_results is treated as an empty
batch for legacy SDK fixtures. No backend checkout is needed at build/install
or runtime. Imported harness/tool regression tests preserve the accepted
behavior. Updates must compare these modules with the backend contract and
rerun both regression and plugin integration tests.

The shared adapter in src/product-tools.mjs holds inbox/correlation state keyed
by identity CID and room. Both ac_messages and legacy read_room_messages use it;
legacy reads return an additional command_results array and retain unrecognized
or unrelated mail for explicit ac_messages inspection. Retention survives an
explicit disconnect/reconnect inside the same MCP process, but is not persisted
across process termination. No durable outbox/replay/reconciliation service is
added. All tool calls are serialized, including legacy disconnect/connect.

Responses are validated and bounded before selected mail/results are removed.
Command timeouts and handler failures remain unknown with request wire ID when
available; the plugin never automatically resends. Inspect ac_messages and
ac_read before deciding on a new action. Native callbacks for command results
emit body-free wakes, then the host explicitly calls ac_messages. Existing
monitor lifecycle/reconnection behavior is preserved.

## Tools

Fifteen aliases send the corresponding consumer.ac.* command exactly once:

| Local tool | Room command |
|---|---|
| `ac_read` | `consumer.ac.read` |
| `ac_version_commit` | `consumer.ac.version.commit` |
| `ac_review_submit` | `consumer.ac.review.submit` |
| `ac_review_publish` | `consumer.ac.review.publish` |
| `ac_remark_record` | `consumer.ac.remark.record` |
| `ac_remark_set` | `consumer.ac.remark.set` |
| `ac_request_create` | `consumer.ac.request.create` |
| `ac_request_route` | `consumer.ac.request.route` |
| `ac_request_decide` | `consumer.ac.request.decide` |
| `ac_instruction_propose` | `consumer.ac.instruction.propose` |
| `ac_publication_propose` | `consumer.ac.publication.propose` |
| `ac_history_annotate` | `consumer.ac.history.annotate` |
| `ac_intervention_record` | `consumer.ac.intervention.record` |
| `ac_stage_explain` | `consumer.ac.stage.explain` |
| `ac_result_create` | `consumer.ac.result.create` |

Six SDK helpers complete the surface:

| Tool | Behavior |
|---|---|
| ac_commands | Advertised native catalogue plus current product capabilities |
| ac_join | Explicit invitation/name via addContact; no identity or product grant |
| ac_message | Public message or wire/sentence reply to selected room |
| ac_messages | Selected/bounded mail and correlated command outcomes |
| ac_send_file | Bounded path or base64 artifact, optional wire/sentence reply |
| ac_files | List incoming room files, consume explicit selected wires, stream/hash-check stored bytes |

A typical flow is connect_to_room → ac_commands → ac_read(kind:context) → an
allowed domain tool. Use ac_read(kind:source,id:...) to resolve evidence through
current backend authorization. Original-human operations still require that
human's actual verified authority; tools do not impersonate the human.

## Verification and distribution

Run `npm test`, `npm run build`, and `node test/dist-smoke.mjs` from this plugin.
Tests exercise a real MCP client, strict union schemas, sender/reply correlation,
late results shared with legacy reads, concurrent disconnect refusal, retained
mail after identity changes, byte-limited pages, file provenance and no resend.
The distribution is bundled with pinned ours SDK3.7.2 and MCP SDK1.30.0.
No daemon lifecycle, live identity changes, installation, remote push or release
is performed by these tests. Version1.1.0 is locally implemented and code-reviewed; remote publication
requires the Owner's decision.

## Legacy inbox progress correction

Review #330 found that retained unrelated mail could starve legacy reads.
The plugin harness now applies an internal legacy eligibility filter before
page count/byte limits: valid selected-room messages and tracked results remain
eligible, unrelated/unrecognized mail and unmatched results stay retained for
ac_messages. With no eligible retained items, a legacy read performs at most one
bounded fresh SDK read through the same capacity check. A full retained inbox
still requires explicit ac_messages inspection before further consumption.
The unchanged Critic regression plus large-prefix/capacity tests pass; full suite40/40.


## Overall code acceptance

Critic #332 accepted exact49ff35d51dc8f3420ced53c860bfacf13ba45295 on
2026-09-12: independent40/40 tests, unchanged private starvation regression1/1,
standalone MCP smoke and byte-identical rebuild of every committed dist file.
The review covers all31 tools, contract ports, correlation/unknown outcomes,
shared inbox retention, lifecycle exclusion, notifications, manifests and docs.
Only agents-university-cowork changed. This accepts code and deterministic tests;
it does not claim live backend deployment, publication or Owner task closure.
