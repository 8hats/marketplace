"""The agent_id grammar — one definition, shared by everything that touches an id.

It lives in its own module because it is a cross-service contract, not an
implementation detail of any one caller. The pattern MUST stay byte-identical to
the equivalent gate in the server-side setup renderer.

The two gates guard the same id at opposite ends of one activation. The renderer emits
the document only if the id passes its gate; this plugin performs the local write
only if the id passes ours. The registry spends the one-use capability AFTER it has
already bound the agent — so an id that app-v2 accepts and we reject leaves the
agent bound server-side, with no local identity and a burned link. No retry
repairs that.

The 255-character ceiling is POSIX NAME_MAX, the real downstream constraint: the
id becomes a filesystem path component under `~/.agent-university/agents/`.

A parity test in the 8hats source repository reads app-v2's own copy and compares
the two patterns, so a one-sided edit fails rather than drifting quietly — but only
when app-v2 is reachable, which it is not from this distribution. Treat the pattern
below as frozen: change it here and the two ends of an activation disagree.
"""
from __future__ import annotations

import re
from typing import Any

# Must not contain a path separator, `..`, whitespace, or characters that would
# break out of the `<!-- BIOS:managed agent_id=X -->` marker in CLAUDE.md —
# especially since the id is copied out of a document the agent fetched over the network.
# Start alphanumeric; then alphanumerics, dot, underscore, hyphen; <= 255 chars.
# (Real ids look like `SETU-paired-2026-06`, `hanuman-demo-1`, `e2e-fixture`.)
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")


class AgentIdError(Exception):
    """Raised for an unsafe or malformed agent_id."""


def validate_agent_id(agent_id: Any) -> str:
    """Return `agent_id` if it is a safe identifier, else raise AgentIdError.

    Guards the path-component and marker-content uses against traversal and
    injection.
    """
    if not isinstance(agent_id, str) or not AGENT_ID_RE.match(agent_id):
        raise AgentIdError(
            f"invalid agent_id (must match {AGENT_ID_RE.pattern}): {agent_id!r}")
    return agent_id
