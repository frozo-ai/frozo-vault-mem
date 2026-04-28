from datetime import datetime, timedelta, UTC
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas
from vault_mem_keeper.ops.triage import run_triage
from vault_mem_keeper.paths import vault_paths

REPO_ROOT = Path(__file__).resolve().parents[4]
VAULT_TEMPLATE = REPO_ROOT / "vault-template"


def _write_inbox_memory(
    vault_root: Path,
    mid: str,
    *,
    confidence: float,
    age_minutes: int,
    human_reviewed: bool = False,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.inbox_dir("decision")).mkdir(parents=True, exist_ok=True)
    created = (datetime.now(UTC) - timedelta(minutes=age_minutes)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid,
        "type": "decision",
        "title": "Test " + mid,
        "agent": "claude-code",
        "session": "01H",
        "created": created,
        "updated": created,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": human_reviewed, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body content", **fm)
    Path(paths.memory_file("decision", mid, "inbox")).write_text(frontmatter.dumps(post))


def test_promotes_old_high_confidence_memories(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_aaaaaa", confidence=0.85, age_minutes=2000)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_bbbbbb", confidence=0.85, age_minutes=10)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_cccccc", confidence=0.4, age_minutes=2000)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_dddddd", confidence=0.85, age_minutes=10, human_reviewed=True)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_triage(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    # aaaaaa: old + high confidence → promote
    assert not Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "inbox")).exists()
    assert Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "memory")).exists()
    # bbbbbb: too young → stays
    assert Path(paths.memory_file("decision", "mem_2026-04-27_bbbbbb", "inbox")).exists()
    # cccccc: low confidence → stays
    assert Path(paths.memory_file("decision", "mem_2026-04-27_cccccc", "inbox")).exists()
    # dddddd: human_reviewed → promoted regardless of age
    assert Path(paths.memory_file("decision", "mem_2026-04-27_dddddd", "memory")).exists()

    assert report.promoted == 2
    assert report.skipped == 2


def test_dry_run_does_not_move_files(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_aaaaaa", confidence=0.85, age_minutes=2000)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_triage(paths, cfg, schemas, audit, dry_run=True, run_id="test")

    assert Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "inbox")).exists()
    assert not Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "memory")).exists()
    assert report.promoted == 1   # would-promote count
    assert report.skipped == 0
