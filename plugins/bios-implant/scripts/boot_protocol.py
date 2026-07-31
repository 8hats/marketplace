"""
SessionStart hook for bios-implant: emit the MCP-first BIOS boot protocol.

Design (spec §4.3 / §5): SessionStart does NO network and injects no body. It
resolves which agent this session is, reads the verified local last-good version
from the store, and emits `hookSpecificOutput.additionalContext` instructing the
agent to load its current BIOS via the bios-implant `bios_load` tool on its first
action — falling back to the local last-good only on auth/network failure. The
PostToolUse stager (stage_bios.py) then persists whatever `bios_load` returned.

Agent selection order: BIOS_AGENT_ID env -> in-repo `<!-- BIOS:managed -->`
marker in ./CLAUDE.md -> the store `default` pointer -> a single stored agent.

Exits 0 always — a boot-protocol failure must never block the session.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage_bios  # noqa: E402
from connect.agent_id import AGENT_ID_RE  # noqa: E402

# The repair command this hook prescribes, resolved rather than templated.
#
# ${CLAUDE_PLUGIN_ROOT} is substituted by Claude Code into skill and command BODIES, but this
# text is generated in Python and delivered as hook additionalContext, which never passes
# through that substitution — so the agent would receive the literal, and in a shell it expands
# to nothing. A glob over ~/.claude/plugins is no better: it ignores CLAUDE_CONFIG_DIR (which
# this plugin honours elsewhere), orders by mtime rather than version, and on a marketplace
# checkout matches nothing at all.
#
# connect_agent.py is this file's neighbour, so __file__ is exact under every config dir,
# version nesting and install layout.
_CONNECT_AGENT = Path(__file__).resolve().parent / "connect_agent.py"

_MARKER = re.compile(r"<!--\s*BIOS:managed\s+agent_id=(\S+?)(?:\s+label=(\S+?))?\s*-->")


# A label is NOT an id and must not borrow the id grammar. `stage()` writes whatever label the
# facade names, rejecting only empty, `/`, `.` and `..` — so `prod:v2` is a legitimately staged
# document that AGENT_ID_RE refuses. Reusing the id grammar here made such a label unselectable,
# and the env branch then substituted "default", pointing the session at a DIFFERENT document
# than the one staged: a silent wrong answer, which is worse than a refusal.
#
# This widens the id grammar by the separators a real label carries and no further. Whitespace
# (including U+2800), control and format characters, and path separators stay out, because a
# label is both rendered into the greeting and used as a path component under the store — the
# same two duties that made validating ids necessary in the first place.
_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$")


def _is_one_path_component(value: str) -> bool:
    """True when `value` joins onto a directory as exactly one child, under BOTH path flavours.

    This checks the PROPERTY the grammar stands in for, because the grammar keeps being the wrong
    instrument: widening it to admit `:` so `prod:v2` could be selected also admitted `D:`, which
    pathlib reads as a Windows DRIVE — and a drive RESETS a join instead of extending it.

        base / 'prod:v2'  ->  ...\\labels\\prod:v2    one child, contained
        base / 'D:'       ->  D:                      escaped the store entirely
        base / 'C:evil'   ->  ...\\labels\\evil       drive absorbed, silently renamed

    On POSIX `:` is an ordinary filename character and none of that happens, but the store is
    written by whichever platform runs the hook, so both flavours are checked regardless of host.
    Asserting containment directly is what stops the next widening from quietly reopening this —
    twice now a grammar has been widened for a legitimate case and let something else through.
    """
    for flavour in (PurePosixPath, PureWindowsPath):
        p = flavour(value)
        if p.drive or p.root or len(p.parts) != 1 or p.parts[0] != value:
            return False
    return True


def _safe_label(value: Optional[str]) -> Optional[str]:
    """`value` if it is a label this hook can both render and resolve to a path, else None."""
    if not (isinstance(value, str) and _LABEL_RE.match(value)):
        return None
    return value if _is_one_path_component(value) else None


def _safe(value: Optional[str]) -> Optional[str]:
    """`value` if it matches the shared agent_id grammar, else None.

    Every id and label reaching this hook is UNTRUSTED. The marker is read from a CLAUDE.md that
    is committed and shared, so cloning a repository and opening a session in it is enough to
    supply one; the env vars are ambient. Both then land in two places that must not accept
    arbitrary text: a filesystem path component under the store (traversal), and the greeting the
    agent is instructed to print verbatim (assertion of things the system does not know).

    `\\S+?` in the marker pattern is not that guard — it excludes ASCII whitespace but admits
    U+2800 and punctuation, so a marker can carry prose that reads as several fields, including a
    forged "verified by owner" contradicting the hedge on the next line.

    AGENT_ID_RE is the shared grammar (`connect/agent_id.py`), whose own docstring names this
    exact duty: "guards the path-component and marker-content uses against traversal and
    injection". Applying it here treats a malformed value as ABSENT rather than as an error — the
    same path a marker that does not match at all already takes — so a typo or an attack both
    simply fail to select, and resolution falls through to the next source.

    The containment check is redundant against AGENT_ID_RE as written — it excludes `:` and `/`
    today, so nothing it admits can escape. It is here because that grammar is a CROSS-REPO
    contract app-v2 can widen without this file being reviewed, and the test that would catch
    such a drift SKIPS when app-v2 is not checked out beside us. Defence that depends on another
    repository's discipline is not defence; this line costs nothing and does not.
    """
    if not (isinstance(value, str) and AGENT_ID_RE.match(value)):
        return None
    return value if _is_one_path_component(value) else None


def _project_marker() -> Optional[Tuple[str, str]]:
    try:
        text = (Path.cwd() / "CLAUDE.md").read_text(encoding="utf-8")
    except OSError:
        return None
    m = _MARKER.search(text)
    if not m:
        return None
    agent, label = _safe(m.group(1)), _safe_label(m.group(2) or "default")
    return (agent, label) if agent and label else None


class _Unusable(str):
    """A store `default` that exists but does not pass the grammar.

    It must not collapse into "no default". The default's whole job is to OUTRANK a repo marker,
    which is shared and may name an agent this machine does not own — so if an unreadable default
    simply vanished, a damaged pointer would hand precedence to the least trusted source. Failing
    closed instead costs a session and says so; failing open would silently select an id someone
    else chose. Subclasses str only so the existing Optional[str] plumbing is untouched; it can
    never equal a real id because AGENT_ID_RE rejects its value.
    """


_UNUSABLE = _Unusable("\0unusable")


def _store_default() -> Optional[str]:
    d = stage_bios.store_root() / "default"
    raw = None
    try:
        if d.is_symlink():
            raw = os.path.basename(os.readlink(d)) or None
        elif d.is_file():
            raw = d.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None
    if raw is None:
        return None
    return _safe(raw) or _UNUSABLE


def _single_agent() -> Optional[str]:
    try:
        dirs = [x.name for x in (stage_bios.store_root() / "agents").iterdir() if x.is_dir()]
    except OSError:
        return None
    return _safe(dirs[0]) if len(dirs) == 1 else None


def resolve_selection() -> Tuple[Optional[str], str, str]:
    """Return (agent_id, label, source)."""
    agent = _safe(os.environ.get("BIOS_AGENT_ID"))
    # A bad BIOS_LABEL refuses only in the branches that actually CONSUME it. It governs which
    # staged document those branches load, so substituting "default" would quietly answer a
    # question nobody asked — but a marker carries its own label, so refusing globally would let
    # an unrelated tool exporting BIOS_LABEL silently disable marker selection. The refusal
    # should be no broader than the mistake.
    env_label = _safe_label(os.environ.get("BIOS_LABEL", "default"))
    if agent:
        if env_label is None:
            return None, "default", "none"
        return agent, env_label, "env"
    marker = _project_marker()
    d = _store_default()
    # A damaged default fails CLOSED. It exists to outrank the marker, so treating it as absent
    # would invert that precedence in favour of the least trusted source; and guessing past it via
    # _single_agent() would pick an agent this machine never nominated. No selection is the only
    # answer that neither lies nor yields, and the no-agent branch already tells the owner how to
    # repair the store.
    if d is _UNUSABLE:
        return None, "default", "none"
    # A repo CLAUDE.md is often shared or committed, so it can name an agent this machine does
    # not own. An explicit store `default` is written by THIS machine's activation, so it wins
    # over a marker that names a different agent. A marker naming the same agent as `default`,
    # or a marker with no `default` at all, still selects normally (and carries the label) —
    # which is why it is resolved BEFORE the env label is required.
    if marker and (d is None or marker[0] == d):
        return marker[0], marker[1], "marker"
    # Everything below labels its document with the env value, so an unusable one refuses here.
    if env_label is None:
        return None, "default", "none"
    if d:
        return d, env_label, "default"
    single = _single_agent()
    if single:
        return single, env_label, "single"
    return None, env_label, "none"


# How each resolve_selection() source reads to a human. Kept explicit rather than reusing the
# bare source token, because the owner-facing line has to say what the claim RESTS ON.
_SOURCE_PHRASE = {
    "env": "from the BIOS_AGENT_ID environment variable",
    "marker": "from the BIOS:managed marker in this folder's CLAUDE.md",
    "default": "from this machine's store default",
    "single": "from the only agent in this machine's store",
}


def build_greeting(
    agent: Optional[str],
    label: str,
    source: str,
    ver: Optional[int],
    status_damaged: bool,
) -> str:
    """The owner-facing opening lines: who this agent is, on what basis, and which BIOS it has.

    Rendered from LOCAL state only — never from a bios_load response — so it is available before
    any tool call, needs no network, and does not depend on any one host's hook machinery. The
    hook is only what makes it appear early on Claude Code.

    The identity here is RESOLVED, not verified. resolve_selection() reads an env var, an in-repo
    marker or the store pointer; none is authenticated, and the marker is committed and editable
    by anyone with repo write access. A forged marker therefore changes what these lines SAY but
    grants nothing: every privileged call is OAuth-bearer authenticated against the facade, and
    that token lives in the host's own MCP credential store — NOT in identity.json, which holds
    only {agent_id, facade_base, registry_url, owner_sub?} and no secret at all. So the blast
    radius of a forged marker is exactly "the owner is told the wrong name", which is why the
    hedge sits on line 1 rather than being left to the source line beneath it.

    The version is likewise the last one this machine staged, not necessarily the current one:
    this path does no network, so staleness is undetectable here and must not be papered over.
    The date comes from status.json's mtime — the etag identifies WHICH content was staged and
    can never answer WHEN, so it is deliberately not used for that claim.
    """
    if not agent:
        return (
            "No agent is configured for this folder, so I cannot tell you which agent I am.\n"
            "This is a setup gap, not a failure — ask me to run the repair."
        )
    # The hedge rides line 1 with the name. Any partial compliance that keeps the name keeps the
    # qualifier attached to it, so the claim cannot be quoted onward stripped of what limits it.
    lines = [
        f"{agent} · label {label} (local claim — not owner-verified)",
        f"resolved {_SOURCE_PHRASE.get(source, f'via {source}')}",
    ]
    if status_damaged:
        lines.append("BIOS: local version unknown — this machine's status file is unreadable")
    elif ver is None:
        lines.append("BIOS: not loaded on this machine yet")
    else:
        when = ""
        try:
            p = stage_bios.agent_home(agent, label) / "status.json"
            when = f", staged here {date.fromtimestamp(p.stat().st_mtime).isoformat()}"
        except (OSError, OverflowError, ValueError):
            pass  # a date is a nicety; never let it cost the greeting
        lines.append(
            f"BIOS: v{ver}{when} — not re-checked against the service this session"
        )
    return "\n".join(lines)


def _greeting_block(greeting: str) -> str:
    """Wrap the greeting in the instruction that makes it the session's first visible output.

    Deliberately NOT "say nothing before this": several plugins in this marketplace register a
    SessionStart hook and at least one (task8) also claims the opening line, so an exclusive claim
    would be jointly unsatisfiable and one contract would silently lose every session. Asking for
    precedence over other status lines is satisfiable alongside them.
    """
    return (
        "FIRST — before any tool call, any file read, and any other status line — open this "
        "session by printing exactly these lines, verbatim:\n\n"
        f"{greeting}\n\n"
        "Do not reword, translate, summarise or embellish them, and do not drop the qualifier on "
        "the first line. Every hedge in them is load-bearing: they state what is actually known "
        "on this machine, and overstating it would tell your owner they are talking to a verified "
        "agent when nothing here has been verified.\n\n"
    )


def build_context(agent: Optional[str], label: str, source: str) -> str:
    if not agent:
        return _greeting_block(build_greeting(None, label, source, None, False)) + (
            "[bios-implant] No agent is configured on this machine, so no BIOS can be loaded.\n"
            "If activation has ALREADY succeeded for this machine, re-run only the local write "
            f'step: `python3 "{_CONNECT_AGENT}" --write-only --agent-id <your agent_id>`. Run it '
            "from the directory you want the agent bound to, normally your repository root. It "
            "needs no install link and no enrollment capability.\n"
            "If activation has not happened yet, ask your owner for an install link.\n"
            "Do NOT hand-edit BIOS_AGENT_ID and do NOT hand-write a `BIOS:managed` marker."
        )
    # The boot path is READ-ONLY, so it is deliberately tolerant where stage() is fail-closed.
    # stage() must refuse to write while the local version is unknown (an old body must never
    # overwrite a newer one), but this hook promises "exits 0 always": letting StatusUnreadable
    # escape here crashed the hook, emitted NO JSON, and left the agent with no boot protocol at
    # all — strictly worse than a damaged store. So an unreadable status degrades the context and
    # says so in words the agent can act on.
    try:
        ver = stage_bios.current_version(agent, label)
        status_damaged = False
    except stage_bios.StatusUnreadable:
        ver, status_damaged = None, True
    lastgood = (
        f"the verified local last-good BIOS (v{ver}) at {stage_bios.agent_home(agent, label) / 'active-bios.md'}"
        if ver is not None
        else None
    )
    label_arg = f', label="{label}"' if label != "default" else ""
    if lastgood:
        degraded = f"fall back to {lastgood} and announce a degraded boot"
    elif status_damaged:
        degraded = (
            "say plainly that your local last-good BIOS version is UNKNOWN and do NOT fall back "
            "to the local store — its status file is damaged, so nothing there can be trusted"
        )
    else:
        degraded = (
            "say plainly that no local last-good exists yet and continue without a BIOS — "
            "do NOT announce a degraded boot with nothing loaded"
        )
    damaged_notice = (
        "!! Your local BIOS store is DAMAGED: its status file is unreadable, so the locally "
        "staged version is UNKNOWN and there is no last-good to fall back to. Tell your owner — "
        "loading from the service still works, but the stager will REFUSE to save the result "
        "until the store is repaired, so every session stays in this state until they act.\n"
        if status_damaged
        else ""
    )
    return _greeting_block(build_greeting(agent, label, source, ver, status_damaged)) + (
        f"[bios-implant BOOT PROTOCOL — agent `{agent}` (label `{label}`, selected via {source})]\n"
        f"{damaged_notice}"
        f"Before any substantive work in this session, load your current BIOS, then your worldmodel.\n"
        f'1. Call the bios-implant `bios_load` tool with agent_id="{agent}"{label_arg}.\n'
        f"2. On success, treat the returned body as your BIOS for this session — it defines who you "
        f"are and how you work. The plugin stages it to the local store automatically.\n"
        f"3. Otherwise read `structuredContent.code` and follow EXACTLY ONE of these — never invent "
        f"a repair, and never re-run activation:\n"
        f"   - `not_found` — you are registered, but your BIOS has not been published yet. This is "
        f"normal and expected. Do NOT re-activate, do NOT reinstall, do NOT ask for a new install "
        f"link. Keep working without a BIOS; it will be picked up automatically on a later session.\n"
        f"   - `unauthorized` — if `structuredContent.reason` is `unknown_owner` or `not_owner`, "
        f"re-authenticating cannot help: report it to your owner and keep working. Otherwise "
        f"complete the OAuth sign-in for `bios-implant` in /mcp EXACTLY ONCE and retry; if it "
        f"recurs, report it to your owner and keep working.\n"
        f"   - `unavailable` — the service is temporarily unreachable: {degraded}.\n"
        f"   - any other code, including `bad_shape` and `too_large` — this is a defect in the "
        f"install, not something this session can repair. Report the exact code to your owner and "
        f"keep working without a BIOS.\n"
        f"4. Then call `wm_load` (no arguments) to load your worldmodel bundle. Its agent is "
        f"derived from your token, so it takes no agent_id. On success, treat the bundle as your "
        f"current world knowledge for this session.\n"
        f"5. `wm_load` has THREE outcomes, and one of them is not what it looks like:\n"
        f"   - `not_found` — your worldmodel has not been published yet. Same as BIOS: wait "
        f"quietly, change nothing, keep working.\n"
        f"   - `unauthorized` — if step 1 returned success or `not_found`, your token is provably "
        f"valid (both tools use the SAME bearer), so this means your worldmodel binding is missing, "
        f"NOT an auth problem: do NOT re-authenticate, do NOT re-activate, do NOT ask for a new "
        f"install link. Report \"worldmodel not bound\" to your owner and keep working. Only if "
        f"step 1 was ALSO `unauthorized` should you do the single re-authentication described "
        f"above.\n"
        f"   - anything else — report the code to your owner and keep working.\n"
        f"Do not skip these steps, and keep them in this order: the BIOS result is what tells you "
        f"how to read the worldmodel result."
    )


_FALLBACK_CONTEXT = (
    "[bios-implant] The boot protocol could not be built on this machine, so no BIOS "
    "instructions are available for this session. Your local BIOS version is UNKNOWN. Do NOT "
    "re-run activation and do NOT hand-edit anything — report this to your owner and keep "
    "working without a BIOS."
)


def main() -> int:
    # Last line of defence for the docstring's "Exits 0 always". A hook that raises prints a
    # traceback and NO JSON, which costs the agent its entire boot protocol; a hook that prints
    # a degraded context still tells it what happened and whom to tell.
    try:
        agent, label, source = resolve_selection()
        ctx = build_context(agent, label, source)
    except Exception as e:  # noqa: BLE001 - deliberately total
        ctx = f"{_FALLBACK_CONTEXT}\nDetail: {e.__class__.__name__}: {e}"
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
