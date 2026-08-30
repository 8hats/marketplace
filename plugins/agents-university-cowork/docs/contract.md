# Frozen implementation contract

Normative inputs are the accepted v1 product specification SHA-256
`24214601a6326326313a81ddf87c8b2a784f7e5b26c53ed5f3e77c021721caf9`,
accepted v2 implementation specification SHA-256
`0fcb3740583301e049e7e28b72363178ed0c9e48e93a856dbf5c0b8dd0431c09`,
and the Owner's default-monitoring addendum.

The implementation uses the latest published SDK inspected before coding:
`@ours.network/sdk@3.6.0`, npm integrity
`sha512-Wy97CtE9mIkZ2Pda+iq/kfRsgTh2pIiBzqwy31tWG85M0b2yixT2eP0jJK4n10nipS5rVHi1YqNF97XdSooxSA==`,
tarball SHA-1 `389518ac2ff4fb739420ca86aae80baac0511165`, license
`FSL-1.1-Apache-2.0`. Its exact published declarations were inspected for every
used identity/contact/message/file/history/notification method.

There are exactly ten public tools. One stdio process binds at most one room.
`as_agent` is the exact persistent identity name. Received files deliberately
omit room-author attribution until backlog capability gap `0mtcryued89400a4f`
adds a shared authenticated cross-protocol file identifier.

Startup validates every registry row before any SDK attachment or mutation. The
monitor replays the notification stream from numeric cursor zero, gates every
replayed candidate against current body-free unread message/file metadata, and
deduplicates by wire ID; it never calls the unread drain methods. Only strict v1 `room_msg`/`room_file` envelopes with required room,
author, identity, time, and content fields are accepted.

The dedupe set lives for one complete monitor start across transient stream
retries and is pruned when current unread metadata no longer contains a wire ID.
Logging push is best-effort: a synchronous or asynchronous push failure counts as
one wake attempt and is not replayed into a wake storm; unread state remains the
authoritative recovery path.

Public `bind_state` is projected read-only from SDK identity session rows and is
exactly `unbound`, `bound_here`, or `bound_elsewhere`. Public room `status` is
`connecting`, `connected` only when bound here, or otherwise `disconnected`.

`dist/THIRD_PARTY_LICENSES.txt` contains the exact license texts for all pinned
dependencies bundled into the self-contained runtime.
