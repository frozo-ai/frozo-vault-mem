import json
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from vault_mem_keeper.llm.budget import BudgetTracker


def _line(ts: str, cost: float) -> str:
    return json.dumps({
        "ts": ts, "v": 1, "model": "claude-haiku-4-5",
        "input_tokens": 10, "output_tokens": 5,
        "cost_usd": cost, "op": "x", "run_id": "r",
    })


def test_month_to_date_sums_only_current_month():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        now = datetime.now(UTC)
        last_month = (now.replace(day=1) - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        this_month = now.isoformat().replace("+00:00", "Z")
        Path(path).write_text(
            _line(last_month, 5.00) + "\n" +
            _line(this_month, 0.10) + "\n" +
            _line(this_month, 0.20) + "\n"
        )
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        assert bt.month_to_date() == pytest.approx(0.30)


def test_within_cap_when_under_threshold():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        Path(path).write_text(_line(ts, 0.50) + "\n")
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        assert not bt.is_exceeded()


def test_exceeded_when_over_threshold():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        Path(path).write_text(_line(ts, 1.50) + "\n")
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        assert bt.is_exceeded()


def test_record_call_appends_jsonl():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        bt.record_call(
            model="claude-haiku-4-5", input_tokens=100, output_tokens=10,
            cost_usd=0.001, op="contradict_prefilter", run_id="r1",
        )
        lines = [json.loads(line) for line in Path(path).read_text().strip().splitlines()]
        assert len(lines) == 1
        assert lines[0]["model"] == "claude-haiku-4-5"
        assert lines[0]["cost_usd"] == 0.001
        assert lines[0]["v"] == 1


def test_missing_file_treated_as_zero_spend():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        assert bt.month_to_date() == 0.0
        assert not bt.is_exceeded()
