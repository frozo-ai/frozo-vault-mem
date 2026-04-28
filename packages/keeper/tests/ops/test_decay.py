from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas, parse_memory_file
from vault_mem_keeper.ops.decay import run_decay
from vault_mem_keeper.paths import vault_paths


def _write_canonical_memory(
    vault_root: Path,
    mid: str,
    *,
    type_: str = "observation",
    confidence: float = 1.0,
    last_decay_at: str | None = None,
    updated_days_ago: int = 0,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir(type_)).mkdir(parents=True, exist_ok=True)
    updated = (
        (datetime.now(UTC) - timedelta(days=updated_days_ago)).isoformat().replace("+00:00", "Z")
    )
    fm = {
        "id": mid,
        "type": type_,
        "title": f"Test {mid}",
        "agent": "human",
        "session": None,
        "created": updated,
        "updated": updated,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    if last_decay_at is not None:
        fm["last_decay_at"] = last_decay_at
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file(type_, mid, "memory")).write_text(frontmatter.dumps(post))


def test_decays_observation_after_30_days(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_aaaaaa", type_="observation",
                              confidence=1.0, updated_days_ago=31)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "memory"))
    assert fm["confidence"] == pytest.approx(0.95, abs=0.001)
    assert "last_decay_at" in fm
    assert report.decayed == 1


def test_skip_under_one_period(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_bbbbbb", type_="observation",
                              confidence=1.0, updated_days_ago=15)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_bbbbbb", "memory"))
    assert fm["confidence"] == 1.0
    assert report.decayed == 0


def test_decision_never_decays(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_cccccc", type_="decision",
                              confidence=1.0, updated_days_ago=365)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("decision", "mem_2026-04-27_cccccc", "memory"))
    assert fm["confidence"] == 1.0


def test_floor_at_zero(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_dddddd", type_="observation",
                              confidence=0.04, updated_days_ago=400)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_dddddd", "memory"))
    assert fm["confidence"] == 0.0


def test_dry_run_does_not_modify_files(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_eeeeee", type_="observation",
                              confidence=1.0, updated_days_ago=31)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=True, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_eeeeee", "memory"))
    assert fm["confidence"] == 1.0
    assert "last_decay_at" not in fm
