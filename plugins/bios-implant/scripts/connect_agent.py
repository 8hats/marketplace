#!/usr/bin/env python3
"""bios-implant Connect — the LOCAL half of activation.

Activation itself is not this script's job and does not touch MCP at all. The
owner hands the agent one link; the document behind it names the agent's real
`agent_id` and prints a complete command, which posts a one-use capability to the
registry over plain HTTPS. No sign-in, no consent, no callback port, no token.
The plugin implements no OAuth client, no callback server, no PKCE exchange and
no HTTP activation call — those were `connect/oauth.py` and `connect/activate.py`,
both deleted, and the MCP activation mount that briefly replaced them is gone too.

What remains here is what nothing else can do: write the local identity and
selection once the registry has answered 200.

  identity.json (chmod 600) -> store `default` -> user-level @path -> repo marker

All four writes are idempotent, so re-running this is safe. That is what makes it
the sanctioned repair for a machine whose activation already succeeded but whose
local selection was lost — no new install link, no new capability, no second
activation. The SessionStart boot protocol prescribes exactly this command.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # scripts/
from connect import agent_id as grammar  # noqa: E402
from connect import writes  # noqa: E402

DEFAULT_REGISTRY = "https://registry.agents.university"
DEFAULT_FACADE = "https://implant.agents.university"
STAGING_FACADE = "https://implant.staging.agentsuniversity.io"


def _facade_for(registry_base: str) -> str:
    return STAGING_FACADE if "staging" in registry_base else DEFAULT_FACADE


def _write_local(agent_id: str, facade: str, registry_url: str, args) -> None:
    """The four local writes, in dependency order.

    Each step is named on failure. Without that, a permission error on step 3
    surfaces as a bare traceback pointing at one line, and the operator cannot
    tell which of the earlier writes already landed — in the one situation where
    that is the useful thing to know, because re-running this is the repair.
    """
    steps = [
        ("identity.json", lambda: writes.write_identity(
            agent_id, facade_base=facade, registry_url=registry_url)),
        ("store default", lambda: writes.set_default(agent_id)),
        ("user @path block", lambda: writes.write_user_at_path(agent_id)),
    ]
    if not args.no_repo_marker:
        steps.append(("in-repo marker", lambda: writes.write_repo_marker(agent_id, label=args.label)))

    total = len(steps)
    for n, (name, step) in enumerate(steps, start=1):
        try:
            step()
        except Exception:
            print(
                f"[connect] step {n}/{total} ({name}) failed. Steps 1..{n - 1} already landed; "
                f"all writes are idempotent, so re-running this command is safe and is the repair.",
                file=sys.stderr,
            )
            raise


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="connect_agent",
        description="bios-implant Connect — write the local identity once the registry has "
                    "answered 200 to the command the document printed",
    )
    ap.add_argument("--agent-id", help="the agent_id that was just activated")
    ap.add_argument("--registry-url", help="registry base (default prod)")
    ap.add_argument("--label", help="optional in-repo selector label")
    ap.add_argument("--no-repo-marker", action="store_true", help="do not write the ./CLAUDE.md marker")
    ap.add_argument(
        "--write-only", action="store_true",
        help="accepted and ignored — local writes are now the only thing this script does. Kept so "
             "the command the boot protocol prescribes keeps working verbatim.")
    args = ap.parse_args(argv)

    if not args.agent_id:
        raise SystemExit("provide --agent-id")
    try:
        agent_id = grammar.validate_agent_id(args.agent_id)
    except grammar.AgentIdError as e:
        raise SystemExit(str(e))
    registry_url = (args.registry_url or os.environ.get("BIOS_REGISTRY_URL") or DEFAULT_REGISTRY).rstrip("/")

    _write_local(agent_id, _facade_for(registry_url), registry_url, args)
    print(f"[connect] local identity written for {agent_id}.")
    print("[connect] If your BIOS has already been published, start a NEW session to load it.")
    print("[connect] If it has not, that is expected: this agent will wait quietly and pick it up "
          "automatically on a later session. Nothing further to run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
