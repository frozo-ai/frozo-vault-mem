"""Integration test for the subject-mention reindex op.

Asserts that scanning a real vault layout (inbox + memory + archive)
populates the subject-mentions index for the right files only,
exercises the canonical path-resolution glue, and that re-running is
idempotent.
"""

from datetime import UTC, datetime
from pathlib import Path

import frontmatter

from vault_mem_keeper.ops.reindex_subjects import run_reindex_subjects
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.subject_index import SubjectIndex


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _write(
    vault_root: Path,
    mid: str,
    location: str,  # "inbox" | "memory" | "archive"
    type_: str = "observation",
    *,
    tags: list[str] | None = None,
    sources: list[str] | None = None,
    entity_kind: str | None = None,
) -> None:
    paths = vault_paths(str(vault_root))
    if location == "archive":
        path = Path(paths.memory_file(type_, mid, "archive"))
    elif location == "inbox":
        path = Path(paths.memory_file(type_, mid, "inbox"))
    else:
        path = Path(paths.memory_file(type_, mid, "memory"))
    path.parent.mkdir(parents=True, exist_ok=True)

    fm = {
        "id": mid,
        "type": type_,
        "title": f"T {mid}",
        "agent": "human",
        "session": None,
        "created": _now_iso(),
        "updated": _now_iso(),
        "confidence": 0.8,
        "sources": sources or [],
        "contradicts": [],
        "supersedes": [],
        "tags": tags or [],
        "project": None,
        "ttl_days": None,
        "status": "active",
        "human_reviewed": False,
        "human_approved": None,
        "schema_version": "0.1",
    }
    if entity_kind is not None:
        fm["entity_kind"] = entity_kind
    Path(path).write_text(frontmatter.dumps(frontmatter.Post("body", **fm)))


def test_scans_inbox_and_memory_skips_archive(tmp_vault: Path) -> None:
    _write(tmp_vault, "mem_inbox_1", "inbox", tags=["email:a@b.com"])
    _write(tmp_vault, "mem_canonical_1", "memory", tags=["github:ashish"])
    _write(tmp_vault, "mem_archived_1", "archive", tags=["email:should@notindex.com"])

    paths = vault_paths(str(tmp_vault))
    report = run_reindex_subjects(paths)

    # inbox + canonical scanned, archive ignored. Template ships with 1
    # sample memory in memory/, which has no subject-bearing tags, so
    # `scanned` reflects 2 user-written + however many template files.
    assert report.scanned >= 2
    assert report.mentions_written == 2
    assert report.distinct_subjects == 2

    idx = SubjectIndex(paths.subjects_db)
    try:
        assert len(idx.list_for_subject("email:a@b.com")) == 1
        assert len(idx.list_for_subject("github:ashish")) == 1
        # archived memory must NOT appear
        assert idx.list_for_subject("email:should@notindex.com") == []
    finally:
        idx.close()


def test_idempotent_on_rerun(tmp_vault: Path) -> None:
    _write(tmp_vault, "mem_1", "memory", tags=["email:a@b.com"])
    _write(tmp_vault, "mem_2", "memory", sources=["slack:T0:U0"])

    paths = vault_paths(str(tmp_vault))
    r1 = run_reindex_subjects(paths)
    r2 = run_reindex_subjects(paths)

    # Same mention rows; counts should match.
    assert r1.mentions_written == r2.mentions_written
    assert r1.distinct_subjects == r2.distinct_subjects

    idx = SubjectIndex(paths.subjects_db)
    try:
        assert idx.count() == 2
    finally:
        idx.close()


def test_extraction_change_repopulates_correctly(tmp_vault: Path) -> None:
    """After reindex, change a memory's tags and re-run. The stale
    subject row should be gone; the new one should be present."""
    _write(tmp_vault, "mem_x", "memory", tags=["email:before@x.com"])
    paths = vault_paths(str(tmp_vault))
    run_reindex_subjects(paths)

    # Rewrite the same file with different tags
    _write(tmp_vault, "mem_x", "memory", tags=["email:after@x.com"])
    run_reindex_subjects(paths)

    idx = SubjectIndex(paths.subjects_db)
    try:
        assert idx.list_for_subject("email:before@x.com") == []
        assert len(idx.list_for_subject("email:after@x.com")) == 1
    finally:
        idx.close()


def test_dry_run_does_not_create_db_file(tmp_vault: Path) -> None:
    _write(tmp_vault, "mem_1", "memory", tags=["email:a@b.com"])

    paths = vault_paths(str(tmp_vault))
    report = run_reindex_subjects(paths, dry_run=True)

    # The report still reflects what WOULD be written
    assert report.mentions_written == 1
    assert report.distinct_subjects == 1
    # db file should NOT exist after dry-run
    assert not Path(paths.subjects_db).exists()


def test_person_entity_promotes_to_primary_subject(tmp_vault: Path) -> None:
    _write(
        tmp_vault,
        "mem_priya",
        "memory",
        type_="entity",
        entity_kind="person",
        tags=["github:priya"],
    )

    paths = vault_paths(str(tmp_vault))
    run_reindex_subjects(paths)

    idx = SubjectIndex(paths.subjects_db)
    try:
        rows = idx.list_for_subject("github:priya")
        assert len(rows) == 1
        assert rows[0].kind == "primary_subject"
    finally:
        idx.close()


def test_empty_vault_reports_zero(tmp_vault: Path) -> None:
    # The bundled vault-template ships with the smoke memory in memory/
    # decisions/ — that's fine; what matters is that reindex over a
    # vault with no subject-bearing memories writes 0 mentions.
    paths = vault_paths(str(tmp_vault))
    report = run_reindex_subjects(paths)
    assert report.mentions_written == 0
    assert report.distinct_subjects == 0
