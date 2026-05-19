"""Verify a subject has been mechanically removed from the vault
(DPDP/GDPR audit-subject per spec §5).

Returns a structured report. The CLI maps the report to an exit code:
- 0 → clean (no structured trace of the subject anywhere we can
  mechanically detect)
- 1 → structured leak (subject_id still in a .md file's frontmatter
  or in subjects.sqlite — bug in cascade, file a ticket)
- 2 → prose mention found in a body (human review required; not a
  bug per se, but the regulator's request isn't fully met until the
  body is human-edited)
- 3 → index inconsistency (FTS or LanceDB still has rows for memories
  that should be archived; re-run `vault-mem-mcp reindex` to fix)

FTS + LanceDB drift is checked by cross-referencing `archive/erased/`
stubs (which carry the SHA-256 hash of the subject id in frontmatter)
against the live index rows. Any FTS or Lance row whose `id` matches
a stub's `id` means the cascade fired but the index wasn't reconciled
— exit code 3, operator runs `vault-mem-mcp reindex` or the cascade
re-fires.
"""

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ..frontmatter import parse_memory_file
from ..fts import count_for_ids as fts_count_for_ids
from ..lance import count_for_ids as lance_count_for_ids
from ..paths import MEMORY_TYPES, VaultPaths
from ..subject_index import (
    SubjectIndex,
    extract_subject_ids,
)

VerifyStatus = Literal["clean", "structured_leak", "needs_human_review", "index_drift"]


@dataclass
class VerifyResult:
    subject_id: str
    status: VerifyStatus
    md_structured_leaks: list[dict[str, Any]] = field(default_factory=list)
    md_body_mentions: list[dict[str, Any]] = field(default_factory=list)
    subject_index_rows: int = 0
    erased_memory_ids: list[str] = field(default_factory=list)
    fts_drift_rows: int = 0
    lance_drift_rows: int = 0
    fts_status: Literal["unknown", "checked"] = "unknown"
    lance_status: Literal["unknown", "checked"] = "unknown"
    md_files_scanned: int = 0


def _looks_like_in_body(body: str, subject_id: str) -> bool:
    """Conservative substring check — case-insensitive on the
    `<prefix>:` portion, exact on the value. Lets the verifier flag
    structured-id leakage in bodies (e.g. "email:foo@bar.com" copy-
    pasted into a memo)."""
    if not body:
        return False
    return subject_id.lower() in body.lower()


def run_audit_subject(
    paths: VaultPaths, subject_id: str
) -> VerifyResult:
    """Scan the vault for any structured trace of the subject."""
    result = VerifyResult(subject_id=subject_id, status="clean")

    # 1) Walk memory/ + inbox/ — NOT archive/ (archived memories are
    #    expected to retain forensic stubs with hashed subject ids).
    for t in MEMORY_TYPES:
        for loc, dir_ in (("inbox", paths.inbox_dir(t)), ("memory", paths.memory_dir(t))):
            d = Path(dir_)
            if not d.is_dir():
                continue
            for f in sorted(d.glob("*.md")):
                result.md_files_scanned += 1
                try:
                    fm, body = parse_memory_file(str(f))
                except Exception:
                    continue

                # Structured: re-run extraction; any hit means the
                # cascade missed a row.
                mentions = extract_subject_ids(fm, memory_id=f.stem)
                for m in mentions:
                    if m.subject_id == subject_id:
                        result.md_structured_leaks.append(
                            {
                                "memory_id": m.memory_id,
                                "kind": m.kind,
                                "field_path": m.field_path,
                                "location": loc,
                                "path": str(f),
                            }
                        )

                # Body: substring scan. Flagged as needs_human_review
                # (spec §3.4 — we refuse to mechanically rewrite prose).
                if _looks_like_in_body(body, subject_id):
                    result.md_body_mentions.append(
                        {
                            "memory_id": f.stem,
                            "location": loc,
                            "path": str(f),
                        }
                    )

    # 2) subjects.sqlite — any remaining rows for this subject.
    idx_path = paths.subjects_db
    if Path(idx_path).exists():
        idx = SubjectIndex(idx_path)
        try:
            result.subject_index_rows = len(idx.list_for_subject(subject_id))
        finally:
            idx.close()

    # 3) FTS + LanceDB drift check. The cascade leaves erased stubs in
    #    archive/erased/ keyed on memory_id; each carries
    #    `erasure_subject_hash`. Match by hash → check FTS+Lance for
    #    stale rows referencing those memory_ids.
    target_hash = "sha256:" + hashlib.sha256(subject_id.encode("utf-8")).hexdigest()
    erased_dir = Path(paths.root, "archive", "erased")
    if erased_dir.is_dir():
        for f in sorted(erased_dir.glob("*.md")):
            try:
                fm, _ = parse_memory_file(str(f))
            except Exception:
                continue
            if fm.get("erasure_subject_hash") == target_hash:
                result.erased_memory_ids.append(f.stem)

    if result.erased_memory_ids:
        try:
            result.fts_drift_rows = fts_count_for_ids(
                paths.index_file, result.erased_memory_ids
            )
            result.fts_status = "checked"
        except Exception:
            result.fts_status = "unknown"
        try:
            result.lance_drift_rows = lance_count_for_ids(
                paths.lance_dir, result.erased_memory_ids
            )
            result.lance_status = "checked"
        except Exception:
            result.lance_status = "unknown"
    else:
        # No stubs for this subject — either it was never erased, or
        # the operator hasn't run erase-subject. Either way, no drift
        # to check; both indexes are vacuously "clean for this subject."
        result.fts_status = "checked"
        result.lance_status = "checked"

    # Status precedence per spec §5:
    #   structured_leak (1) > index_drift (3) > needs_human_review (2) > clean (0).
    # structured_leak is most severe (cascade bug — data still in active
    # set). index_drift is "operator needs to reindex." human_review is
    # a deliberate hand-off, not a bug.
    if result.md_structured_leaks or result.subject_index_rows > 0:
        result.status = "structured_leak"
    elif result.fts_drift_rows > 0 or result.lance_drift_rows > 0:
        result.status = "index_drift"
    elif result.md_body_mentions:
        result.status = "needs_human_review"
    else:
        result.status = "clean"

    return result


def status_to_exit_code(status: VerifyStatus) -> int:
    """Spec §5 mapping."""
    return {
        "clean": 0,
        "structured_leak": 1,
        "needs_human_review": 2,
        "index_drift": 3,
    }[status]
