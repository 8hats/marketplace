"""Local activation writes: identity.json (chmod 600), the store `default`
selector, the write-once user @path block, and the in-repo token-less marker
(M4 §5.2 / §7). Reuses the CC-independent store paths from stage_bios."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/
import stage_bios  # noqa: E402

from .agent_id import validate_agent_id  # noqa: E402

# Write-once is per AGENT, not per file. The previous any-agent regex made every write after the
# first a silent no-op, so a second agent on the same machine never got its @path block and a
# repo CLAUDE.md carrying agent A's marker permanently mis-selected agent B.
#
# The terminator must be the marker's OWN grammar, not `\b`. An agent_id may contain `-` and `.`
# (agent_id.AGENT_ID_RE), and both are non-word characters, so `\b` matched the boundary INSIDE
# a longer id: a `gk-manager-2` marker satisfied the write-once check for `gk-manager`, and that
# agent's block was silently dropped - the exact silent no-op this rule exists to eliminate. An id
# in a marker is terminated by whitespace (before ` -->` or ` label=`) or by `-->` itself, and
# neither can occur inside a valid id, so a lookahead on those is exact.
def _managed_re(agent_id: str) -> re.Pattern:
    return re.compile(
        r"<!--\s*BIOS:managed\s+agent_id=" + re.escape(agent_id) + r"(?=\s|-->)" + r".*?-->",
        re.DOTALL,
    )


def marker(agent_id: str, label=None) -> str:
    tail = f" label={label}" if label and label != "default" else ""
    return f"<!-- BIOS:managed agent_id={agent_id}{tail} -->"


def write_identity(agent_id: str, *, facade_base: str, registry_url: str, owner_sub=None) -> Path:
    validate_agent_id(agent_id)
    home = stage_bios.agent_home(agent_id)
    home.mkdir(parents=True, exist_ok=True)
    p = home / "identity.json"
    data = {"agent_id": agent_id, "facade_base": facade_base, "registry_url": registry_url}
    if owner_sub:
        data["owner_sub"] = owner_sub
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)
    os.chmod(p, 0o600)
    return p


def set_default(agent_id: str) -> None:
    validate_agent_id(agent_id)
    root = stage_bios.store_root()
    root.mkdir(parents=True, exist_ok=True)
    (root / "default").write_text(agent_id + "\n", encoding="utf-8")


def _append_once(md: Path, block: str, agent_id: str) -> Path:
    md.parent.mkdir(parents=True, exist_ok=True)
    text = md.read_text(encoding="utf-8") if md.exists() else ""
    if _managed_re(agent_id).search(text):
        return md
    new = (text.rstrip() + "\n\n" + block) if text.strip() else block
    md.write_text(new, encoding="utf-8")
    return md


def write_user_at_path(agent_id: str, *, config_dir=None) -> Path:
    validate_agent_id(agent_id)
    base = Path(config_dir or os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))
    # Derive the @path from the SAME store the stager writes to (honors
    # AGENT_UNIVERSITY_HOME), so the write side and CC's @import read side always
    # agree. Express home-relative (`~/…`) when under $HOME for portability, else
    # absolute (the operator-override case).
    active = stage_bios.agent_home(agent_id) / "active-bios.md"
    try:
        active_str = "~/" + str(active.relative_to(Path.home()))
    except ValueError:
        active_str = str(active)
    block = f"{marker(agent_id)}\n@{active_str}\n"
    return _append_once(base / "CLAUDE.md", block, agent_id)


def write_repo_marker(agent_id: str, *, label=None, repo_dir=None) -> Path:
    validate_agent_id(agent_id)
    md = Path(repo_dir or Path.cwd()) / "CLAUDE.md"
    return _append_once(md, marker(agent_id, label) + "\n", agent_id)
