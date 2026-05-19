"""Tests for the DPDP/GDPR erasure cascade (Phase 2)."""

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import frontmatter
import lancedb

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.ops.audit_subject import (
    run_audit_subject,
    status_to_exit_code,
)
from vault_mem_keeper.ops.erase_subject import run_erase_subject
from vault_mem_keeper.ops.reindex_subjects import run_reindex_subjects
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.subject_index import SubjectIndex

EMBED_DIM = 384


def _seed_fts_row(index_path: str, memory_id: str) -> None:
    """Materialize the FTS schema + one row for `memory_id`. Mirrors
    TS-side `ensureSchema` so the keeper write helper can DELETE
    against a real virtual table."""
    Path(index_path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(index_path)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    db.execute(
        "INSERT INTO memories_fts"
        " (id,type,title,body,tags,project,status,location,path,updated)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            memory_id, "decision", "T", "b",
            json.dumps([]), None, "active", "memory",
            f"/v/memory/decisions/{memory_id}.md", _now_iso(),
        ),
    )
    db.commit()
    db.close()


def _seed_lance_row(lance_dir: str, memory_id: str) -> None:
    """Materialize a Lance table with one row for `memory_id`."""
    Path(lance_dir).parent.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(lance_dir)
    row = {
        "id": memory_id,
        "vector": [0.05] * EMBED_DIM,
        "type": "decision",
        "title": "T",
        "project": "p",
        "tags": [],
        "status": "active",
        "location": "memory",
        "path": f"/v/memory/decisions/{memory_id}.md",
        "updated": _now_iso(),
        "schema_version": "0.1",
        "embed_model": "test",
    }
    db.create_table("memories", [row])


def _hash(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


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


# ---------- FTS + Lance integration ------------------------------------


def test_full_delete_drops_fts_row(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:fts@x.com"],
    )
    # Pre-seed FTS row for mem_a
    _seed_fts_row(paths.index_file, "mem_a")

    run_reindex_subjects(paths)
    report = run_erase_subject(paths, "email:fts@x.com", reason="r")

    assert report.full_deletes == 1
    assert report.fts_rows_dropped == 1
    # FTS row should be gone
    db = sqlite3.connect(f"file:{paths.index_file}?mode=ro", uri=True)
    try:
        n = db.execute(
            "SELECT COUNT(*) FROM memories_fts WHERE id = ?", ("mem_a",)
        ).fetchone()[0]
        assert n == 0
    finally:
        db.close()


def test_full_delete_drops_lance_row(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:lance@x.com"],
    )
    # Pre-seed Lance row for mem_a
    _seed_lance_row(paths.lance_dir, "mem_a")

    run_reindex_subjects(paths)
    report = run_erase_subject(paths, "email:lance@x.com", reason="r")

    assert report.full_deletes == 1
    assert report.lance_rows_dropped == 1
    # Lance row should be gone
    db = lancedb.connect(paths.lance_dir)
    table = db.open_table("memories")
    rows = table.search().where("id = 'mem_a'").limit(2).to_list()
    assert rows == []


def test_scrub_leaves_fts_and_lance_alone(tmp_vault: Path) -> None:
    """Spec invariant: scrub rewrites the .md in place; chokidar
    handles re-indexing. The cascade itself MUST NOT drop FTS/Lance
    rows for scrubbed memories (they're still active)."""
    paths = vault_paths(str(tmp_vault))
    _write_memory(tmp_vault, "mem_a", "memory", tags=["email:scrub@x.com", "vault-mem"])
    _seed_fts_row(paths.index_file, "mem_a")
    _seed_lance_row(paths.lance_dir, "mem_a")

    run_reindex_subjects(paths)
    report = run_erase_subject(paths, "email:scrub@x.com", reason="r")

    assert report.scrubs == 1
    assert report.fts_rows_dropped == 0
    assert report.lance_rows_dropped == 0
    # Rows still present
    db = sqlite3.connect(f"file:{paths.index_file}?mode=ro", uri=True)
    try:
        n = db.execute(
            "SELECT COUNT(*) FROM memories_fts WHERE id = ?", ("mem_a",)
        ).fetchone()[0]
        assert n == 1
    finally:
        db.close()


def test_audit_subject_reports_checked_after_erase(tmp_vault: Path) -> None:
    """Once the cascade has produced an archive/erased/ stub, the
    verifier knows which memory_ids to check FTS+Lance for, so the
    status moves from 'unknown' to 'checked'."""
    paths = vault_paths(str(tmp_vault))
    _write_memory(
        tmp_vault, "mem_a", "memory",
        type_="entity", entity_kind="person", tags=["email:checked@x.com"],
    )
    _seed_fts_row(paths.index_file, "mem_a")
    _seed_lance_row(paths.lance_dir, "mem_a")
    run_reindex_subjects(paths)
    run_erase_subject(paths, "email:checked@x.com", reason="r")

    result = run_audit_subject(paths, "email:checked@x.com")
    assert result.status == "clean"
    assert result.fts_status == "checked"
    assert result.lance_status == "checked"
    assert result.fts_drift_rows == 0
    assert result.lance_drift_rows == 0
    assert result.erased_memory_ids == ["mem_a"]


def test_audit_subject_detects_index_drift(tmp_vault: Path) -> None:
    """Simulate cascade-half-done: archive/erased/ stub exists but FTS
    still has the row. Verifier reports `index_drift` exit code 3."""
    paths = vault_paths(str(tmp_vault))
    # Manually plant an erased stub (no original active memory; simulates
    # a cascade where the .md move + index pruning succeeded but the
    # FTS delete failed).
    erased_dir = Path(paths.root, "archive", "erased")
    erased_dir.mkdir(parents=True, exist_ok=True)
    target_hash = _hash("email:drift@x.com")
    stub_fm = {
        "id": "mem_a", "type": "archived", "title": "(erased)",
        "agent": "human", "session": None,
        "created": _now_iso(), "updated": _now_iso(),
        "confidence": 0.0, "sources": [], "contradicts": [],
        "supersedes": [], "tags": [], "project": None,
        "ttl_days": None, "status": "erased",
        "human_reviewed": True, "human_approved": False,
        "schema_version": "0.1",
        "erased_at": _now_iso(),
        "erasure_reason_hash": _hash("r"),
        "erasure_subject_hash": target_hash,
        "original_type": "entity",
        "original_project": None,
    }
    (erased_dir / "mem_a.md").write_text(
        frontmatter.dumps(frontmatter.Post("(redacted)", **stub_fm))
    )
    # FTS still has the stale row
    _seed_fts_row(paths.index_file, "mem_a")

    result = run_audit_subject(paths, "email:drift@x.com")
    assert result.status == "index_drift"
    assert result.fts_drift_rows == 1
    assert result.erased_memory_ids == ["mem_a"]
    assert status_to_exit_code(result.status) == 3


def test_audit_subject_no_stubs_no_drift_check(tmp_vault: Path) -> None:
    """Subject was never erased (no stubs). Verifier returns clean
    with fts_status='checked' (vacuously — no ids to check)."""
    paths = vault_paths(str(tmp_vault))
    result = run_audit_subject(paths, "email:never@x.com")
    assert result.status == "clean"
    assert result.fts_status == "checked"
    assert result.lance_status == "checked"
    assert result.erased_memory_ids == []


def _now_iso_for_helper() -> str:
    # Local shim because fixtures don't share helpers across files.
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
