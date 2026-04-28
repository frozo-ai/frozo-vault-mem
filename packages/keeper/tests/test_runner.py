from datetime import datetime, timedelta, UTC
from pathlib import Path
import json

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import load_keeper_config
from vault_mem_keeper.runner import run_pass, RunOpts
from vault_mem_keeper.paths import vault_paths


def _seed_inbox(vault_root: Path) -> str:
    paths = vault_paths(str(vault_root))
    Path(paths.inbox_dir("decision")).mkdir(parents=True, exist_ok=True)
    mid = "mem_2026-04-27_aaaaaa"
    created = (datetime.now(UTC) - timedelta(minutes=2000)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid, "type": "decision", "title": "T",
        "agent": "human", "session": None,
        "created": created, "updated": created,
        "confidence": 0.85,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file("decision", mid, "inbox")).write_text(frontmatter.dumps(post))
    return mid


def test_run_pass_orchestrates_ops_in_order(tmp_vault):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    assert report.run_id is not None
    # Triage promoted the seeded memory
    assert "triage" in report.ops
    assert report.ops["triage"].promoted == 1
    # The inbox file is gone, the memory file exists
    assert not Path(paths.memory_file("decision", mid, "inbox")).exists()
    assert Path(paths.memory_file("decision", mid, "memory")).exists()
    # Audit log has a keeper_run summary line
    lines = [json.loads(l) for l in Path(paths.audit_file).read_text().splitlines() if l.strip()]
    assert any(l["op"] == "keeper_run" and l["agent"] == "keeper" for l in lines)


def test_run_pass_dry_run_makes_no_changes(tmp_vault):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=True))

    assert report.run_id is not None
    assert Path(paths.memory_file("decision", mid, "inbox")).exists()
    # No audit lines at all (dry-run skips audit writes)
    assert Path(paths.audit_file).read_text().strip() == ""


def test_one_op_failure_does_not_block_others(tmp_vault, monkeypatch):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    # Force run_link to throw
    from vault_mem_keeper.ops import link as link_mod

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(link_mod, "run_link", boom)

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    # link errored
    assert report.ops["link"].error is not None
    # but triage still ran
    assert report.ops["triage"].promoted == 1
