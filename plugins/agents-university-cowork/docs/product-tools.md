# Personal Agent room tools

Current plugin: agents-university-cowork, version1.1.0. Owner #347 removed five
old message/file tools; #351 separated Moderator; #370 removed public ac_join.
The current catalogue is19 tools: five session operations and14 Personal Agent
ac_* tools. See [the complete Russian reference](mcp-tools-ru.md).

## Tool surface

Session operations: enter_room, connect_to_room, disconnect_from_room,
list_rooms, get_room_status. enter_room accepts the invitation while creating
its persistent identity; reconnect selects the saved identity with force:false.

Product commands: ac_read, ac_version_commit, ac_review_submit,
ac_remark_record, ac_remark_set, ac_request_create, ac_request_decide,
ac_instruction_propose, ac_history_annotate.

SDK helpers: ac_commands, ac_message, ac_messages, ac_send_file, ac_files.
There are no hidden legacy aliases, no public ac_join and no Moderator tools.
Runtime fixes the Personal profile; input arguments cannot select Moderator.
No incoming SDK registerCommands catalogue is installed.

## Execution and retention

The current room supplies contact CID and the actual identity supplies actor
authority. SDK identity name/CID is checked before SDK work and after completion.
Backend membership/command/evidence checks remain authoritative. Sending a file
does not commit a version, and sending a command does not establish success.

One tool call runs at a time, including disconnect. ac_messages is the sole
public inbox reader and returns ordinary mail, unmatched results and correlated
command results. A result must come from the selected room and match the original
request wire. Unknown completion is retained for explicit state inspection;
mutations are never automatically resent. Retention survives reconnect within
the same process, not process termination. Selected records are removed only
after identity and serialized output checks. Pages are byte/count bounded.

Notifications are body-free. On message/result wakes use ac_messages; on file
wakes use ac_files. Native observation does not grant backend authority.

## Source provenance and builds

src/product ports the accepted backend dfe3a879 contracts/errors/harness/tool
executors with TypeScript erased using esbuild and .mjs imports. Shared source
also supports the separate agents-cowork-moderator bundle. Internal descriptors
are filtered by each public plugin; inclusion in source is not MCP registration.
The SDK batch reader tolerates an absent command_results array as empty.

The repository builds each plugin into a self-contained dist bundle with pinned
SDK3.7.2/MCP1.30.0 and dependency licenses. Installed plugins need no backend
checkout, sibling plugin or node_modules. Run npm test and npm run build in this
plugin; repeated builds must match committed dist byte-for-byte.

Critic accepted both plugins at eb1ff53280939e5da2d4c5475c8418c70a9e2ae5:
Personal 35/35 tests, Moderator 5/5, plus an independent rejection regression.
Both standalone MCP bundles were checked and rebuilt byte-for-byte.
No remote publication, host installation or live backend deployment is claimed.
