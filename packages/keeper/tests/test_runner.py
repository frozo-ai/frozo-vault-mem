import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter

from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.runner import RunOpts, run_pass


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
    raw_lines = Path(paths.audit_file).read_text().splitlines()
    lines = [json.loads(line) for line in raw_lines if line.strip()]
    assert any(line["op"] == "keeper_run" and line["agent"] == "keeper" for line in lines)


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
    _seed_inbox(tmp_vault)
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
    # but triage still ran (before the failing op)
    assert report.ops["triage"].promoted == 1
    # AND the ops AFTER link still ran (the runner does not bail on first error)
    assert "decay" in report.ops
    assert report.ops["decay"].error is None
    assert "archive" in report.ops
    assert report.ops["archive"].error is None


def test_keeper_run_summary_surfaces_op_errors(tmp_vault, monkeypatch):
    """When an op throws, the keeper_run audit summary includes the error string
    so downstream consumers (tail-audit, future dashboards) can detect partial
    failures without cross-referencing stderr logs."""
    _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    from vault_mem_keeper.ops import link as link_mod

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic-failure")

    monkeypatch.setattr(link_mod, "run_link", boom)

    run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    raw_lines = Path(paths.audit_file).read_text().splitlines()
    lines = [json.loads(line) for line in raw_lines if line.strip()]
    keeper_run = next(line for line in lines if line["op"] == "keeper_run")
    assert "synthetic-failure" in keeper_run["summary"]["link"]["error"]
