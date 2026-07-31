"""
BIOS staging for the bios-implant plugin.

Places a fetched BIOS body into the CC-independent agent store atomically, with
a monotonic downgrade-refuse gate and a swappable `active-bios.md` pointer, so a
Claude Code `@path` can resolve a stable file while updates/rollback just move
the pointer. This is the client half of the "auto-apply-on-boot" design
(spec §4.2/§4.3/§5.2).

Two layers:
  - The CORE (store paths + `stage()` + version gate) is transport-free and is
    fully exercised by tests against real bundle bytes and a real filesystem.
  - `parse_post_tool_use()` is a THIN adapter from a Claude Code PostToolUse hook
    event for the bios_load MCP tool. Its exact envelope field names are marked
    below and MUST be confirmed against a captured real CC payload before the
    hook is wired live — the core does not depend on that shape.

Store layout (per agent, per label):
  <home>/agents/<agent_id>/                    (the `default` label — path is historical and
                                                is what activation's user-level @path points at)
  <home>/agents/<agent_id>/labels/<label>/     (every other label — its own document)
    active-bios.md  -> generations/<version>-<etag12>/bios.md   (symlink)
    generations/<version>-<etag12>/bios.md
    status.json     { agent_id, bios_version, etag, active }
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Optional, Tuple


def store_root() -> Path:
    """The CC-independent store root. Overridable via AGENT_UNIVERSITY_HOME
    (used by tests and by an operator escape hatch); defaults to
    ~/.agent-university (survives a $CLAUDE_CONFIG_DIR wipe)."""
    override = os.environ.get("AGENT_UNIVERSITY_HOME")
    return Path(override) if override else Path.home() / ".agent-university"


class DowngradeRefused(Exception):
    """Raised when a staged version is older than the current active one."""


class StatusUnreadable(Exception):
    """Raised when status.json exists but cannot be trusted. Fail CLOSED: a corrupt status file
    must never silently disable the monotonic gate and let an old body overwrite a newer one."""


def agent_home(agent_id: str, label: str = "default") -> Path:
    # The `default` label keeps the historical path, because activation writes a user-level
    # CLAUDE.md `@path` pointing at <home>/agents/<id>/active-bios.md and that pointer must stay
    # valid. Extra labels are separate documents with their own generations, gate and pointer.
    base = store_root() / "agents" / agent_id
    return base if label == "default" else base / "labels" / label


def current_version(agent_id: str, label: str = "default") -> Optional[int]:
    p = agent_home(agent_id, label) / "status.json"
    if not p.exists():
        return None  # genuine first boot — the only case that legitimately has no version
    try:
        return int(json.loads(p.read_text(encoding="utf-8"))["bios_version"])
    except Exception as e:
        raise StatusUnreadable(f"{p} exists but is unreadable: {e}") from e


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".stage-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # atomic on POSIX + same-dir Windows
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _atomic_symlink(link: Path, target: Path) -> None:
    """Point `link` at `target` (relative, so the store is relocatable) via an
    atomic rename so a reader never sees a half-updated pointer."""
    rel = os.path.relpath(target, link.parent)
    tmp = link.parent / (link.name + ".tmp")
    try:
        if tmp.is_symlink() or tmp.exists():
            tmp.unlink()
        os.symlink(rel, tmp)
        os.replace(tmp, link)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def stage(agent_id: str, body: str, version: int, etag: str, label: str = "default") -> Path:
    """Stage `body` as generation <version>-<etag12> for `agent_id`, flip the
    active pointer to it, and record status.json — atomically. Refuses a version
    strictly older than the current active one (monotonic downgrade-refuse).
    Idempotent for an unchanged (version, body). Returns the generation path."""
    if not agent_id or "/" in agent_id or agent_id in (".", ".."):
        raise ValueError(f"invalid agent_id: {agent_id!r}")
    if not label or "/" in label or label in (".", ".."):
        raise ValueError(f"invalid label: {label!r}")
    cur = current_version(agent_id, label)
    if cur is not None and version < cur:
        raise DowngradeRefused(f"version {version} < active {cur} for {agent_id}/{label}")

    home = agent_home(agent_id, label)
    short = etag.strip('"')[:12] or "noetag"
    gen_file = home / "generations" / f"{version}-{short}" / "bios.md"

    _atomic_write(gen_file, body.encode("utf-8"))
    _atomic_symlink(home / "active-bios.md", gen_file)
    _atomic_write(
        home / "status.json",
        (json.dumps(
            {"agent_id": agent_id, "bios_version": version, "etag": etag, "active": str(gen_file)},
            indent=2,
        ) + "\n").encode("utf-8"),
    )
    return gen_file


# --- PostToolUse adapter (envelope field names: VERIFY against a real CC payload) ---

def parse_post_tool_use(event: dict) -> Optional[Tuple[str, str, int, str, str]]:
    """From a Claude Code PostToolUse event for the bios_load MCP tool, extract
    (agent_id, body, version, etag, label). Returns None when the event is not a
    successful bios_load result. The label defaults to `default` when the facade
    does not name one, which keeps the historical single-document behaviour.

    Envelope assumptions (mark for verification against a captured payload):
      - event['tool_name'] ends with '__bios_load' (the plugin-scoped MCP tool name)
      - event['tool_input']  = { 'agent_id': ..., 'label'?: ... }
      - event['tool_response'|'tool_output'] = the MCP tool result, i.e.
          { 'content': [{'type':'text','text': <body>}, ...],
            'structuredContent': {'agent_id':..,'label':..,'version':int,'etag':str} }
    The `stage()` core does NOT depend on this shape.
    """
    name = event.get("tool_name", "")
    if not name.endswith("__bios_load"):
        return None
    args = event.get("tool_input") or {}
    out = event.get("tool_response")
    if out is None:
        out = event.get("tool_output") or {}
    if isinstance(out, str):
        try:
            out = json.loads(out)
        except ValueError:
            return None

    sc = out.get("structuredContent") or {}
    body = None
    for chunk in out.get("content") or []:
        if isinstance(chunk, dict) and chunk.get("type") == "text":
            body = chunk.get("text")
            break
    agent_id = sc.get("agent_id") or args.get("agent_id")
    if agent_id is None or body is None or "version" not in sc:
        return None
    label = str(sc.get("label") or args.get("label") or "default")
    return str(agent_id), str(body), int(sc["version"]), str(sc.get("etag", "")), label


def _main() -> int:
    """Hook entry: read a PostToolUse event on stdin, stage a bios_load result.
    Always exits 0 (a stager failure must never break the agent's turn); it
    reports via stderr only."""
    import sys

    try:
        event = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    parsed = parse_post_tool_use(event)
    if parsed is None:
        return 0
    agent_id, body, version, etag, label = parsed
    try:
        path = stage(agent_id, body, version, etag, label)
        sys.stderr.write(f"[bios-implant] staged {agent_id}/{label} v{version} -> {path}\n")
    except DowngradeRefused as e:
        # Loud, and addressed to a human: a silent refusal is how an agent stays frozen on an old
        # generation forever while the server has moved on.
        sys.stderr.write(
            f"[bios-implant] UPDATE REFUSED: {e}\n"
            f"[bios-implant] The server offered v{version} but the local store holds a newer "
            f"generation. This usually means the published version was not increased (or could "
            f"not be parsed). Tell your owner: the BIOS is NOT being updated.\n"
        )
    except StatusUnreadable as e:
        sys.stderr.write(
            f"[bios-implant] UPDATE REFUSED: {e}\n"
            f"[bios-implant] Refusing to stage while the local version is unknown, so an old body "
            f"cannot overwrite a newer one. Tell your owner.\n"
        )
    except Exception as e:  # never break the turn
        sys.stderr.write(f"[bios-implant] stage error: {e}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
