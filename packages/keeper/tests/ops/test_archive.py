from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas, parse_memory_file
from vault_mem_keeper.ops.archive import run_archive
from vault_mem_keeper.paths import vault_paths


def _write_canonical(
    vault_root: Path,
    mid: str,
    *,
    type_: str = "observation",
    confidence: float = 0.8,
    ttl_days: int | None = None,
    updated_days_ago: int = 0,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir(type_)).mkdir(parents=True, exist_ok=True)
    updated = (
        (datetime.now(UTC) - timedelta(days=updated_days_ago)).isoformat().replace("+00:00", "Z")
    )
    fm = {
        "id": mid, "type": type_, "title": f"T {mid}",
        "agent": "human", "session": None,
        "created": updated, "updated": updated,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": ttl_days, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file(type_, mid, "memory")).write_text(frontmatter.dumps(post))


def test_archives_ttl_expired(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_aaaaaa", ttl_days=1, updated_days_ago=2)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    assert not Path(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "memory")).exists()
    assert Path(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "archive")).exists()
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "archive"))
    assert fm["status"] == "archived"
    assert report.archived == 1


def test_archives_low_confidence(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_bbbbbb", confidence=0.2, updated_days_ago=0)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_bbbbbb", "archive")).exists()


def test_keeps_active_high_confidence_no_ttl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_cccccc", confidence=0.8, ttl_days=None)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_cccccc", "memory")).exists()
    assert not Path(paths.memory_file("observation", "mem_2026-04-27_cccccc", "archive")).exists()


def test_dry_run_does_not_move(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_dddddd", ttl_days=1, updated_days_ago=2)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_archive(paths, cfg, schemas, audit, dry_run=True, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_dddddd", "memory")).exists()
    assert report.archived == 1   # would-archive count
