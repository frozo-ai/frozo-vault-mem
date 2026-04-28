import json
import tempfile
from pathlib import Path

from vault_mem_keeper.audit import Auditor


def test_appends_jsonl_with_v1_and_ts():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "promote",
            "agent": "keeper",
            "session": "01H",
            "id": "mem_2026-04-27_aaaaaa",
            "from": "/v/inbox/decisions/x.md",
            "to": "/v/memory/decisions/x.md",
            "reason": "auto",
        })
        line = json.loads(log.read_text().strip())
        assert line["op"] == "promote"
        assert line["v"] == 1
        assert line["agent"] == "keeper"
        assert "ts" in line
        assert line["ts"].endswith("Z") or "+" in line["ts"]


def test_hashes_search_query_for_search_op():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "search",
            "agent": "keeper",
            "session": "01H",
            "query": "myapp auth",
            "result_count": 4,
            "mode": "hybrid",
        })
        line = json.loads(log.read_text().strip())
        assert "query" not in line
        assert line["query_hash"].startswith("sha256:")
        assert line["mode"] == "hybrid"


def test_hashes_context_query_when_present():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "context",
            "agent": "keeper",
            "session": "01H",
            "project": "myapp",
            "max_tokens": 4000,
            "query": "auth",
            "result_count": 2,
            "total_tokens": 300,
        })
        line = json.loads(log.read_text().strip())
        assert "query" not in line
        assert line["query_hash"].startswith("sha256:")
        assert line["project"] == "myapp"


def test_keeper_run_op_passes_through():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "keeper_run",
            "agent": "keeper",
            "session": "01H",
            "duration_ms": 234,
            "summary": {"triage": {"promoted": 2}},
        })
        line = json.loads(log.read_text().strip())
        assert line["op"] == "keeper_run"
        assert line["duration_ms"] == 234
