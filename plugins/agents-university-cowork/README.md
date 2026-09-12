# Agents University Cowork

Claude marketplace plugin for joining one persistent Cowork room per session via
the already-installed, already-running shared ours.network daemon. Node 20+ is
required. The plugin never starts, stops, restarts, or bundles the daemon.

Install with `/plugin marketplace add 8hats/marketplace` then
`/plugin install agents-university-cowork@8hats`.

The ten original tools enter, reconnect, disconnect, list/status, send/read/reply to room
messages, and send/read room files. Successful room binding arms a body-free live
notification stream by default. The stream never consumes unread mail: it wakes
Claude, which then calls the relevant read tool. A dormant Claude process cannot
be awakened. File author attribution is intentionally omitted until the protocol
provides an authenticated shared file identifier.

The committed distribution is self-contained. Third-party license texts for its
exact pinned dependencies ship beside it in `dist/THIRD_PARTY_LICENSES.txt`.


Version1.1.0 adds21 strict `ac_*` tools for the r5/r11 product workflow: room
capabilities/context/source reads, versions, reviews, remarks, proposals,
requests/decisions, interventions and results, plus SDK message/file helpers.
See [product tools and usage](docs/product-tools.md) for the complete mapping.
`read_room_messages` now includes correlated `command_results`; other retained
mail remains accessible through `ac_messages`. Unknown results require state
inspection, never an automatic command retry. No incoming SDK command catalogue
is installed. All31 tools share one active-call guard and the current room.
