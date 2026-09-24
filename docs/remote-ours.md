# Connect cowork tools to a remote ours daemon

This guide applies only to the separately scoped Moderator (`au-cowork-moderator`).
Personal v2 uses central HTTPS; see its README instead. Run Node 22 or
newer. The daemon must already be running; plugins do not install or manage it.

Set these two variables in the environment of the MCP server process:

```sh
export AU_OURS_URL='https://daemon.example/ours'
export AU_OURS_API_TOKEN='<API token from your secret manager>'
```

The value above is a placeholder. Supply the real token through your harness's
secret environment or a protected file; never paste it into chat, a committed
MCP manifest, command-line arguments, or diagnostic output. Restart the MCP
process after changing its environment. Connect to your room with the existing
`connect_to_room` tool; remote setup does not change room admission.

Get the daemon's final HTTPS URL and a client API token from its operator. Neither
is included in this plugin, and a room invitation is not an API token. Store the
token in a private file on this computer; do not ask the user to paste it into chat.

For project setup, place `.au-ours.json` in the MCP process's working directory:

```json
{
  "url": "https://daemon.example/ours",
  "tokenFile": "/run/secrets/ours-api-token"
}
```

The token file contains only the token, optionally followed by a newline. It
must be a regular file owned by the MCP process's OS user with no group/other
permissions (`chmod 600`); symlinks are rejected. Relative token paths resolve
from the configuration file's directory. Keep token files outside the repository.
The adapter reads the protected file on every request, allowing operator token
rotation without embedding the value in configuration.

The shipped Codex MCP configuration sets its working directory to the installed
plugin root, which can differ from the user's project. Prefer an absolute
`AU_OURS_CONFIG=/absolute/path/project.json` in the MCP server environment when
using a project-owned config; this also avoids storing config inside an updatable
plugin cache. Check the harness's actual MCP working directory rather than
assuming the user's project directory is used. A complete environment URL/token pair overrides project
configuration as a pair. A partial or empty environment pair is an error; the
adapter never combines an environment URL with a project token. An explicit
missing/malformed project configuration is also an error. With no remote
environment settings or project file, existing SDK local selection remains in
effect, including `OURS_CONFIG`, `OURS_PORT`, `OURS_STATE_DIR`, and its coherence
checks. Remote mode never reads a local daemon token or state directory.

Use a final HTTPS URL with normal Node certificate trust. Private CAs can be
provided through `NODE_EXTRA_CA_CERTS` before starting the MCP process. Base
paths are supported. Userinfo, query strings, fragments, whitespace, backslashes
and encoded path separators/traversal are rejected. All requests stay within
the configured origin and path prefix, and all redirects are refused.

For a daemon that remains bound to the remote host's loopback interface, an
SSH-key tunnel preserves that deployment topology:

```sh
ssh -N -L 127.0.0.1:49167:127.0.0.1:41647 your-server-alias
export AU_OURS_URL='http://127.0.0.1:49167'
# Supply AU_OURS_API_TOKEN through the same secret mechanism described above.
```

HTTP is allowed only for literal `127.0.0.1` or `[::1]`, so an SSH tunnel can
protect cross-host traffic. Public/LAN HTTP and ambiguous loopback spellings
are rejected. Do not open production daemon ingress merely to use these tools.

## Compatibility and lifecycle

Remote mode currently accepts exactly daemon `3.8.1-nightly.1`, verified with
SDK `3.8.1-nightly.9`. Other versions fail before creating an identity. Extending
the allowlist requires verifying external-session behavior, not just comparing
version numbers. The adapter uses the SDK's low-level expert client with an
external owner lease. HTTPS/SSH and the explicit credential establish the
connection; it does not claim daemon-instance-ID pinning. This avoids requiring
an instance-ID configuration change that would break older local clients.

One random owner ID lasts for the session and its transport reconnects. Explicit
disconnect releases the owner while retaining the persistent identity and room
membership. Reconnect using the saved connection_id, without redeeming the
invitation again; a replacement session uses a fresh owner ID. Local process IDs are not used to reap remote
owners. Abrupt process death or network loss may leave an external owner on the
daemon: this adapter does not run an external owner supervisor. Ask the daemon
operator to inspect abandoned owners rather than forcing another identity bind.

Configuration, authentication, unreachable-daemon and unsupported-version errors
give a corrective action without echoing tokens, URLs, or raw server error text.
For authentication failures check the selected token with the operator; for
connection failures check the final URL, tunnel, TLS trust and daemon health.
Never include credentials when sharing evidence.


## Setup after MCP startup

Tool discovery does not select a daemon. Write project configuration before the
first daemon or registry operation. A local setup failure returns
`daemon_setup_required` with configuration steps; no invitation was submitted.
Correct project configuration and retry in the same MCP process. Failed
attachments do not pin the previous selection. Successfully attached sessions
keep their selection until explicit disconnect. Environment changes require an
MCP restart.

Remote connection records stay on the client under
`~/.au-cowork-remotes/<endpoint-hash>/`, independently of the project directory.
Keep this private directory to reconnect persistent identities; it contains
connection IDs and identity metadata, not API tokens. Local mode retains its
existing daemon-state registry paths. Endpoint aliases have separate catalogues.
If terminal release fails, the session retains its owner; restore connectivity
and call `disconnect_from_room` again before shutting down the MCP process.
