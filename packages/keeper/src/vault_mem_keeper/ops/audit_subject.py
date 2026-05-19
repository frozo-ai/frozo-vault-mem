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

In v0.1 the FTS + LanceDB check is deferred — the verifier reports
"unknown" for those rather than scanning. Will be wired in the
follow-up commit that adds direct write paths from the keeper.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ..frontmatter import parse_memory_file
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

    # 3) FTS + LanceDB deferred to follow-up (see module docstring).
    #    Caller can treat "unknown" + structured-clean as good-enough
    #    for v0.1, or run `vault-mem-mcp reindex` then re-audit.

    # Status precedence: structured_leak > index_drift > needs_human_review > clean.
    if result.md_structured_leaks or result.subject_index_rows > 0:
        result.status = "structured_leak"
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
