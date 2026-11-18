# Needs me connector candidate

Matches [Cowork PR 154](https://github.com/8hats/agents-coworking/pull/154), technical candidate `097df89f888ee48a512180537f618658c2590776`; not deployed or human-accepted. Deploy the backend lifecycle first: older backends do not understand the new inquiry read/action commands. Existing tools and legacy backend handling remain otherwise unchanged.

- `ac_ask` retains the original inquiry; `ac_read({kind:'inquiry',id})` supplies canonical revision, turn, attribution and allowed actions. `ac_inquiry_act` explicitly replies, records progress or resolves; the server derives answer/follow-up. Human web-only helper grants are deliberately not exposed as tools.
- 29 focused adapter/transport/schema tests and runtime build passed. Post-build tests additionally exercise both standalone and copied Host bundles: direct inquiry read → revision/allowed actions → lifecycle action, invalid fractional revision rejection. This is deterministic mocked-transport proof, not a production connection or live deployment claim.
- Reproduce definition measurement with `node scripts/measure-inquiry-tools.mjs d38f8790700da54d96735f3b5268b46b4e8e6027`. Compact JSON contains tool name, description and generated input schema. No model tokenizer is used: UTF-8 bytes divided by four, rounded up, is a deterministic **size proxy, not actual token usage**.

| Profile | Tools before → after | Definition bytes before → after | Bytes/4 proxy before → after |
| --- | --- | --- | --- |
| Personal | 19 → 20 | 18,423 → 20,255 | 4,606 → 5,064 |
| Moderator | 25 → 26 | 22,474 → 24,306 | 5,619 → 6,077 |

Each profile adds 1,832 bytes (458 proxy units); the inquiry surface changes from 1,610 to 3,442 bytes. The measurement script reports SHA-256 digests and does not execute tools. The direct-read regression throws if full message history is requested, proving history loading is unnecessary for this adapter path.
