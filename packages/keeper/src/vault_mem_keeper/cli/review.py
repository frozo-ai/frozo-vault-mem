"""Interactive walker for pending contradiction proposals.

Reads `_system/proposals.jsonl` and prompts the user for accept / reject /
skip / view / notes / quit per proposal. Accept actions apply the
suggested resolution (archive the loser, append to supersedes), update
the proposal status, and append an audit entry."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import load_keeper_config
from ..frontmatter import parse_memory_file, serialize_memory
from ..llm.budget import BudgetTracker
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths, resolve_vault_path, vault_paths
from ..proposals import Proposal, open_proposals

log = get_logger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _find_memory_file(paths: VaultPaths, mid: str) -> tuple[Path, str] | None:
    """Return (path, type) for the canonical memory `mid`, or None."""
    for t in MEMORY_TYPES:
        candidate = Path(paths.memory_file(t, mid, "memory"))
        if candidate.is_file():
            return candidate, t
    return None


def _load_title(paths: VaultPaths, mid: str) -> str:
    loc = _find_memory_file(paths, mid)
    if not loc:
        # Also check archive — superseded memories live there
        for t in MEMORY_TYPES:
            arch = Path(paths.archive_dir) / f"{mid}.md"
            if arch.is_file():
                try:
                    fm, _ = parse_memory_file(str(arch))
                    return str(fm.get("title", "(no title)"))
                except Exception:
                    return "(unreadable)"
            _ = t  # noqa
        return "(missing)"
    path, _t = loc
    try:
        fm, _ = parse_memory_file(str(path))
        return str(fm.get("title", "(no title)"))
    except Exception:
        return "(unreadable)"


def _render(p: Proposal, idx: int, total: int, *, paths: VaultPaths, out: TextIO) -> None:
    source_title = _load_title(paths, p.source_id)
    target_title = _load_title(paths, p.target_id)
    bar = "─" * 60
    out.write(
        f"\n[{idx}/{total}] {p.id}  {p.kind}  severity={p.severity}\n"
        f"{bar}\n"
        f"  Source:  {p.source_id}\n"
        f"           \"{source_title}\"\n"
        f"           updated: {p.source_updated}\n\n"
        f"  Target:  {p.target_id}\n"
        f"           \"{target_title}\"\n"
        f"           updated: {p.target_updated}\n\n"
        f"  Reasoning:\n    {p.reasoning}\n\n"
        f"  Suggested action: {p.suggested_action}\n"
        f"  Cost: ${p.cost_usd:.4f}  (model: {p.model})\n\n"
        f"  [a]ccept  [r]eject  [s]kip  [v]iew  [n]otes  [q]uit\n"
    )
    out.flush()


def _apply_supersede(
    paths: VaultPaths,
    audit: Auditor,
    proposal: Proposal,
    *,
    loser_id: str,
    winner_id: str,
    run_id: str,
) -> bool:
    loser_loc = _find_memory_file(paths, loser_id)
    if not loser_loc:
        log.warn("apply: loser memory not found", id=loser_id)
        return False
    loser_path, loser_type = loser_loc

    winner_loc = _find_memory_file(paths, winner_id)
    if not winner_loc:
        log.warn("apply: winner memory not found", id=winner_id)
        return False
    winner_path, _ = winner_loc

    # Mark loser superseded, write back in place
    try:
        loser_fm, loser_body = parse_memory_file(str(loser_path))
    except Exception as e:
        log.warn("apply: parse loser failed", id=loser_id, err=str(e))
        return False
    loser_fm["status"] = "superseded"
    loser_fm["updated"] = _now_iso()
    atomic_write(str(loser_path), serialize_memory(loser_fm, loser_body))

    # Move loser to archive/<id>.md
    archive_target = Path(paths.memory_file(loser_type, loser_id, "archive"))
    archive_target.parent.mkdir(parents=True, exist_ok=True)
    os.rename(str(loser_path), str(archive_target))

    # Append loser_id to winner's supersedes list
    try:
        winner_fm, winner_body = parse_memory_file(str(winner_path))
    except Exception as e:
        log.warn("apply: parse winner failed", id=winner_id, err=str(e))
        audit.write({
            "op": "proposal_apply_failed",
            "agent": "human", "session": run_id,
            "proposal_id": proposal.id,
            "stage": "winner_parse",
            "err": str(e),
        })
        return False
    supersedes = list(winner_fm.get("supersedes") or [])
    if loser_id not in supersedes:
        supersedes.append(loser_id)
    winner_fm["supersedes"] = supersedes
    winner_fm["updated"] = _now_iso()
    atomic_write(str(winner_path), serialize_memory(winner_fm, winner_body))

    audit.write({
        "op": "proposal_applied",
        "agent": "human", "session": run_id,
        "proposal_id": proposal.id,
        "kind": proposal.kind,
        "source_id": proposal.source_id,
        "target_id": proposal.target_id,
        "action_taken": f"supersede_loser={loser_id}_winner={winner_id}",
    })
    return True


def _passes_filters(p: Proposal, *, kind: str | None,
                    severity: str | None, project: str | None,
                    paths: VaultPaths) -> bool:
    if kind and p.kind != kind:
        return False
    if severity and p.severity != severity:
        return False
    if project:
        loc = _find_memory_file(paths, p.source_id)
        if not loc:
            return False
        try:
            fm, _ = parse_memory_file(str(loc[0]))
            if fm.get("project") != project:
                return False
        except Exception:
            return False
    return True


def cmd_review(  # noqa: PLR0913
    vault: str,
    *,
    filter_kind: str | None = None,
    filter_severity: str | None = None,
    filter_project: str | None = None,
    input_fn: Any = input,
    out: TextIO = sys.stdout,
    editor_fn: Any = None,
    run_id: str | None = None,
) -> int:
    paths = vault_paths(vault)
    Path(paths.audit_file).touch(exist_ok=True)
    audit = Auditor(paths.audit_file)
    cfg = load_keeper_config(vault)
    budget = BudgetTracker(paths.budget_file, cfg.budget.monthly_usd_cap)

    proposals = open_proposals(paths.proposals_file)
    pending = [
        p for p in proposals.iter_pending()
        if _passes_filters(p,
                           kind=filter_kind, severity=filter_severity,
                           project=filter_project, paths=paths)
    ]

    if not pending:
        out.write("No pending proposals.\n")
        return 0

    mtd = budget.month_to_date()
    cap = cfg.budget.monthly_usd_cap
    pct = (mtd / cap * 100) if cap > 0 else 0.0
    out.write(
        f"{len(pending)} pending proposal{'s' if len(pending) != 1 else ''}.\n"
        f"Budget this month: ${mtd:.2f} / ${cap:.2f} cap ({pct:.0f}%).\n"
    )

    rid = run_id or f"review_{_now_iso()}"

    for i, p in enumerate(pending, 1):
        _render(p, i, len(pending), paths=paths, out=out)
        while True:
            try:
                choice = input_fn("> ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                out.write("\nbye\n")
                return 0
            if choice in ("q", "quit", "exit"):
                out.write("bye\n")
                return 0
            if choice == "s" or choice == "":  # skip = blank = enter
                out.write("  → skipped\n")
                break
            if choice == "r":
                proposals.set_status(p.id, "rejected")
                audit.write({
                    "op": "proposal_rejected",
                    "agent": "human", "session": rid,
                    "proposal_id": p.id,
                })
                out.write("  → rejected\n")
                break
            if choice == "n":
                note = input_fn("note> ").strip()
                if note:
                    audit.write({
                        "op": "proposal_note",
                        "agent": "human", "session": rid,
                        "proposal_id": p.id,
                        "note": note,
                    })
                    out.write("  → note recorded\n")
                continue
            if choice == "v":
                if editor_fn:
                    editor_fn(p)
                else:
                    _open_in_editor(paths, p, out=out)
                continue
            if choice == "a":
                applied = _apply(p, paths=paths, audit=audit, run_id=rid, out=out)
                if applied:
                    proposals.set_status(p.id, "applied")
                    out.write("  → applied\n")
                break
            out.write(f"  unknown choice: {choice!r} — try a/r/s/v/n/q\n")
    return 0


def _apply(p: Proposal, *, paths: VaultPaths, audit: Auditor,
           run_id: str, out: TextIO) -> bool:
    action = p.suggested_action
    if action == "supersede_M_with_N":
        # M (source) is older/wrong; N (target) replaces it
        return _apply_supersede(
            paths, audit, p,
            loser_id=p.source_id, winner_id=p.target_id, run_id=run_id,
        )
    if action == "supersede_N_with_M":
        return _apply_supersede(
            paths, audit, p,
            loser_id=p.target_id, winner_id=p.source_id, run_id=run_id,
        )
    if action == "merge":
        out.write(
            "  merge requires manual editing — open both files in $EDITOR\n"
            "  then write a new memory with supersedes: [M_id, N_id] by hand.\n"
            "  marking proposal as rejected for now; re-create the proposal "
            "if you want it back.\n"
        )
        # In v0.1 we leave the proposal as pending (skip semantics); user owns the manual flow.
        return False
    if action in ("both_active_different_facets", "none"):
        # Sonnet was wrong about the contradiction; auto-mark rejected.
        audit.write({
            "op": "proposal_rejected",
            "agent": "human", "session": run_id,
            "proposal_id": p.id,
            "reason": "no_real_contradiction",
        })
        out.write("  → no real contradiction; marked rejected\n")
        # Caller will set_status to applied, but we override: caller checks return
        # We'll signal "applied=False" but the proposal IS resolved (status rejected).
        # Set status here directly to keep semantics tight.
        handle = open_proposals(paths.proposals_file)
        handle.set_status(p.id, "rejected")
        return False
    out.write(f"  unknown suggested_action: {action!r}; skipping\n")
    return False


def _open_in_editor(paths: VaultPaths, p: Proposal, *, out: TextIO) -> None:
    editor = os.environ.get("EDITOR") or "vi"
    files: list[str] = []
    for mid in (p.source_id, p.target_id):
        loc = _find_memory_file(paths, mid)
        if loc:
            files.append(str(loc[0]))
    if not files:
        out.write("  no canonical files found for this proposal\n")
        return
    try:
        subprocess.run([editor, *files], check=False)
    except FileNotFoundError:
        out.write(f"  $EDITOR ({editor!r}) not found\n")
    except Exception as e:
        out.write(f"  editor failed: {e}\n")


def main_review(vault: str | None, *,
                filter_kind: str | None = None,
                filter_severity: str | None = None,
                filter_project: str | None = None) -> int:
    resolved = resolve_vault_path(flag=vault, env=os.environ.get("VAULT_MEM_PATH"))
    return cmd_review(
        resolved,
        filter_kind=filter_kind,
        filter_severity=filter_severity,
        filter_project=filter_project,
    )
