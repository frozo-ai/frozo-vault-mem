"""DPDP/GDPR per-subject erasure cascade (spec §4).

Reads `_system/subjects.sqlite` for the target subject, decides per
mention whether to full-delete the memory (move to `archive/erased/`
with a stub) or scrub (filter the subject from `tags`/`sources`), then
prunes the subject from the index and emits audit-log entries.

v0.1 scope (this commit):
- `.md` cascade: full_delete + scrub paths.
- `subjects.sqlite` cleanup.
- Audit log emission: `subject_erased` per memory + final
  `subject_erased_complete`.
- TTY confirm prompt + `--no-confirm` (gatekeeper not yet wired in OSS
  keeper; spec §6.2 + Q5 decision).

NOT in this commit (verifier reports as drift / user re-runs reindex):
- Direct FTS row deletion in `_system/index.sqlite`.
- Direct LanceDB row deletion in `_system/embeddings.lance`.
- Body-text mention scrubbing (spec §3.4 — refused mechanically; a
  `body_match` mention type emits `manual_redaction_required`
  proposals instead, deferred to keeper link op).

The cascade is **idempotent**: re-running for the same subject after a
successful run finds zero mentions in the index and returns cleanly.
"""

import hashlib
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..audit import Auditor
from ..frontmatter import parse_memory_file, serialize_memory
from ..fts import delete_by_ids as fts_delete_by_ids
from ..lance import delete_by_ids as lance_delete_by_ids
from ..paths import MEMORY_TYPES, VaultPaths
from ..subject_index import (
    SUBJECT_PREFIXES,
    Mention,
    SubjectIndex,
)


@dataclass
class MemoryAction:
    """One scheduled action against one memory file."""

    memory_id: str
    action: str  # "full_delete" | "scrub" | "manual_review_only"
    abs_path: str
    location: str  # "inbox" | "memory" — archive memories aren't touched (spec §4)
    relevant_mentions: list[Mention] = field(default_factory=list)


@dataclass
class EraseReport:
    subject_id: str
    subject_id_hash: str
    reason_hash: str
    dry_run: bool
    actions: list[MemoryAction] = field(default_factory=list)
    full_deletes: int = 0
    scrubs: int = 0
    manual_review_required: int = 0
    skipped_already_archived: int = 0
    skipped_missing_file: int = 0
    index_rows_pruned: int = 0
    fts_rows_dropped: int = 0
    lance_rows_dropped: int = 0
    duration_ms: int = 0


def _hash(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


def _decide_action(mentions: Iterable[Mention]) -> str:
    """Spec §4.1 decision matrix.

    Simplified for the OSS schema (no rich source jsonb):
    - any `primary_subject` mention → full_delete (this memory IS about
      the subject)
    - any `source_author` mention → scrub (subject is the author of an
      ingested source; remove the source string + tag and keep the
      memory)
    - only `tag` mentions → scrub (incidental tag reference)
    - only `body_match` mentions → manual_review_only (we refuse to
      machine-rewrite prose; spec §3.4)
    """
    kinds = {m.kind for m in mentions}
    if "primary_subject" in kinds:
        return "full_delete"
    if "source_author" in kinds or "tag" in kinds:
        return "scrub"
    if kinds == {"body_match"}:
        return "manual_review_only"
    # Empty/unexpected — defer to manual review
    return "manual_review_only"


# Strings starting with one of the canonical prefixes (any case in the
# value but exact-prefix match on the well-known label). Used to filter
# `tags` and `sources` arrays during scrub. Mirrors subject_index.SUBJECT_PREFIXES.
_PREFIX_RE = re.compile(
    r"^(?:" + "|".join(SUBJECT_PREFIXES) + r"):",
    flags=re.IGNORECASE,
)


def _scrub_arr(values: Any, subject_id: str) -> tuple[list[Any], int]:
    """Remove items from a frontmatter list field that match the
    subject id. Returns (new_list, removed_count). Non-list inputs
    pass through unchanged.

    Subject-id match is case-insensitive against canonical prefix +
    exact match on the canonical value (email/github lowercased).
    """
    if not isinstance(values, list):
        return (values if isinstance(values, list) else []), 0
    out: list[Any] = []
    removed = 0
    sid_lower = subject_id.lower()
    for v in values:
        if isinstance(v, str) and _PREFIX_RE.match(v):
            # Canonicalize the value the same way subject_index does
            # so case-variant tag entries get scrubbed even if the
            # subject_id is the canonical form.
            canon = v
            if v.lower().startswith("email:"):
                canon = "email:" + v[6:].lower()
            elif v.lower().startswith("github:"):
                canon = "github:" + v[7:].lower()
            if canon.lower() == sid_lower:
                removed += 1
                continue
        out.append(v)
    return out, removed


def _stub_for(
    fm: dict[str, Any], subject_id_hash: str, reason_hash: str, erased_at_iso: str
) -> dict[str, Any]:
    """Frontmatter for an erased stub per spec §4.2. Keeps minimal
    metadata for our internal audit; body is dropped."""
    return {
        "id": fm.get("id"),
        "type": "archived",  # collapses into the generic archive bucket
        "title": "(erased)",
        "agent": fm.get("agent", "human"),
        "session": None,
        "created": fm.get("created"),
        "updated": erased_at_iso,
        "confidence": 0.0,
        "sources": [],
        "contradicts": [],
        "supersedes": [],
        "tags": [],
        "project": fm.get("project"),
        "ttl_days": None,
        "status": "erased",
        "human_reviewed": True,
        "human_approved": False,
        "schema_version": fm.get("schema_version", "0.1"),
        # Forensic-trail fields — non-PII, allow us to prove the
        # erasure happened for THIS request without retaining the
        # original identifier.
        "erased_at": erased_at_iso,
        "erasure_reason_hash": reason_hash,
        "erasure_subject_hash": subject_id_hash,
        "original_type": fm.get("type"),
        "original_project": fm.get("project"),
    }


def _resolve_path_for(memory_id: str, paths: VaultPaths) -> tuple[str | None, str | None]:
    """Find a memory_id on disk. Returns (abs_path, location) or
    (None, None) if not found in inbox/ or memory/. archive/ is NOT
    searched — archived memories are out of the erasure-active set."""
    for t in MEMORY_TYPES:
        for loc, dir_ in (("inbox", paths.inbox_dir(t)), ("memory", paths.memory_dir(t))):
            p = Path(dir_, f"{memory_id}.md")
            if p.is_file():
                return str(p), loc
    return None, None


def run_erase_subject(
    paths: VaultPaths,
    subject_id: str,
    reason: str,
    *,
    dry_run: bool = False,
    auditor: Auditor | None = None,
    now_iso: str | None = None,
) -> EraseReport:
    """Run the cascade per spec §4. Pure-business-logic — TTY confirm
    + gatekeeper gate live at the CLI layer above this function.

    Idempotent: empty result on re-run after success.
    """
    import time
    from datetime import UTC, datetime

    if not reason and not dry_run:
        raise ValueError("reason is required for non-dry-run erasures")

    start = time.monotonic()
    iso = now_iso or datetime.now(UTC).isoformat().replace("+00:00", "Z")
    subject_id_hash = _hash(subject_id)
    reason_hash = _hash(reason) if reason else _hash("")

    report = EraseReport(
        subject_id=subject_id,
        subject_id_hash=subject_id_hash,
        reason_hash=reason_hash,
        dry_run=dry_run,
    )

    # 1) Look up mentions from the subject-index (read-only).
    idx = SubjectIndex(paths.subjects_db)
    try:
        all_mentions = idx.list_for_subject(subject_id)
    finally:
        idx.close()

    if not all_mentions:
        # Nothing tied to this subject — return cleanly.
        report.duration_ms = int((time.monotonic() - start) * 1000)
        if auditor and not dry_run:
            auditor.write(
                {
                    "op": "subject_erased_complete",
                    "subject_id_hash": subject_id_hash,
                    "count": 0,
                    "duration_ms": report.duration_ms,
                    "verify_status": "noop",
                }
            )
        return report

    # Group by memory_id to make per-memory decisions.
    by_memory: dict[str, list[Mention]] = {}
    for m in all_mentions:
        by_memory.setdefault(m.memory_id, []).append(m)

    # 2) Decide action per memory and resolve files.
    for memory_id, mentions in by_memory.items():
        action = _decide_action(mentions)
        abs_path, location = _resolve_path_for(memory_id, paths)
        if abs_path is None:
            # Memory referenced by the index but not on disk in the
            # active set. Could be already archived (manually), or the
            # index is stale. Either way, we can't act on it through
            # the cascade. Will be reported.
            report.skipped_missing_file += 1
            report.actions.append(
                MemoryAction(
                    memory_id=memory_id,
                    action="skipped_missing_file",
                    abs_path="",
                    location="",
                    relevant_mentions=mentions,
                )
            )
            continue
        report.actions.append(
            MemoryAction(
                memory_id=memory_id,
                action=action,
                abs_path=abs_path,
                location=location or "",
                relevant_mentions=mentions,
            )
        )

    if dry_run:
        # Just classify, don't act.
        for a in report.actions:
            if a.action == "full_delete":
                report.full_deletes += 1
            elif a.action == "scrub":
                report.scrubs += 1
            elif a.action == "manual_review_only":
                report.manual_review_required += 1
        report.duration_ms = int((time.monotonic() - start) * 1000)
        return report

    # 3) Apply per-memory actions.
    # Lazy-import to avoid circulars in unit tests of this module.
    from ..atomic_write import atomic_write

    archive_erased_dir = Path(paths.root, "archive", "erased")
    archive_erased_dir.mkdir(parents=True, exist_ok=True)

    for a in report.actions:
        if a.action == "skipped_missing_file":
            continue

        try:
            fm, body = parse_memory_file(a.abs_path)
        except Exception:
            report.skipped_missing_file += 1
            continue

        if a.action == "full_delete":
            # Write a redacted stub at archive/erased/<id>.md, then
            # remove the original. Done in this order so a crash mid-
            # way leaves the stub but maybe the original — next reindex
            # would see both and prefer the stub (status=erased).
            stub_fm = _stub_for(fm, subject_id_hash, reason_hash, iso)
            stub_path = str(archive_erased_dir / f"{a.memory_id}.md")
            stub_content = "(body redacted per erasure request)"
            atomic_write(stub_path, serialize_memory(stub_fm, stub_content))
            os.unlink(a.abs_path)
            report.full_deletes += 1

        elif a.action == "scrub":
            # Filter the subject_id out of tags + sources, rewrite in
            # place atomically.
            new_tags, removed_tag = _scrub_arr(fm.get("tags"), subject_id)
            new_sources, removed_src = _scrub_arr(fm.get("sources"), subject_id)
            if removed_tag == 0 and removed_src == 0:
                # Inconsistency: index said this memory had a mention,
                # but the frontmatter scan finds none. Treat as a
                # manual-review case to be safe.
                report.manual_review_required += 1
                if auditor:
                    auditor.write(
                        {
                            "op": "manual_redaction_required",
                            "subject_id_hash": subject_id_hash,
                            "memory_id": a.memory_id,
                            "field_path": "tags_or_sources",
                            "note": "index/frontmatter drift",
                        }
                    )
                continue
            patched = dict(fm)
            patched["tags"] = new_tags
            patched["sources"] = new_sources
            patched["updated"] = iso
            atomic_write(a.abs_path, serialize_memory(patched, body))
            report.scrubs += 1

        elif a.action == "manual_review_only":
            report.manual_review_required += 1
            if auditor:
                auditor.write(
                    {
                        "op": "manual_redaction_required",
                        "subject_id_hash": subject_id_hash,
                        "memory_id": a.memory_id,
                        "field_path": "body",
                    }
                )
            # Don't touch the .md — human reviews and edits.
            continue

        # Per-memory audit entry (spec §7 — hashed subject id).
        if auditor:
            auditor.write(
                {
                    "op": "subject_erased",
                    "subject_id_hash": subject_id_hash,
                    "memory_id": a.memory_id,
                    "action": a.action,
                    "reason_hash": reason_hash,
                }
            )

    # 4a) Drop FTS + Lance rows for the full_delete-ed memories. Scrubs
    #     leave them in place — chokidar will re-index the rewritten
    #     .md and the row gets updated metadata. Only full_delete needs
    #     explicit removal so the verifier passes immediately.
    full_delete_ids = [
        a.memory_id for a in report.actions if a.action == "full_delete"
    ]
    if full_delete_ids:
        try:
            report.fts_rows_dropped = fts_delete_by_ids(
                paths.index_file, full_delete_ids
            )
        except Exception:
            # Don't fail the cascade because index drop failed — the
            # .md is the source of truth and chokidar will reconcile.
            report.fts_rows_dropped = 0
        try:
            report.lance_rows_dropped = lance_delete_by_ids(
                paths.lance_dir, full_delete_ids
            )
        except Exception:
            report.lance_rows_dropped = 0

    # 4b) Prune the subject from the subject-mentions index.
    idx = SubjectIndex(paths.subjects_db)
    try:
        report.index_rows_pruned = idx.delete_for_subject(subject_id)
    finally:
        idx.close()

    report.duration_ms = int((time.monotonic() - start) * 1000)

    # 5) Final cascade summary.
    verify_status = (
        "needs_manual_review"
        if report.manual_review_required > 0
        else "ok"
    )
    if auditor:
        auditor.write(
            {
                "op": "subject_erased_complete",
                "subject_id_hash": subject_id_hash,
                "count": report.full_deletes + report.scrubs,
                "manual_review_required": report.manual_review_required,
                "skipped_missing_file": report.skipped_missing_file,
                "duration_ms": report.duration_ms,
                "verify_status": verify_status,
            }
        )

    return report


def _record_erasure_request(
    paths: VaultPaths, subject_id: str, reason: str, iso: str
) -> None:
    """Append the plaintext reason + subject id to a controller-private
    JSONL at `_system/erasure_requests.jsonl` so the operator can prove
    "we acted on this specific request" while the audit log itself
    keeps only hashed values. Gitignored separately."""
    import json

    target = Path(paths.system_dir, "erasure_requests.jsonl")
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {"ts": iso, "subject_id": subject_id, "reason": reason},
        ensure_ascii=False,
    )
    with open(target, "a", encoding="utf-8") as f:
        f.write(line + "\n")
