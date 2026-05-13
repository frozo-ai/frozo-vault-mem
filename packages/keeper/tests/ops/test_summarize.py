"""Integration tests for ops/summarize.py."""

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient
from vault_mem_keeper.ops.summarize import run_summarize
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.state import read_state


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _hours_ago_iso(h: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=h)).isoformat().replace("+00:00", "Z")


def _seed_fts(vault_root: str, rows: list[tuple]) -> None:
    paths = vault_paths(vault_root)
    Path(paths.system_dir).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(paths.index_file)
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    db.executemany(
        "INSERT INTO memories_fts "
        "(id,type,title,body,tags,project,status,location,path,updated) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()


def _project_rows(project: str, n: int, mem_type: str = "decision") -> list[tuple]:
    return [
        (
            f"mem_2026-04-{(i % 28) + 1:02d}_{i:06x}",
            mem_type,
            f"Title {i} for {project}",
            f"Body {i} for {project}",
            json.dumps([]),
            project,
            "active",
            "memory",
            f"/v/memory/decisions/{i}.md",
            _hours_ago_iso(i),
        )
        for i in range(1, n + 1)
    ]


def _client(sdk, log_path: str, cap: float = 5.0) -> AnthropicClient:
    return AnthropicClient(
        sdk=sdk,
        budget=BudgetTracker(log_path, cap),
        haiku_model="claude-haiku-4-5",
        sonnet_model="claude-sonnet-4-7",
        api_key="test-key",
    )


def test_skips_when_disabled(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, _ = anthropic_mock
    cfg = KeeperConfig()
    cfg.summarize.enabled = False
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=False, run_id="t",
    )
    assert report.skipped is True


def test_skips_when_no_api_key(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    no_key = AnthropicClient(
        sdk=None, budget=BudgetTracker(paths.budget_file, 5.0),
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key=None,
    )
    report = run_summarize(
        paths, KeeperConfig(), schemas={}, audit=Auditor(paths.audit_file),
        llm_client=no_key, dry_run=False, run_id="t",
    )
    assert report.skipped is True


def test_below_threshold_no_summary(tmp_vault, anthropic_mock):
    # 4 memories for project=demo; daily threshold is 5 → no summary
    paths = vault_paths(str(tmp_vault))
    _seed_fts(str(tmp_vault), _project_rows("demo", 4))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    set_response("# Should not be used")

    cfg = KeeperConfig()
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=False, run_id="t",
    )
    assert report.summaries_written == 0


def test_writes_daily_summary_when_threshold_met(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed_fts(str(tmp_vault), _project_rows("demo", 6))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    set_response("# Daily summary\n\n## Decisions\n- Demo decision\n")

    cfg = KeeperConfig()
    # Disable weekly/monthly to keep test deterministic on call count
    cfg.summarize.weekly.enabled = False
    cfg.summarize.monthly.enabled = False
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=False, run_id="t",
    )
    assert report.summaries_written == 1
    assert "daily" in report.per_project["demo"]

    # Summary memory written to memory/summaries/
    summary_dir = Path(paths.memory_dir("summary"))
    files = list(summary_dir.glob("mem_*.md"))
    assert len(files) == 1
    post = frontmatter.load(str(files[0]))
    fm = dict(post.metadata)
    assert fm["type"] == "summary"
    assert fm["period"] == "daily"
    assert fm["project"] == "demo"
    assert isinstance(fm["covers"], list) and len(fm["covers"]) == 6
    assert "auto-generated" in fm["tags"]

    # State watermark
    state = read_state(paths.state_file)
    assert state["summaries"]["demo"]["daily"] is not None

    # Audit
    audit_lines = [
        json.loads(line) for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(
        r.get("op") == "summarize" and r.get("project") == "demo" and r.get("period") == "daily"
        for r in audit_lines
    )


def test_idempotent_when_recently_summarized(tmp_vault, anthropic_mock):
    """Second run within the time window should not regenerate the daily summary."""
    paths = vault_paths(str(tmp_vault))
    _seed_fts(str(tmp_vault), _project_rows("demo", 6))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    set_response("# Summary v1")
    set_response("# Summary v2")  # should not be consumed

    cfg = KeeperConfig()
    cfg.summarize.weekly.enabled = False
    cfg.summarize.monthly.enabled = False
    client = _client(sdk, paths.budget_file)
    first = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t1",
    )
    second = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t2",
    )
    assert first.summaries_written == 1
    assert second.summaries_written == 0


def test_dry_run_does_not_write(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed_fts(str(tmp_vault), _project_rows("demo", 6))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    set_response("# Should not write")

    cfg = KeeperConfig()
    cfg.summarize.weekly.enabled = False
    cfg.summarize.monthly.enabled = False
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=True, run_id="t",
    )
    assert report.summaries_written == 1
    summary_dir = Path(paths.memory_dir("summary"))
    assert not summary_dir.exists() or not list(summary_dir.glob("mem_*.md"))
    state = read_state(paths.state_file)
    assert state["summaries"] == {}


def test_skips_memories_without_project(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    # 6 memories with project=None — should be skipped entirely
    rows = [
        (
            f"mem_2026-04-{i:02d}_{i:06x}",
            "decision",
            f"Title {i}", "Body",
            json.dumps([]),
            None, "active", "memory",
            f"/v/memory/decisions/{i}.md",
            _hours_ago_iso(i),
        )
        for i in range(1, 7)
    ]
    _seed_fts(str(tmp_vault), rows)
    Path(paths.audit_file).touch()
    sdk, _ = anthropic_mock

    cfg = KeeperConfig()
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=False, run_id="t",
    )
    assert report.summaries_written == 0


def test_budget_exceeded_short_circuits(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed_fts(str(tmp_vault), _project_rows("demo", 6))
    Path(paths.audit_file).touch()
    sdk, _ = anthropic_mock
    Path(paths.budget_file).parent.mkdir(parents=True, exist_ok=True)
    ts = _now_iso()
    Path(paths.budget_file).write_text(json.dumps({
        "ts": ts, "v": 1, "model": "claude-sonnet-4-7",
        "input_tokens": 1, "output_tokens": 1, "cost_usd": 999.0,
        "op": "seed", "run_id": "seed",
    }) + "\n")

    cfg = KeeperConfig()
    cfg.summarize.weekly.enabled = False
    cfg.summarize.monthly.enabled = False
    client = _client(sdk, paths.budget_file, cap=0.001)
    report = run_summarize(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )
    assert report.budget_exceeded is True
    assert report.summaries_written == 0
    audit_lines = [
        json.loads(line) for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(r.get("op") == "budget_exceeded" for r in audit_lines)
