# Agents Cowork Moderator

Separate plugin for the Moderator assigned by the backend/Fleet setup.
It exposes20 MCP tools:14 shared Personal Agent tools plus six Moderator-specific
operations. It does not create, choose, remove or release identities, create
room registries, redeem arbitrary invitations, or register incoming SDK commands.

The five Personal Agent session tools and public ac_join are absent. Initial
invitation redemption, if required, belongs to the launcher/integration that
supplies the assigned client. This plugin expects that step already completed;
installing it is not a grant of Moderator authority.

## Runtime inputs

Set AC_MODERATOR_INPUTS_MODULE in the MCP host environment to an absolute local
ES module exporting async createModeratorInputs(). The module supplies:

- client: the ours SDK client already bound to the assigned Moderator identity;
- identityName and identityCid: exact assigned identity evidence;
- roomCid and roomName: exact selected native room/contact;
- monitor: optional boolean, default true, controlling body-free notification watch.

The integration owns the SDK lease and any initial invitation redemption.
Startup and tool calls verify the assigned identity. Shutdown stops this plugin's
notification watch and MCP server; it does not release the integration's lease.
No secrets or actual installation inputs are shipped in this public repository.

Without inputs, discovery still lists20 tools; calls return not_connected.
Invalid configured inputs or wrong startup identity fail visibly with a redacted
error. No identity repair, forced binding, daemon lifecycle or automatic mutation
retry is attempted. Backend room admission and current Moderator authorization
are required independently of the selected plugin.

## Tools

Shared: ac_commands, ac_read, ac_send_file, ac_files, ac_version_commit,
ac_review_submit, ac_remark_record, ac_remark_set, ac_request_create,
ac_request_decide, ac_instruction_propose, ac_history_annotate, ac_message,
ac_messages.

Moderator additions: ac_request_route, ac_review_publish, ac_publication_propose,
ac_intervention_record, ac_stage_explain, ac_result_create.

Arguments use API r5 section3/4, r11 section7.2/7.3, with public ac_join removed by
Owner #370. Underlying product functions are shared with the Personal source at
build time. The generated bundle contains everything it needs: installing the
Personal plugin alongside it is not required. Use ac_messages after message or
result wakes, ac_files after file wakes. Output/identity checks precede retained
mail acknowledgement; unknown outcomes require inspection before a new command.

## Development

From this directory: npm ci, npm run build, npm test. Build resolution includes
this plugin's pinned node_modules for shared source imports. CI also checks
byte-identical rebuilds. Tests use mock bound clients and real MCP transports,
including a configured standalone stdio bundle; they do not launch Fleet agents
or touch a live daemon. This local candidate has not been published.
