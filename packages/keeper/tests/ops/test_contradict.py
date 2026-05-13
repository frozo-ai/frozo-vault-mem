"""Integration tests for ops/contradict.py against tmpVault with mocked Anthropic."""

import json
import sqlite3
from pathlib import Path

import lancedb
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient
from vault_mem_keeper.ops.contradict import run_contradict
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.proposals import open_proposals
from vault_mem_keeper.state import read_state

EMBED_DIM = 384


def _seed(vault_root: str, updated_b: str = "2026-04-29T10:00:00.000Z") -> None:
    """Seed FTS5 + Lance with 2 decisions about myapp auth, similar vectors."""
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
    rows = [
        ("mem_2026-04-15_aaaaaa", "decision", "Use Supabase for myapp auth",
         "We chose Supabase for myapp's auth subsystem.",
         json.dumps([]), "myapp", "active", "memory",
         "/v/memory/decisions/mem_2026-04-15_aaaaaa.md",
         "2026-04-15T14:32:00.000Z"),
        ("mem_2026-04-29_bbbbbb", "decision", "Migrate myapp to Auth0",
         "Switching myapp's auth from Supabase to Auth0.",
         json.dumps([]), "myapp", "active", "memory",
         "/v/memory/decisions/mem_2026-04-29_bbbbbb.md",
         updated_b),
        ("mem_2026-04-30_cccccc", "decision", "Use Tailwind for myapp styling",
         "Tailwind for styling.",
         json.dumps([]), "myapp", "active", "memory",
         "/v/memory/decisions/mem_2026-04-30_cccccc.md",
         "2026-04-30T10:00:00.000Z"),
    ]
    db.executemany(
        "INSERT INTO memories_fts "
        "(id,type,title,body,tags,project,status,location,path,updated) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()

    lancedb_db = lancedb.connect(paths.lance_dir)
    lance_rows = []
    for r in rows:
        mid = r[0]
        v = [0.0] * EMBED_DIM
        if mid.startswith("mem_2026-04-15") or mid.startswith("mem_2026-04-29"):
            v[0] = 1.0 if "aaaaaa" in mid else 0.97
            v[1] = 0.0 if "aaaaaa" in mid else 0.03
        else:
            v[5] = 1.0
        lance_rows.append({
            "id": mid, "vector": v, "type": "decision",
            "title": r[2], "project": "myapp", "tags": [],
            "status": "active", "location": "memory",
            "path": r[8], "updated": r[9],
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        })
    lancedb_db.create_table("memories", lance_rows)


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
    cfg.contradict.enabled = False
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=_client(sdk, paths.budget_file), dry_run=False, run_id="t",
    )
    assert report.skipped is True
    assert report.skip_reason == "disabled"


def test_skips_when_no_api_key(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    cfg = KeeperConfig()
    no_key = AnthropicClient(
        sdk=None, budget=BudgetTracker(paths.budget_file, 5.0),
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key=None,
    )
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=no_key, dry_run=False, run_id="t",
    )
    assert report.skipped is True
    assert "ANTHROPIC_API_KEY" in (report.skip_reason or "")


def test_writes_proposal_on_real_conflict(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock

    # Each canonical memory triggers up to 2 LLM rounds (prefilter + judge)
    # per neighbor. With 3 canonicals and top_k=5 we'll see at most 6 prefilters
    # if every memory has 2 neighbors. Queue enough yes/judge pairs.
    judge_json = json.dumps({
        "has_contradiction": True,
        "severity": "high",
        "reasoning": "Direct reversal: Supabase chosen, then migration to Auth0.",
        "suggested_action": "supersede_M_with_N",
    })
    for _ in range(6):
        set_response("yes")          # prefilter
        set_response(judge_json)     # judge

    client = _client(sdk, paths.budget_file)
    cfg = KeeperConfig()
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )

    assert report.skipped is False
    assert report.proposals_written >= 1
    assert report.pairs_judged >= 1

    handle = open_proposals(paths.proposals_file)
    pending = list(handle.iter_pending())
    assert len(pending) >= 1
    pair = sorted([pending[0].source_id, pending[0].target_id])
    assert pair == sorted(["mem_2026-04-15_aaaaaa", "mem_2026-04-29_bbbbbb"])
    assert pending[0].severity == "high"

    # State watermark advanced
    state = read_state(paths.state_file)
    assert state["last_contradict_at"] is not None

    # Audit log contains a contradict_scan entry
    audit_lines = [
        json.loads(line)
        for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(r.get("op") == "contradict_scan" for r in audit_lines)


def test_skips_when_haiku_says_no(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    for _ in range(10):
        set_response("no")

    client = _client(sdk, paths.budget_file)
    cfg = KeeperConfig()
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )
    assert report.proposals_written == 0
    assert report.pairs_judged == 0
    assert open_proposals(paths.proposals_file).count_pending() == 0


def test_filters_by_min_severity(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    low_judge = json.dumps({
        "has_contradiction": True,
        "severity": "low",
        "reasoning": "Minor nuance only.",
        "suggested_action": "both_active_different_facets",
    })
    for _ in range(6):
        set_response("yes")
        set_response(low_judge)

    cfg = KeeperConfig()
    cfg.contradict.min_severity = "medium"
    client = _client(sdk, paths.budget_file)
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )
    assert report.pairs_judged >= 1
    assert report.proposals_written == 0


def test_idempotent_no_new_proposals_on_second_run(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    judge_json = json.dumps({
        "has_contradiction": True, "severity": "high",
        "reasoning": "Direct reversal.", "suggested_action": "supersede_M_with_N",
    })
    for _ in range(6):
        set_response("yes")
        set_response(judge_json)

    cfg = KeeperConfig()
    client = _client(sdk, paths.budget_file)
    first = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t1",
    )
    second = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t2",
    )
    assert first.proposals_written >= 1
    # Second run: watermark advanced + dedup means no new proposals
    assert second.proposals_written == 0


def test_budget_exceeded_short_circuits(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, _ = anthropic_mock
    # Cap at near-zero so the FIRST call's BudgetTracker.is_exceeded() returns True.
    # Pre-fill budget.jsonl with a cost that exceeds cap.
    Path(paths.budget_file).parent.mkdir(parents=True, exist_ok=True)
    from datetime import UTC, datetime
    ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    Path(paths.budget_file).write_text(json.dumps({
        "ts": ts, "v": 1, "model": "claude-haiku-4-5",
        "input_tokens": 1, "output_tokens": 1, "cost_usd": 999.0,
        "op": "seed", "run_id": "seed",
    }) + "\n")

    cfg = KeeperConfig()
    client = _client(sdk, paths.budget_file, cap=0.001)
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )
    assert report.budget_exceeded is True
    assert report.proposals_written == 0

    audit_lines = [
        json.loads(line)
        for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(r.get("op") == "budget_exceeded" for r in audit_lines)


def test_dry_run_writes_no_files(tmp_vault, anthropic_mock):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    judge_json = json.dumps({
        "has_contradiction": True, "severity": "high",
        "reasoning": "x", "suggested_action": "supersede_M_with_N",
    })
    for _ in range(6):
        set_response("yes")
        set_response(judge_json)

    cfg = KeeperConfig()
    client = _client(sdk, paths.budget_file)
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=True, run_id="t",
    )
    # Counter increments, but no proposal file, no state mutation, no audit
    assert report.proposals_written >= 1
    assert not Path(paths.proposals_file).is_file() or \
        Path(paths.proposals_file).read_text().strip() == ""
    assert read_state(paths.state_file)["last_contradict_at"] is None


@pytest.mark.parametrize("malformed", ["not json at all", "{has_contradiction: true,"])
def test_malformed_judge_response_skips_pair(tmp_vault, anthropic_mock, malformed):
    paths = vault_paths(str(tmp_vault))
    _seed(str(tmp_vault))
    Path(paths.audit_file).touch()
    sdk, set_response = anthropic_mock
    for _ in range(6):
        set_response("yes")
        set_response(malformed)

    cfg = KeeperConfig()
    client = _client(sdk, paths.budget_file)
    report = run_contradict(
        paths, cfg, schemas={}, audit=Auditor(paths.audit_file),
        llm_client=client, dry_run=False, run_id="t",
    )
    assert report.proposals_written == 0
    assert report.errors >= 1
