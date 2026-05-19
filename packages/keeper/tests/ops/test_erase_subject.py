"""Tests for the DPDP/GDPR erasure cascade (Phase 2)."""

from datetime import UTC, datetime
from pathlib import Path

import frontmatter

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.ops.audit_subject import (
    run_audit_subject,
    status_to_exit_code,
)
from vault_mem_keeper.ops.erase_subject import run_erase_subject
from vault_mem_keeper.ops.reindex_subjects import run_reindex_subjects
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.subject_index import SubjectIndex


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _write_memory(
    vault_root: Path,
    mid: str,
    location: str,
    type_: str = "observation",
    *,
    tags: list[str] | None = None,
    sources: list[str] | None = None,
    entity_kind: str | None = None,
    body: str = "body",
) -> None:
    paths = vault_paths(str(vault_root))
    path = Path(paths.memory_file(type_, mid, location))
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
    Path(path).write_text(frontmatter.dumps(frontmatter.Post(body, **fm)))


# ---------- full_delete path -------------------------------------------


def test_person_entity_gets_full_delete(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault,
        "mem_priya",
        "memory",
        type_="entity",
        entity_kind="person",
        tags=["github:priya"],
    )
    run_reindex_subjects(paths)

    auditor = Auditor(paths.audit_file)
    report = run_erase_subject(paths, "github:priya", reason="DPDP test", auditor=auditor)

    assert report.full_deletes == 1
    assert report.scrubs == 0
    assert report.manual_review_required == 0
    # Original file gone
    assert not Path(paths.memory_file("entity", "mem_priya", "memory")).exists()
    # Stub at archive/erased/
    stub = Path(tmp_vault, "archive", "erased", "mem_priya.md")
    assert stub.exists()
    # Stub has the right shape
    post = frontmatter.load(str(stub))
    assert post.metadata["status"] == "erased"
    assert post.metadata["original_type"] == "entity"
    assert post.metadata["title"] == "(erased)"
    # Subject id should NOT appear in the stub body or frontmatter
    assert "github:priya" not in str(post.content)
    assert "github:priya" not in str(post.metadata.get("tags") or [])
    # Hashed forensic fields present (non-PII)
    assert post.metadata["erasure_subject_hash"].startswith("sha256:")
    assert post.metadata["erasure_reason_hash"].startswith("sha256:")


def test_full_delete_prunes_index(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    run_reindex_subjects(paths)
    run_erase_subject(paths, "email:a@b.com", reason="r")

    idx = SubjectIndex(paths.subjects_db)
    try:
        assert idx.list_for_subject("email:a@b.com") == []
    finally:
        idx.close()


# ---------- scrub path -------------------------------------------------


def test_tag_mention_gets_scrubbed(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_x", "memory",
        tags=["email:bob@x.com", "vault-mem", "phase-2"],
    )
    run_reindex_subjects(paths)

    auditor = Auditor(paths.audit_file)
    report = run_erase_subject(paths, "email:bob@x.com", reason="r", auditor=auditor)
    assert report.scrubs == 1
    assert report.full_deletes == 0

    # File still in place, but subject tag is gone; other tags survive.
    path = Path(paths.memory_file("observation", "mem_x", "memory"))
    assert path.exists()
    fm = dict(frontmatter.load(str(path)).metadata)
    assert "email:bob@x.com" not in fm["tags"]
    assert "vault-mem" in fm["tags"]
    assert "phase-2" in fm["tags"]


def test_source_author_gets_scrubbed(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_y", "memory",
        sources=["slack:T0:U0", "https://other.example/post"],
    )
    run_reindex_subjects(paths)
    run_erase_subject(paths, "slack:T0:U0", reason="r")

    fm = dict(frontmatter.load(
        paths.memory_file("observation", "mem_y", "memory")
    ).metadata)
    assert "slack:T0:U0" not in fm["sources"]
    assert "https://other.example/post" in fm["sources"]


def test_case_variant_scrubbed(tmp_vault: Path) -> None:
    """Tag in original case ('Email:Bob@X.com') should be scrubbed even
    though subject_id is canonical lowercase ('email:bob@x.com')."""
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_y", "memory", tags=["Email:Bob@X.com"],
    )
    run_reindex_subjects(paths)
    run_erase_subject(paths, "email:bob@x.com", reason="r")
    fm = dict(frontmatter.load(
        paths.memory_file("observation", "mem_y", "memory")
    ).metadata)
    assert fm["tags"] == []


# ---------- dry-run ----------------------------------------------------


def test_dry_run_classifies_without_acting(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    _write_memory(
        tmp_vault, "mem_b", "memory",
        tags=["email:a@b.com", "x"],
    )
    run_reindex_subjects(paths)

    report = run_erase_subject(paths, "email:a@b.com", reason="", dry_run=True)
    assert report.full_deletes == 1
    assert report.scrubs == 1
    # Files untouched
    assert Path(paths.memory_file("entity", "mem_a", "memory")).exists()
    fm_b = dict(frontmatter.load(
        paths.memory_file("observation", "mem_b", "memory")
    ).metadata)
    assert "email:a@b.com" in fm_b["tags"]
    # Index untouched
    idx = SubjectIndex(paths.subjects_db)
    try:
        assert len(idx.list_for_subject("email:a@b.com")) == 2
    finally:
        idx.close()


def test_idempotent_on_rerun(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    run_reindex_subjects(paths)
    r1 = run_erase_subject(paths, "email:a@b.com", reason="r")
    assert r1.full_deletes == 1
    # Re-run: nothing left to erase
    r2 = run_erase_subject(paths, "email:a@b.com", reason="r")
    assert r2.full_deletes == 0
    assert r2.scrubs == 0


def test_reason_required_for_non_dry(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    try:
        run_erase_subject(paths, "email:a@b.com", reason="", dry_run=False)
    except ValueError as e:
        assert "reason is required" in str(e)
    else:
        raise AssertionError("expected ValueError")


# ---------- audit-subject verifier -------------------------------------


def test_audit_subject_clean_after_erase(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    run_reindex_subjects(paths)
    run_erase_subject(paths, "email:a@b.com", reason="r")

    result = run_audit_subject(paths, "email:a@b.com")
    assert result.status == "clean"
    assert status_to_exit_code(result.status) == 0


def test_audit_subject_detects_structured_leak(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(tmp_vault, "mem_x", "memory", tags=["email:leak@x.com"])
    run_reindex_subjects(paths)
    # Skip erasure — subject is still there.
    result = run_audit_subject(paths, "email:leak@x.com")
    assert result.status == "structured_leak"
    assert len(result.md_structured_leaks) == 1
    assert result.subject_index_rows == 1
    assert status_to_exit_code(result.status) == 1


def test_audit_subject_detects_body_mention(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    # No structured mention, but body contains the subject id literally.
    _write_memory(
        tmp_vault, "mem_y", "memory",
        tags=["vault-mem"],
        body="had a call with email:body@x.com about the launch",
    )
    # No reindex needed for body-only check
    result = run_audit_subject(paths, "email:body@x.com")
    assert result.status == "needs_human_review"
    assert len(result.md_body_mentions) == 1
    assert status_to_exit_code(result.status) == 2


def test_audit_subject_skips_archive(tmp_vault: Path) -> None:
    """An erased subject's stub lives at archive/erased/. The verifier
    must NOT scan archive/ (the stub contains hashed-id metadata which
    is fine to retain)."""
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:archived@x.com"],
    )
    run_reindex_subjects(paths)
    run_erase_subject(paths, "email:archived@x.com", reason="r")
    # Confirm stub exists in archive/erased/ — but verifier should ignore it.
    assert Path(tmp_vault, "archive", "erased", "mem_a.md").exists()
    result = run_audit_subject(paths, "email:archived@x.com")
    assert result.status == "clean"


# ---------- audit log emission -----------------------------------------


def test_audit_log_records_per_memory_and_summary(tmp_vault: Path) -> None:
    import json as _json

    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    _write_memory(
        tmp_vault, "mem_b", "memory", tags=["email:a@b.com", "x"],
    )
    run_reindex_subjects(paths)

    auditor = Auditor(paths.audit_file)
    run_erase_subject(paths, "email:a@b.com", reason="DPDP", auditor=auditor)

    lines = Path(paths.audit_file).read_text().splitlines()
    ops = [_json.loads(line) for line in lines if line.strip()]
    op_names = [o.get("op") for o in ops]
    assert "subject_erased" in op_names
    assert "subject_erased_complete" in op_names
    # One per affected memory + one final summary
    assert op_names.count("subject_erased") == 2
    assert op_names.count("subject_erased_complete") == 1
    # All entries use hashed subject id, NOT the plaintext
    for o in ops:
        if o.get("op") in {"subject_erased", "subject_erased_complete"}:
            assert "subject_id_hash" in o
            assert "subject_id" not in o
            assert "reason" not in o  # plaintext reason MUST NOT leak


def test_erasure_requests_jsonl_records_plaintext(tmp_vault: Path) -> None:
    """The audit log keeps hashes; the controller-private
    `erasure_requests.jsonl` keeps plaintext (separate retention scope,
    spec §7). Verify it exists after a non-dry erasure."""
    import json as _json

    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:a@b.com"],
    )
    run_reindex_subjects(paths)

    # Use the CLI codepath via importing the helper directly.
    from vault_mem_keeper.ops.erase_subject import _record_erasure_request

    _record_erasure_request(paths, "email:a@b.com", "DPDP SAR ticket #42", _now_iso())
    run_erase_subject(paths, "email:a@b.com", reason="DPDP SAR ticket #42",
                      auditor=Auditor(paths.audit_file))

    log = Path(paths.system_dir, "erasure_requests.jsonl")
    assert log.exists()
    last = _json.loads(log.read_text().strip().splitlines()[-1])
    assert last["subject_id"] == "email:a@b.com"
    assert last["reason"] == "DPDP SAR ticket #42"
