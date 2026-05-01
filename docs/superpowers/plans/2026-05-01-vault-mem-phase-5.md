# Vault-Mem Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 5 — Sonnet-powered contradiction detection + per-project summarization in the Python keeper, behind a CLI proposal review queue. First Anthropic API integration; soft monthly cost cap with audit logging.

**Architecture:** Two new keeper ops (contradict, summarize) consuming the same `llm/` client, with proposals durable in `_system/proposals.jsonl`. New `vault-mem-keeper review` interactive walker gates all destructive applies behind human approval. TS server unchanged except for an `AuditEntry` union widening.

**Tech Stack:** Python 3.12 · `uv` · `anthropic` SDK (≥0.40.0) · `pydantic` v2 · `pytest` · existing keeper modules (frontmatter, audit, fts, lance, paths, atomic_write, config, state).

**Spec:** [`docs/superpowers/specs/2026-05-01-vault-mem-phase-5-design.md`](../specs/2026-05-01-vault-mem-phase-5-design.md)

---

## File Structure

### Created files

**`packages/keeper/src/vault_mem_keeper/`:**
- `state.py` (+ `tests/test_state.py`)
- `proposals.py` (+ `tests/test_proposals.py`)
- `llm/__init__.py`
- `llm/client.py` (+ `tests/test_llm_client.py`)
- `llm/prompts.py` (+ `tests/test_llm_prompts.py`)
- `llm/budget.py` (+ `tests/test_llm_budget.py`)
- `ops/contradict.py` (+ `tests/ops/test_contradict.py`)
- `ops/summarize.py` (+ `tests/ops/test_summarize.py`)
- `cli/__init__.py`
- `cli/review.py` (+ `tests/cli/__init__.py`, `tests/cli/test_review.py`)

**Tests fixture extension:**
- `tests/conftest.py` — extend with `anthropic_mock` fixture (modify, don't replace)

### Modified files

- `packages/keeper/pyproject.toml` — add `anthropic` dep
- `packages/keeper/src/vault_mem_keeper/config.py` — add `ContradictConfig`, `SummarizeConfig`, `BudgetConfig` pydantic models
- `packages/keeper/src/vault_mem_keeper/runner.py` — register contradict + summarize; thread llm_client; surface metrics in keeper_run summary
- `packages/keeper/src/vault_mem_keeper/__main__.py` — add `review` subcommand
- `packages/keeper/src/vault_mem_keeper/paths.py` — add `proposals_file`, `budget_file`, `state_file` properties
- `packages/keeper/tests/test_paths.py` — assert new path properties
- `packages/mcp/src/audit/index.ts` — widen `AuditEntry` union
- `packages/mcp/src/audit/audit.test.ts` — assert new keeper-shape entries
- `vault-template/.gitignore` — add proposals.jsonl, budget.jsonl, state.json
- `vault-template/_system/config.yaml.example` — add `keeper.contradict/summarize/budget` defaults
- `docs/CONFIG.md` — document new config
- `CHANGELOG.md` — Unreleased entry
- `README.md` — note contradiction + summarization in tools/CLI sections

---

## Tasks

### Task 1: Bootstrap deps + paths + gitignore

**Files:**
- Modify: `packages/keeper/pyproject.toml`
- Modify: `packages/keeper/src/vault_mem_keeper/paths.py`
- Modify: `packages/keeper/tests/test_paths.py`
- Modify: `vault-template/.gitignore`

- [ ] **Step 1: Add `anthropic` dep to `packages/keeper/pyproject.toml`**

In the `[project]` section's `dependencies` array, add:

```toml
"anthropic==0.40.0",
```

Place alphabetically (after `python-frontmatter` should be fine — actually before, since `anthropic` comes earlier in alpha order):

The full dependencies block becomes:
```toml
dependencies = [
    "anthropic==0.40.0",
    "python-frontmatter==1.1.0",
    "pyyaml==6.0.2",
    "jsonschema==4.23.0",
    "pydantic==2.9.2",
    "lancedb==0.13.0",
    "structlog==24.4.0",
    "python-ulid==3.0.0",
]
```

- [ ] **Step 2: Run `uv sync --all-groups`**

```bash
cd packages/keeper && uv sync --all-groups
```

Expected: lockfile updated; `anthropic` and its transitive deps (httpx, pydantic-settings, etc.) installed.

- [ ] **Step 3: Add new path properties to `paths.py`**

After `links_file`, add:

```python
    @property
    def proposals_file(self) -> str: return str(Path(self.root, "_system/proposals.jsonl"))
    @property
    def budget_file(self) -> str: return str(Path(self.root, "_system/budget.jsonl"))
    @property
    def state_file(self) -> str: return str(Path(self.root, "_system/state.json"))
```

- [ ] **Step 4: Add assertions to `tests/test_paths.py`**

Inside `test_vault_paths_constructs_canonical_paths`, append:

```python
    assert p.proposals_file == "/vault/_system/proposals.jsonl"
    assert p.budget_file == "/vault/_system/budget.jsonl"
    assert p.state_file == "/vault/_system/state.json"
```

- [ ] **Step 5: Append to `vault-template/.gitignore`**

```
# Phase 5 daemon-managed; rebuilt or accumulated per run
_system/proposals.jsonl
_system/budget.jsonl
_system/state.json
```

- [ ] **Step 6: Run keeper tests + TS tests**

```bash
cd packages/keeper && uv run pytest tests/test_paths.py
pnpm --filter @vault-mem/mcp test 2>&1 | grep "Tests" | head -1
```

Expected: paths tests pass with the 3 new assertions; TS unchanged at 106 passing.

- [ ] **Step 7: Commit**

```bash
git add packages/keeper/pyproject.toml packages/keeper/uv.lock packages/keeper/src/vault_mem_keeper/paths.py packages/keeper/tests/test_paths.py vault-template/.gitignore
git commit -m "chore(keeper): add anthropic SDK dep + new vault file paths for Phase 5"
```

---

### Task 2: `state.py` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/state.py`
- Create: `packages/keeper/tests/test_state.py`

- [ ] **Step 1: Write failing test `tests/test_state.py`**

```python
import json
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.state import read_state, write_state


def test_read_state_returns_defaults_when_file_missing():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        s = read_state(path)
        assert s == {"last_contradict_at": None, "summaries": {}}


def test_round_trip():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        write_state(path, {
            "last_contradict_at": "2026-05-01T00:00:00Z",
            "summaries": {"myapp": {"daily": "2026-05-01T00:00:00Z"}},
        })
        s = read_state(path)
        assert s["last_contradict_at"] == "2026-05-01T00:00:00Z"
        assert s["summaries"]["myapp"]["daily"] == "2026-05-01T00:00:00Z"


def test_partial_state_merges_with_defaults():
    """If the on-disk file has only some keys, missing ones get defaults."""
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        Path(path).write_text(json.dumps({"last_contradict_at": "2026-05-01T00:00:00Z"}))
        s = read_state(path)
        assert s["last_contradict_at"] == "2026-05-01T00:00:00Z"
        assert s["summaries"] == {}


def test_corrupt_file_returns_defaults_and_warns(caplog):
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "state.json"))
        Path(path).write_text("not valid json {{{")
        s = read_state(path)
        assert s == {"last_contradict_at": None, "summaries": {}}
```

- [ ] **Step 2: Run (expect FAIL — module not found).**

```bash
cd packages/keeper && uv run pytest tests/test_state.py
```

- [ ] **Step 3: Write `src/vault_mem_keeper/state.py`**

```python
"""Per-vault keeper state. Tracks last-run timestamps for incremental ops.

JSON file at _system/state.json. Defensively returns defaults when missing
or corrupt. Writes are atomic (temp+rename) via atomic_write."""

import json
from pathlib import Path
from typing import Any

from .atomic_write import atomic_write
from .logging import get_logger

log = get_logger(__name__)

_DEFAULTS: dict[str, Any] = {
    "last_contradict_at": None,
    "summaries": {},   # {project: {period: iso_ts}}
}


def read_state(path: str) -> dict[str, Any]:
    if not Path(path).is_file():
        return dict(_DEFAULTS)
    try:
        raw = Path(path).read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (json.JSONDecodeError, OSError) as e:
        log.warn("state: corrupt file, returning defaults", path=path, err=str(e))
        return dict(_DEFAULTS)
    merged = dict(_DEFAULTS)
    merged.update(parsed)
    if not isinstance(merged.get("summaries"), dict):
        merged["summaries"] = {}
    return merged


def write_state(path: str, state: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(state, indent=2, ensure_ascii=False) + "\n")
```

- [ ] **Step 4: Run (expect 4 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/state.py packages/keeper/tests/test_state.py
git commit -m "feat(keeper): add state module (per-vault last-run timestamps)"
```

---

### Task 3: `proposals.py` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/proposals.py`
- Create: `packages/keeper/tests/test_proposals.py`

- [ ] **Step 1: Write failing tests**

```python
import json
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.proposals import (
    Proposal,
    ProposalsHandle,
    open_proposals,
    pair_dedup_key,
)


def _sample_kwargs(**over):
    base = dict(
        kind="contradict",
        source_id="mem_2026-04-15_a8f3c0",
        target_id="mem_2026-04-29_b1e9aa",
        severity="high",
        reasoning="...",
        suggested_action="supersede_M_with_N",
        model="claude-sonnet-4-7",
        cost_usd=0.0034,
        run_id="01KQ_TEST",
        source_updated="2026-04-15T14:32:00.000Z",
        target_updated="2026-04-29T19:48:12.000Z",
    )
    base.update(over)
    return base


def test_pair_dedup_key_normalizes_order():
    a, b = "mem_a", "mem_b"
    k1 = pair_dedup_key(a, b, "2026-04-15T00:00:00Z", "2026-04-29T00:00:00Z")
    k2 = pair_dedup_key(b, a, "2026-04-29T00:00:00Z", "2026-04-15T00:00:00Z")
    assert k1 == k2
    assert k1 == ("mem_a", "mem_b", "2026-04-29T00:00:00Z")


def test_open_creates_file_and_appends():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "proposals.jsonl"))
        ph = open_proposals(path)
        ph.append(Proposal(**_sample_kwargs()))
        ph.close()
        lines = Path(path).read_text().strip().splitlines()
        assert len(lines) == 1
        rec = json.loads(lines[0])
        assert rec["status"] == "pending"
        assert rec["kind"] == "contradict"
        assert "id" in rec
        assert rec["id"].startswith("P-")


def test_already_judged_with_same_or_newer_update_dedupes():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "proposals.jsonl"))
        ph = open_proposals(path)
        ph.append(Proposal(**_sample_kwargs()))
        # Same pair, same update timestamps → already judged
        assert ph.already_judged(
            "mem_2026-04-15_a8f3c0", "mem_2026-04-29_b1e9aa",
            "2026-04-15T14:32:00.000Z", "2026-04-29T19:48:12.000Z",
        )
        # Reversed order → still already judged
        assert ph.already_judged(
            "mem_2026-04-29_b1e9aa", "mem_2026-04-15_a8f3c0",
            "2026-04-29T19:48:12.000Z", "2026-04-15T14:32:00.000Z",
        )
        # Newer source.updated → re-evaluation needed
        assert not ph.already_judged(
            "mem_2026-04-15_a8f3c0", "mem_2026-04-29_b1e9aa",
            "2026-04-16T00:00:00.000Z", "2026-04-29T19:48:12.000Z",
        )
        ph.close()


def test_set_status_mutates_in_place():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "proposals.jsonl"))
        ph = open_proposals(path)
        p = ph.append(Proposal(**_sample_kwargs()))
        ph.set_status(p.id, "applied")
        ph.close()
        rec = json.loads(Path(path).read_text().strip().splitlines()[0])
        assert rec["status"] == "applied"


def test_iter_pending_skips_non_pending():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "proposals.jsonl"))
        ph = open_proposals(path)
        p1 = ph.append(Proposal(**_sample_kwargs(reasoning="r1")))
        p2 = ph.append(Proposal(**_sample_kwargs(reasoning="r2", source_id="mem_x", target_id="mem_y")))
        ph.set_status(p1.id, "rejected")
        # Re-open to test fresh read
        ph.close()
        ph2 = open_proposals(path)
        pending = list(ph2.iter_pending())
        assert len(pending) == 1
        assert pending[0].id == p2.id
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/proposals.py`**

```python
"""Append-only JSONL store for keeper-emitted proposals.

Idempotency uses an order-normalized pair key so that re-judging the
same memory pair (regardless of which side is "source") is detected.
A pair is re-evaluated if EITHER memory's updated timestamp has
advanced since the proposal was stored."""

import json
import secrets
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator

from .atomic_write import atomic_write


def pair_dedup_key(
    source_id: str, target_id: str,
    source_updated: str, target_updated: str,
) -> tuple[str, str, str]:
    """Normalize pair so (A,B) and (B,A) hash identically."""
    a, b = sorted([source_id, target_id])
    newer = max(source_updated, target_updated)
    return (a, b, newer)


@dataclass
class Proposal:
    kind: str                       # "contradict" (more in future)
    source_id: str
    target_id: str
    severity: str                   # "low" | "medium" | "high"
    reasoning: str
    suggested_action: str
    model: str
    cost_usd: float
    run_id: str
    source_updated: str
    target_updated: str
    # filled by ProposalsHandle.append:
    v: int = 1
    id: str = ""
    status: str = "pending"
    created_at: str = ""


def _new_proposal_id() -> str:
    today = datetime.now(UTC).date().isoformat()
    suffix = secrets.token_hex(3)
    return f"P-{today}_{suffix}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class ProposalsHandle:
    def __init__(self, path: str) -> None:
        self._path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if not Path(path).is_file():
            Path(path).write_text("")
        self._records: list[dict] = []
        self._load()

    def _load(self) -> None:
        self._records = []
        for line in Path(self._path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                self._records.append(json.loads(line))

    def append(self, p: Proposal) -> Proposal:
        if not p.id:
            p.id = _new_proposal_id()
        if not p.created_at:
            p.created_at = _now_iso()
        record = asdict(p)
        # Append to disk
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._records.append(record)
        return p

    def already_judged(
        self, source_id: str, target_id: str,
        source_updated: str, target_updated: str,
    ) -> bool:
        key = pair_dedup_key(source_id, target_id, source_updated, target_updated)
        for r in self._records:
            r_key = pair_dedup_key(
                r["source_id"], r["target_id"],
                r["source_updated"], r["target_updated"],
            )
            # Same pair AND r's "newer" timestamp >= our "newer"
            # means we've already judged with both sides at least as fresh.
            if r_key[:2] == key[:2] and r_key[2] >= key[2]:
                return True
        return False

    def set_status(self, proposal_id: str, status: str) -> None:
        for r in self._records:
            if r["id"] == proposal_id:
                r["status"] = status
                break
        # Rewrite full file atomically
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in self._records)
        atomic_write(self._path, body + ("\n" if body else ""))

    def iter_pending(self) -> Iterator[Proposal]:
        for r in self._records:
            if r.get("status") == "pending":
                yield Proposal(**{k: v for k, v in r.items() if k in Proposal.__dataclass_fields__})

    def get(self, proposal_id: str) -> Proposal | None:
        for r in self._records:
            if r["id"] == proposal_id:
                return Proposal(**{k: v for k, v in r.items() if k in Proposal.__dataclass_fields__})
        return None

    def count_pending(self) -> int:
        return sum(1 for r in self._records if r.get("status") == "pending")

    def close(self) -> None:
        # No persistent file handle; close is a no-op for symmetry.
        pass


def open_proposals(path: str) -> ProposalsHandle:
    return ProposalsHandle(path)
```

- [ ] **Step 4: Run (expect 5 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/proposals.py packages/keeper/tests/test_proposals.py
git commit -m "feat(keeper): add proposals module (JSONL queue, order-normalized dedup)"
```

---

### Task 4: `llm/budget.py` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/llm/__init__.py` (empty)
- Create: `packages/keeper/src/vault_mem_keeper/llm/budget.py`
- Create: `packages/keeper/tests/test_llm_budget.py`

- [ ] **Step 1: Write failing tests**

```python
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
        Path(path).write_text(_line(datetime.now(UTC).isoformat().replace("+00:00", "Z"), 0.50) + "\n")
        bt = BudgetTracker(path, monthly_cap_usd=1.00)
        assert not bt.is_exceeded()


def test_exceeded_when_over_threshold():
    with tempfile.TemporaryDirectory() as d:
        path = str(Path(d, "budget.jsonl"))
        Path(path).write_text(_line(datetime.now(UTC).isoformat().replace("+00:00", "Z"), 1.50) + "\n")
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
        lines = [json.loads(l) for l in Path(path).read_text().strip().splitlines()]
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
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/llm/__init__.py`** (empty file).

- [ ] **Step 4: Write `src/vault_mem_keeper/llm/budget.py`**

```python
"""Soft monthly USD cap for Anthropic API spend.

Reads/appends `_system/budget.jsonl`. month_to_date() sums cost_usd
for the current calendar month; is_exceeded() returns True when over
the configured cap. record_call() appends a per-call line."""

import json
from datetime import UTC, datetime
from pathlib import Path


class BudgetTracker:
    def __init__(self, log_path: str, monthly_cap_usd: float) -> None:
        self._path = log_path
        self._cap = monthly_cap_usd

    def month_to_date(self) -> float:
        if not Path(self._path).is_file():
            return 0.0
        now = datetime.now(UTC)
        prefix = f"{now.year:04d}-{now.month:02d}-"
        total = 0.0
        for line in Path(self._path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = rec.get("ts", "")
            if isinstance(ts, str) and ts.startswith(prefix):
                total += float(rec.get("cost_usd") or 0.0)
        return total

    def is_exceeded(self) -> bool:
        return self.month_to_date() >= self._cap

    def remaining(self) -> float:
        return max(0.0, self._cap - self.month_to_date())

    def record_call(
        self, *, model: str, input_tokens: int, output_tokens: int,
        cost_usd: float, op: str, run_id: str,
    ) -> None:
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "v": 1,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_usd,
            "op": op,
            "run_id": run_id,
        }
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
```

- [ ] **Step 5: Run (expect 5 PASS).**

- [ ] **Step 6: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/llm packages/keeper/tests/test_llm_budget.py
git commit -m "feat(keeper): add llm/budget module (per-call cost tracking + soft cap)"
```

---

### Task 5: `llm/client.py` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/llm/client.py`
- Create: `packages/keeper/tests/test_llm_client.py`

The client wraps the Anthropic SDK with retry, structured response parsing, and cost tracking via the `BudgetTracker` from Task 4. Tests use a mocked Anthropic client (no network).

- [ ] **Step 1: Write failing tests**

```python
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient, BudgetExceeded, LlmResponse


PRICE_TABLE_HAIKU_INPUT_PER_MTOK = 0.80   # USD per million input tokens
PRICE_TABLE_HAIKU_OUTPUT_PER_MTOK = 4.00
PRICE_TABLE_SONNET_INPUT_PER_MTOK = 3.00
PRICE_TABLE_SONNET_OUTPUT_PER_MTOK = 15.00


def _fake_response(text: str, in_tokens: int = 100, out_tokens: int = 20):
    msg = MagicMock()
    msg.content = [MagicMock(text=text, type="text")]
    msg.usage = MagicMock(input_tokens=in_tokens, output_tokens=out_tokens)
    msg.stop_reason = "end_turn"
    return msg


def test_haiku_call_records_cost_and_returns_text():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(budget_path, monthly_cap_usd=10.0)
        sdk = MagicMock()
        sdk.messages.create.return_value = _fake_response("yes", in_tokens=200, out_tokens=2)
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        resp = client.haiku("Are these the same?", op="contradict_prefilter", run_id="r1")
        assert resp.text == "yes"
        assert resp.cost_usd > 0
        # SDK called with haiku model name
        sdk.messages.create.assert_called_once()
        kwargs = sdk.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-haiku-4-5"


def test_sonnet_call_uses_sonnet_model():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        bt = BudgetTracker(budget_path, monthly_cap_usd=10.0)
        sdk = MagicMock()
        sdk.messages.create.return_value = _fake_response("a thoughtful answer")
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        resp = client.sonnet("Judge this contradiction", op="contradict_judge", run_id="r1")
        kwargs = sdk.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-7"


def test_budget_exceeded_returns_sentinel_without_calling_sdk():
    with tempfile.TemporaryDirectory() as d:
        budget_path = str(Path(d, "budget.jsonl"))
        # Pre-populate over-cap spending
        from datetime import UTC, datetime
        ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        Path(budget_path).write_text(
            f'{{"ts":"{ts}","v":1,"model":"x","input_tokens":1,"output_tokens":1,"cost_usd":99.0,"op":"x","run_id":"x"}}\n'
        )
        bt = BudgetTracker(budget_path, monthly_cap_usd=1.0)
        sdk = MagicMock()
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
        )
        with pytest.raises(BudgetExceeded):
            client.haiku("hi", op="x", run_id="r1")
        sdk.messages.create.assert_not_called()


def test_retry_on_429_then_success():
    """SDK errors with status 429 should be retried up to 3 times."""
    from anthropic import APIStatusError

    with tempfile.TemporaryDirectory() as d:
        bt = BudgetTracker(str(Path(d, "budget.jsonl")), monthly_cap_usd=10.0)
        sdk = MagicMock()
        # First call: 429 error. Second call: success.
        err = APIStatusError(message="rate limited", response=MagicMock(status_code=429), body={})
        sdk.messages.create.side_effect = [err, _fake_response("ok")]
        client = AnthropicClient(
            sdk=sdk, budget=bt, haiku_model="claude-haiku-4-5",
            sonnet_model="claude-sonnet-4-7", api_key="test",
            retry_max=3, retry_base_seconds=0.001,
        )
        resp = client.haiku("hi", op="x", run_id="r1")
        assert resp.text == "ok"
        assert sdk.messages.create.call_count == 2


def test_has_key_false_without_env():
    with tempfile.TemporaryDirectory() as d:
        bt = BudgetTracker(str(Path(d, "budget.jsonl")), monthly_cap_usd=10.0)
        client = AnthropicClient(
            sdk=None, budget=bt, haiku_model="x", sonnet_model="y", api_key=None,
        )
        assert not client.has_key()
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/llm/client.py`**

```python
"""Thin Anthropic SDK wrapper with retry, response parsing, cost tracking.

Two methods: haiku() and sonnet(). Both:
1. Check budget; raise BudgetExceeded if over cap.
2. Call SDK with retry on 429/500 (up to retry_max times, exponential
   backoff from retry_base_seconds).
3. Parse usage tokens from response.
4. Compute cost from hardcoded price table.
5. Append per-call line to budget.jsonl.
6. Return LlmResponse(text, cost_usd, ...)."""

import os
import time
from dataclasses import dataclass
from typing import Any

from anthropic import APIStatusError, APITimeoutError

from .budget import BudgetTracker

# USD per million tokens
_PRICES = {
    "claude-haiku-4-5":   {"in": 0.80,  "out": 4.00},
    "claude-sonnet-4-7":  {"in": 3.00,  "out": 15.00},
}


class BudgetExceeded(RuntimeError):
    """Raised when the monthly budget cap is reached."""


@dataclass
class LlmResponse:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    stop_reason: str | None = None


def _cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = _PRICES.get(model)
    if not p:
        return 0.0
    return (input_tokens * p["in"] + output_tokens * p["out"]) / 1_000_000


class AnthropicClient:
    def __init__(
        self,
        *,
        sdk: Any,
        budget: BudgetTracker,
        haiku_model: str,
        sonnet_model: str,
        api_key: str | None,
        retry_max: int = 3,
        retry_base_seconds: float = 1.0,
    ) -> None:
        self._sdk = sdk
        self._budget = budget
        self._haiku_model = haiku_model
        self._sonnet_model = sonnet_model
        self._api_key = api_key
        self._retry_max = retry_max
        self._retry_base = retry_base_seconds

    def has_key(self) -> bool:
        return bool(self._api_key)

    def haiku(self, prompt: str, *, op: str, run_id: str, max_tokens: int = 256) -> LlmResponse:
        return self._call(self._haiku_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def sonnet(self, prompt: str, *, op: str, run_id: str, max_tokens: int = 1500) -> LlmResponse:
        return self._call(self._sonnet_model, prompt, op=op, run_id=run_id, max_tokens=max_tokens)

    def _call(self, model: str, prompt: str, *, op: str, run_id: str, max_tokens: int) -> LlmResponse:
        if self._budget.is_exceeded():
            raise BudgetExceeded(
                f"Monthly cap reached (${self._budget.month_to_date():.4f} ≥ cap)"
            )
        attempt = 0
        last_err: Exception | None = None
        while attempt <= self._retry_max:
            try:
                msg = self._sdk.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    messages=[{"role": "user", "content": prompt}],
                )
                in_tokens = int(getattr(msg.usage, "input_tokens", 0))
                out_tokens = int(getattr(msg.usage, "output_tokens", 0))
                text = ""
                for block in (msg.content or []):
                    if getattr(block, "type", None) == "text":
                        text += block.text
                cost_usd = _cost(model, in_tokens, out_tokens)
                self._budget.record_call(
                    model=model, input_tokens=in_tokens,
                    output_tokens=out_tokens, cost_usd=cost_usd,
                    op=op, run_id=run_id,
                )
                return LlmResponse(
                    text=text, model=model, input_tokens=in_tokens,
                    output_tokens=out_tokens, cost_usd=cost_usd,
                    stop_reason=getattr(msg, "stop_reason", None),
                )
            except (APIStatusError, APITimeoutError) as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status not in (429, 500, 502, 503, 504) or attempt == self._retry_max:
                    raise
                wait = self._retry_base * (2 ** attempt)
                time.sleep(wait)
                last_err = e
                attempt += 1
        raise last_err if last_err else RuntimeError("retry loop fell through")


def make_client(budget: BudgetTracker, haiku_model: str, sonnet_model: str) -> AnthropicClient:
    """Factory using ANTHROPIC_API_KEY env var. Returns client with sdk=None
    when the key is missing — call has_key() first."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    sdk = None
    if api_key:
        from anthropic import Anthropic
        sdk = Anthropic(api_key=api_key)
    return AnthropicClient(
        sdk=sdk, budget=budget,
        haiku_model=haiku_model, sonnet_model=sonnet_model,
        api_key=api_key,
    )
```

- [ ] **Step 4: Run (expect 5 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/llm/client.py packages/keeper/tests/test_llm_client.py
git commit -m "feat(keeper): add llm/client (Anthropic SDK wrapper, retry, cost track)"
```

---

### Task 6: `llm/prompts.py` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/llm/prompts.py`
- Create: `packages/keeper/tests/test_llm_prompts.py`

- [ ] **Step 1: Write failing tests**

```python
import pytest

from vault_mem_keeper.llm.prompts import (
    contradict_prefilter,
    contradict_judge,
    summary_for_period,
    parse_judge_response,
)


def test_prefilter_includes_both_titles_and_bodies():
    s = contradict_prefilter(
        a_title="Use Supabase", a_body="Supabase has DPDP-compatible hosting.",
        b_title="Use Auth0", b_body="Auth0 is convenient.",
    )
    assert "Use Supabase" in s
    assert "Use Auth0" in s
    assert "yes/no" in s.lower() or "yes or no" in s.lower()


def test_judge_request_specifies_json_output():
    s = contradict_judge(
        a_title="Use Supabase", a_body="...", b_title="Migrate to Auth0", b_body="...",
        a_id="mem_1", b_id="mem_2",
    )
    assert "json" in s.lower()
    assert "has_contradiction" in s
    assert "severity" in s
    assert "suggested_action" in s
    # Both ids present so the response can reference them by id
    assert "mem_1" in s and "mem_2" in s


def test_parse_judge_response_extracts_fields():
    raw = (
        '{"has_contradiction": true, "severity": "high", '
        '"reasoning": "The two specify different auth providers", '
        '"suggested_action": "supersede_M_with_N"}'
    )
    j = parse_judge_response(raw)
    assert j.has_contradiction is True
    assert j.severity == "high"
    assert j.suggested_action == "supersede_M_with_N"


def test_parse_judge_response_handles_extra_text():
    """Sonnet sometimes prefixes the JSON with prose; parse should be tolerant."""
    raw = (
        "Here is my analysis:\n"
        '{"has_contradiction": false, "severity": "low", '
        '"reasoning": "different facets", "suggested_action": "none"}'
    )
    j = parse_judge_response(raw)
    assert j.has_contradiction is False
    assert j.suggested_action == "none"


def test_parse_judge_response_returns_none_on_unparseable():
    j = parse_judge_response("not json at all")
    assert j is None


def test_summary_for_period_includes_titles_and_period():
    memories = [
        {"id": "mem_1", "type": "decision", "title": "Use Supabase", "content": "..."},
        {"id": "mem_2", "type": "observation", "title": "Free tier limits", "content": "..."},
    ]
    s = summary_for_period(project="myapp", period="daily", memories=memories)
    assert "myapp" in s
    assert "daily" in s.lower()
    assert "Use Supabase" in s
    assert "Free tier limits" in s
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/llm/prompts.py`**

```python
"""Prompt templates for the Anthropic-driven keeper ops.

Three callable builders: contradict_prefilter, contradict_judge,
summary_for_period. Plus parse_judge_response() to extract structured
output from Sonnet's JSON-flavored reply (tolerant of leading prose)."""

import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass
class JudgeResponse:
    has_contradiction: bool
    severity: str
    reasoning: str
    suggested_action: str


def _truncate(text: str, max_chars: int = 500) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 3] + "..."


def contradict_prefilter(
    *, a_title: str, a_body: str, b_title: str, b_body: str,
) -> str:
    return f"""You are helping classify pairs of memory notes.

Below are two notes from a personal knowledge vault. Determine whether
they are about the **same topic** (same project, same subsystem, or same
specific decision/observation/learning).

Reply with **only** the word "yes" or "no". No explanation.

Note A: {a_title}
{_truncate(a_body)}

Note B: {b_title}
{_truncate(b_body)}

Same topic?"""


def contradict_judge(
    *, a_id: str, b_id: str,
    a_title: str, a_body: str,
    b_title: str, b_body: str,
) -> str:
    return f"""You are auditing a personal knowledge vault for contradictions.

Two memories are below; both have been flagged as being about the same
topic. Decide whether they actually **contradict** (assert mutually
incompatible facts about the same subject) or merely cover **different
facets** of the same topic without disagreement.

Reply in **JSON** with these exact fields:

- has_contradiction: boolean
- severity: "low" | "medium" | "high"
  ("low" = nuance/scope; "medium" = real but recoverable; "high" = direct reversal)
- reasoning: brief explanation citing specifics from both memories
- suggested_action: one of:
  * "supersede_M_with_N" (M is older/wrong; N replaces it)
  * "supersede_N_with_M" (N is older/wrong; M replaces it)
  * "merge" (both have value; combine into a unified memory)
  * "both_active_different_facets" (no real contradiction)
  * "none" (no action — keep both as-is)

Memory M (id: {a_id}): {a_title}
{_truncate(a_body, 800)}

Memory N (id: {b_id}): {b_title}
{_truncate(b_body, 800)}

Respond with only the JSON object. No preamble, no markdown fences."""


_PERIOD_HEADER = {
    "daily":   "Daily summary",
    "weekly":  "Weekly summary",
    "monthly": "Monthly summary",
}


def summary_for_period(
    *, project: str, period: str, memories: list[dict[str, Any]],
) -> str:
    header = _PERIOD_HEADER[period]
    sections = []
    for m in memories:
        sections.append(
            f"- [{m['type']}] {m['title']}\n  id: {m['id']}\n  {_truncate(m.get('content', ''), 300)}"
        )
    body = "\n\n".join(sections)
    return f"""{header} for project: {project}

Below are memories from this project from the relevant time window. Produce
a concise markdown summary (300–800 words) that:

1. Lists the key decisions (under a "## Decisions" heading).
2. Highlights notable observations and learnings (under "## Observations").
3. Calls out open questions or todos (under "## Open").

Be specific — cite memory titles when useful. Don't invent facts not
present below. Don't include preamble or postscript outside the headings.

Memories:

{body}"""


def parse_judge_response(text: str) -> JudgeResponse | None:
    """Extract the first {...} JSON object from text. Tolerant of prose preamble."""
    if not text:
        return None
    # Find the outermost {...}
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    try:
        return JudgeResponse(
            has_contradiction=bool(data["has_contradiction"]),
            severity=str(data.get("severity", "low")),
            reasoning=str(data.get("reasoning", "")),
            suggested_action=str(data.get("suggested_action", "none")),
        )
    except (KeyError, TypeError):
        return None
```

- [ ] **Step 4: Run (expect 6 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/llm/prompts.py packages/keeper/tests/test_llm_prompts.py
git commit -m "feat(keeper): add llm/prompts (contradict + summary templates, JSON parser)"
```

---

### Task 7: `anthropic_mock` test fixture

**Files:**
- Modify: `packages/keeper/tests/conftest.py`

- [ ] **Step 1: Append to `tests/conftest.py`**

```python
"""Anthropic SDK mock for keeper unit tests."""
from unittest.mock import MagicMock

import pytest


def _msg(text: str, in_tokens: int = 100, out_tokens: int = 20):
    """Construct a stub MagicMock that mimics anthropic.types.Message shape."""
    block = MagicMock()
    block.type = "text"
    block.text = text
    msg = MagicMock()
    msg.content = [block]
    msg.usage = MagicMock(input_tokens=in_tokens, output_tokens=out_tokens)
    msg.stop_reason = "end_turn"
    return msg


@pytest.fixture
def anthropic_mock():
    """Yields (sdk_stub, set_response) where set_response(text) queues
    the next reply from sdk.messages.create. Multiple replies queue up FIFO."""
    sdk = MagicMock()
    queue: list[MagicMock] = []

    def set_response(text: str, *, in_tokens: int = 100, out_tokens: int = 20):
        queue.append(_msg(text, in_tokens, out_tokens))

    def _create(**kwargs):
        if not queue:
            return _msg("default-mock-response")
        return queue.pop(0)

    sdk.messages.create.side_effect = _create
    return sdk, set_response
```

- [ ] **Step 2: Smoke check (existing tests still pass + the fixture is importable):**

```bash
cd packages/keeper && uv run pytest -k "not anthropic_real" 2>&1 | grep -E "passed|failed" | tail -1
```

Expected: 65+ passing (46 existing + 14 from this batch).

- [ ] **Step 3: Commit**

```bash
git add packages/keeper/tests/conftest.py
git commit -m "test(keeper): add anthropic_mock fixture for offline LLM tests"
```

---

### Task 8: `config.py` extension — `ContradictConfig`, `SummarizeConfig`, `BudgetConfig`

**Files:**
- Modify: `packages/keeper/src/vault_mem_keeper/config.py`
- Modify: `packages/keeper/tests/test_config.py`
- Modify: `vault-template/_system/config.yaml.example`
- Modify: `docs/CONFIG.md`

- [ ] **Step 1: Extend `config.py`**

After the existing `ArchiveConfig` class (and before `KeeperConfig`), add:

```python
class _SummaryPeriodConfig(BaseModel):
    enabled: bool = True
    min_new_memories: int


class ContradictConfig(BaseModel):
    enabled: bool = True
    top_k: int = 5
    min_severity: str = "medium"
    types_to_scan: list[str] = Field(default_factory=lambda: [
        "decision", "observation", "learning", "question",
    ])
    haiku_model: str = "claude-haiku-4-5"
    sonnet_model: str = "claude-sonnet-4-7"


class SummarizeConfig(BaseModel):
    enabled: bool = True
    daily: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=5))
    weekly: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=20))
    monthly: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=80))
    max_input_memories: int = 50
    max_input_tokens: int = 6000
    archive_predecessors: bool = False


class BudgetConfig(BaseModel):
    enabled: bool = True
    monthly_usd_cap: float = 5.00
    log_path: str = "_system/budget.jsonl"
```

In `KeeperConfig`, add the new fields:

```python
class KeeperConfig(BaseModel):
    triage: TriageConfig = Field(default_factory=TriageConfig)
    link: LinkConfig = Field(default_factory=LinkConfig)
    decay: DecayConfig = Field(default_factory=DecayConfig)
    archive: ArchiveConfig = Field(default_factory=ArchiveConfig)
    contradict: ContradictConfig = Field(default_factory=ContradictConfig)     # NEW
    summarize: SummarizeConfig = Field(default_factory=SummarizeConfig)        # NEW
    budget: BudgetConfig = Field(default_factory=BudgetConfig)                 # NEW
    state_path: str = "_system/state.json"                                     # NEW
```

- [ ] **Step 2: Add tests in `tests/test_config.py`**

Append:

```python
def test_loads_default_phase5_config_when_section_missing():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.contradict.enabled is True
        assert cfg.contradict.top_k == 5
        assert cfg.summarize.daily.min_new_memories == 5
        assert cfg.budget.monthly_usd_cap == 5.00
        assert cfg.state_path == "_system/state.json"


def test_loads_custom_phase5_overrides():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
            "keeper:\n"
            "  budget:\n"
            "    monthly_usd_cap: 20.0\n"
            "  summarize:\n"
            "    daily:\n"
            "      min_new_memories: 10\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.budget.monthly_usd_cap == 20.0
        assert cfg.summarize.daily.min_new_memories == 10
        # Untouched defaults remain
        assert cfg.contradict.top_k == 5
```

- [ ] **Step 3: Run (expect 5 PASS — 3 existing + 2 new).**

- [ ] **Step 4: Update `vault-template/_system/config.yaml.example`**

Append to the existing `keeper:` section:

```yaml
  contradict:
    enabled: true
    top_k: 5
    min_severity: "medium"
    types_to_scan: ["decision", "observation", "learning", "question"]
    haiku_model: "claude-haiku-4-5"
    sonnet_model: "claude-sonnet-4-7"
  summarize:
    enabled: true
    daily:
      enabled: true
      min_new_memories: 5
    weekly:
      enabled: true
      min_new_memories: 20
    monthly:
      enabled: true
      min_new_memories: 80
    max_input_memories: 50
    max_input_tokens: 6000
    archive_predecessors: false
  budget:
    enabled: true
    monthly_usd_cap: 5.00
    log_path: "_system/budget.jsonl"
  state_path: "_system/state.json"
```

- [ ] **Step 5: Append a section to `docs/CONFIG.md`**

After the existing `keeper.archive` section, add tables for `keeper.contradict`, `keeper.summarize`, `keeper.budget`, and `keeper.state_path`. Use the same table format as the existing sections (Field / Type / Default / Notes).

- [ ] **Step 6: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/config.py packages/keeper/tests/test_config.py vault-template/_system/config.yaml.example docs/CONFIG.md
git commit -m "feat(keeper): add Phase 5 config (contradict, summarize, budget, state_path)"
```

---

### Task 9: `ops/contradict.py`

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/contradict.py`
- Create: `packages/keeper/tests/ops/test_contradict.py`

This is the largest single op. It uses everything from Tasks 2–8.

- [ ] **Step 1: Write failing integration test**

```python
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter
import lancedb
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas
from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient
from vault_mem_keeper.ops.contradict import run_contradict
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.state import read_state, write_state

EMBED_DIM = 384


def _seed_canonical_decision(vault_root: Path, mid: str, *, title: str, content: str,
                              project: str = "myapp", updated_days_ago: int = 1) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    ts = (datetime.now(UTC) - timedelta(days=updated_days_ago)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid, "type": "decision", "title": title,
        "agent": "human", "session": None,
        "created": ts, "updated": ts,
        "confidence": 0.85,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": project, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    Path(paths.memory_file("decision", mid, "memory")).write_text(
        frontmatter.dumps(frontmatter.Post(content, **fm)),
    )


def _seed_indexes(vault_root: Path, *, similar_pair_ids: tuple[str, str]) -> None:
    """Seed FTS5 + Lance with the canonical memories. Make the two ids
    have very-similar vectors so they neighbor each other."""
    import sqlite3
    paths = vault_paths(str(vault_root))
    Path(paths.system_dir).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(paths.index_file)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    rows = []
    today = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    for mid, title in [(similar_pair_ids[0], "Use Supabase"), (similar_pair_ids[1], "Migrate to Auth0")]:
        rows.append((
            mid, "decision", title, "auth backend choice",
            json.dumps([]), "myapp", "active", "memory",
            f"/v/memory/decisions/{mid}.md", today,
        ))
    db.executemany(
        "INSERT INTO memories_fts (id,type,title,body,tags,project,status,location,path,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()

    db = lancedb.connect(paths.lance_dir)
    rows = []
    for i, mid in enumerate(similar_pair_ids):
        v = [0.0] * EMBED_DIM
        v[0] = 0.99 if i == 0 else 0.97  # extremely similar vectors
        v[1] = 0.05 if i == 0 else 0.10
        rows.append({
            "id": mid, "vector": v, "type": "decision",
            "title": "Use Supabase" if i == 0 else "Migrate to Auth0",
            "project": "myapp", "tags": [],
            "status": "active", "location": "memory",
            "path": f"/v/memory/decisions/{mid}.md",
            "updated": today,
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        })
    db.create_table("memories", rows)


def test_contradict_writes_proposal_for_high_severity_match(tmp_vault, anthropic_mock):
    sdk, set_response = anthropic_mock
    paths = vault_paths(str(tmp_vault))
    pair_a = "mem_2026-04-15_aaa001"
    pair_b = "mem_2026-04-29_bbb002"
    _seed_canonical_decision(tmp_vault, pair_a, title="Use Supabase",
                              content="auth backend", updated_days_ago=15)
    _seed_canonical_decision(tmp_vault, pair_b, title="Migrate to Auth0",
                              content="auth backend", updated_days_ago=1)
    _seed_indexes(tmp_vault, similar_pair_ids=(pair_a, pair_b))
    Path(paths.audit_file).touch()

    # Mock LLM responses: prefilter says "yes", judge says contradiction high
    set_response("yes")  # prefilter
    set_response('{"has_contradiction": true, "severity": "high", '
                 '"reasoning": "Different auth providers for same project", '
                 '"suggested_action": "supersede_M_with_N"}')  # judge

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=cfg.budget.monthly_usd_cap)
    client = AnthropicClient(
        sdk=sdk, budget=bt,
        haiku_model=cfg.contradict.haiku_model,
        sonnet_model=cfg.contradict.sonnet_model,
        api_key="test",
    )

    # Reset state so the op considers the new memories.
    write_state(paths.state_file, {"last_contradict_at": "1970-01-01T00:00:00Z", "summaries": {}})

    report = run_contradict(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")

    assert Path(paths.proposals_file).is_file()
    lines = [json.loads(l) for l in Path(paths.proposals_file).read_text().splitlines() if l.strip()]
    assert len(lines) == 1
    assert lines[0]["kind"] == "contradict"
    assert lines[0]["severity"] == "high"
    assert {lines[0]["source_id"], lines[0]["target_id"]} == {pair_a, pair_b}
    assert report.proposals_written == 1


def test_contradict_skips_when_prefilter_says_different_topic(tmp_vault, anthropic_mock):
    sdk, set_response = anthropic_mock
    paths = vault_paths(str(tmp_vault))
    pair_a = "mem_2026-04-15_aaa001"
    pair_b = "mem_2026-04-29_bbb002"
    _seed_canonical_decision(tmp_vault, pair_a, title="A",
                              content="x", updated_days_ago=15)
    _seed_canonical_decision(tmp_vault, pair_b, title="B",
                              content="y", updated_days_ago=1)
    _seed_indexes(tmp_vault, similar_pair_ids=(pair_a, pair_b))
    Path(paths.audit_file).touch()

    set_response("no")  # prefilter says different topic
    # No judge response queued — if we needed it, the test would fail with default mock.

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=cfg.budget.monthly_usd_cap)
    client = AnthropicClient(
        sdk=sdk, budget=bt,
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key="test",
    )
    write_state(paths.state_file, {"last_contradict_at": "1970-01-01T00:00:00Z", "summaries": {}})

    report = run_contradict(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")

    assert report.pairs_judged == 0
    assert report.proposals_written == 0
    assert not Path(paths.proposals_file).read_text().strip()


def test_contradict_skips_when_no_api_key(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=5.0)
    client = AnthropicClient(
        sdk=None, budget=bt,
        haiku_model="x", sonnet_model="y", api_key=None,
    )
    report = run_contradict(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")
    assert report.skipped is True
    assert "API key" in (report.reason or "")


def test_contradict_dry_run_does_not_write_proposals(tmp_vault, anthropic_mock):
    sdk, set_response = anthropic_mock
    paths = vault_paths(str(tmp_vault))
    pair_a = "mem_2026-04-15_aaa001"
    pair_b = "mem_2026-04-29_bbb002"
    _seed_canonical_decision(tmp_vault, pair_a, title="Use Supabase", content="x", updated_days_ago=15)
    _seed_canonical_decision(tmp_vault, pair_b, title="Migrate Auth0", content="x", updated_days_ago=1)
    _seed_indexes(tmp_vault, similar_pair_ids=(pair_a, pair_b))
    Path(paths.audit_file).touch()

    set_response("yes")
    set_response('{"has_contradiction": true, "severity": "high", "reasoning": "x", '
                 '"suggested_action": "supersede_M_with_N"}')

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=5.0)
    client = AnthropicClient(
        sdk=sdk, budget=bt,
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key="test",
    )
    write_state(paths.state_file, {"last_contradict_at": "1970-01-01T00:00:00Z", "summaries": {}})

    run_contradict(paths, cfg, schemas, audit, client,
                     dry_run=True, run_id="r-test")
    # No proposals.jsonl written
    assert not Path(paths.proposals_file).read_text().strip() if Path(paths.proposals_file).exists() else True
```

(Add the `--ignore=tests/test_e2e.py` exclusion to keep the test fast — already done in CI.)

- [ ] **Step 2: Run (expect FAIL — module not found).**

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/contradict.py`**

```python
"""Contradiction detection: Haiku pre-filter + Sonnet judge over Lance neighbors.

Iterates over canonical memories whose `updated` field is newer than
state.last_contradict_at. For each, finds top-K Lance neighbors (same
type), filters dedupe-already-judged pairs, runs the two LLM passes,
and writes proposals for medium+ severity contradictions."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..audit import Auditor
from ..config import KeeperConfig
from ..fts import FtsReader
from ..lance import LanceReader
from ..llm.client import AnthropicClient, BudgetExceeded
from ..llm.prompts import contradict_judge, contradict_prefilter, parse_judge_response
from ..logging import get_logger
from ..paths import VaultPaths
from ..proposals import Proposal, open_proposals
from ..state import read_state, write_state
from ..frontmatter import parse_memory_file

log = get_logger(__name__)

_SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3}


@dataclass
class ContradictReport:
    skipped: bool = False
    reason: str | None = None
    memories_scanned: int = 0
    pairs_judged: int = 0
    proposals_written: int = 0
    cost_usd: float = 0.0
    errors: int = 0


def _load_body(memory_path: str) -> str:
    try:
        _fm, content = parse_memory_file(memory_path)
        return content
    except Exception:
        return ""


def run_contradict(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    client: AnthropicClient,
    *,
    dry_run: bool,
    run_id: str,
) -> ContradictReport:
    if not cfg.contradict.enabled:
        return ContradictReport(skipped=True, reason="disabled")
    if not client.has_key():
        return ContradictReport(skipped=True, reason="missing ANTHROPIC_API_KEY")

    state = read_state(paths.state_file)
    threshold = state.get("last_contradict_at") or "1970-01-01T00:00:00Z"
    report = ContradictReport()

    fts = FtsReader(paths.index_file)
    try:
        all_canonical = fts.list({"location": "memory", "status": "active"})
    finally:
        fts.close()

    new_canonical = [
        m for m in all_canonical
        if m["updated"] > threshold
        and m["type"] in cfg.contradict.types_to_scan
    ]
    report.memories_scanned = len(new_canonical)

    if not new_canonical:
        if not dry_run:
            from datetime import UTC, datetime
            state["last_contradict_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            write_state(paths.state_file, state)
        return report

    try:
        lance = LanceReader(paths.lance_dir)
    except Exception as e:
        log.warn("contradict: Lance unavailable", err=str(e))
        return ContradictReport(skipped=True, reason=f"Lance unavailable: {e}")

    proposals = open_proposals(paths.proposals_file)
    min_severity_rank = _SEVERITY_RANK.get(cfg.contradict.min_severity, 2)

    try:
        for M in new_canonical:
            m_lance = lance.get_by_id(M["id"])
            if not m_lance:
                continue
            try:
                neighbors = lance.search(
                    m_lance["vector"],
                    filter_={
                        "status": "active",
                        "location": "memory",
                        "type": M["type"],
                    },
                    limit=cfg.contradict.top_k + 1,
                )
            except Exception as e:
                log.warn("contradict: Lance search failed", id=M["id"], err=str(e))
                report.errors += 1
                continue

            for N in neighbors:
                if N["id"] == M["id"]:
                    continue
                if proposals.already_judged(M["id"], N["id"], M["updated"], N["updated"]):
                    continue

                m_body = _load_body(M["path"])
                n_body = _load_body(N["path"])

                # Pre-filter
                try:
                    pre = client.haiku(
                        contradict_prefilter(
                            a_title=M["title"], a_body=m_body,
                            b_title=N["title"], b_body=n_body,
                        ),
                        op="contradict_prefilter", run_id=run_id, max_tokens=8,
                    )
                except BudgetExceeded:
                    audit.write({
                        "op": "budget_exceeded",
                        "agent": "keeper", "session": run_id,
                        "monthly_total_usd": client._budget.month_to_date(),
                        "cap_usd": cfg.budget.monthly_usd_cap,
                    })
                    return report  # ← short-circuit; skip remaining pairs
                except Exception as e:
                    log.warn("contradict: prefilter failed", err=str(e))
                    report.errors += 1
                    continue
                report.cost_usd += pre.cost_usd

                if not pre.text.strip().lower().startswith("yes"):
                    continue
                report.pairs_judged += 1

                # Judge
                try:
                    judge = client.sonnet(
                        contradict_judge(
                            a_id=M["id"], b_id=N["id"],
                            a_title=M["title"], a_body=m_body,
                            b_title=N["title"], b_body=n_body,
                        ),
                        op="contradict_judge", run_id=run_id, max_tokens=600,
                    )
                except BudgetExceeded:
                    audit.write({
                        "op": "budget_exceeded",
                        "agent": "keeper", "session": run_id,
                        "monthly_total_usd": client._budget.month_to_date(),
                        "cap_usd": cfg.budget.monthly_usd_cap,
                    })
                    return report
                except Exception as e:
                    log.warn("contradict: judge failed", err=str(e))
                    report.errors += 1
                    continue
                report.cost_usd += judge.cost_usd

                parsed = parse_judge_response(judge.text)
                if parsed is None:
                    log.warn("contradict: malformed judge response", text=judge.text[:200])
                    report.errors += 1
                    continue

                if not parsed.has_contradiction:
                    continue
                if _SEVERITY_RANK.get(parsed.severity, 0) < min_severity_rank:
                    continue

                if dry_run:
                    log.info("[dry-run] would write contradict proposal",
                             source=M["id"], target=N["id"], severity=parsed.severity)
                    report.proposals_written += 1
                    continue

                proposals.append(Proposal(
                    kind="contradict",
                    source_id=M["id"], target_id=N["id"],
                    severity=parsed.severity, reasoning=parsed.reasoning,
                    suggested_action=parsed.suggested_action,
                    model=cfg.contradict.sonnet_model,
                    cost_usd=pre.cost_usd + judge.cost_usd,
                    run_id=run_id,
                    source_updated=M["updated"], target_updated=N["updated"],
                ))
                report.proposals_written += 1
    finally:
        lance.close()
        proposals.close()

    if not dry_run:
        from datetime import UTC, datetime
        state["last_contradict_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        write_state(paths.state_file, state)
        audit.write({
            "op": "contradict_scan",
            "agent": "keeper", "session": run_id,
            "memories_scanned": report.memories_scanned,
            "pairs_judged": report.pairs_judged,
            "proposals_written": report.proposals_written,
            "cost_usd": report.cost_usd,
        })
    return report
```

- [ ] **Step 4: Run (expect 4 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/contradict.py packages/keeper/tests/ops/test_contradict.py
git commit -m "feat(keeper): implement contradict op (Haiku prefilter + Sonnet judge)"
```

---

### Task 10: `ops/summarize.py`

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/summarize.py`
- Create: `packages/keeper/tests/ops/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas
from vault_mem_keeper.llm.budget import BudgetTracker
from vault_mem_keeper.llm.client import AnthropicClient
from vault_mem_keeper.ops.summarize import run_summarize
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.state import write_state


def _seed_decision(vault_root: Path, mid: str, *, title: str, project: str = "myapp"):
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid, "type": "decision", "title": title,
        "agent": "human", "session": None,
        "created": ts, "updated": ts,
        "confidence": 0.85,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": project, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    Path(paths.memory_file("decision", mid, "memory")).write_text(
        frontmatter.dumps(frontmatter.Post(f"body for {title}", **fm)),
    )


def _seed_fts(vault_root: Path, mids: list[tuple[str, str, str]]):
    """mids: [(id, title, project)]"""
    import sqlite3
    paths = vault_paths(str(vault_root))
    Path(paths.system_dir).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(paths.index_file)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    rows = [
        (mid, "decision", title, f"body for {title}",
         json.dumps([]), proj, "active", "memory",
         f"/v/memory/decisions/{mid}.md", ts)
        for (mid, title, proj) in mids
    ]
    db.executemany(
        "INSERT INTO memories_fts (id,type,title,body,tags,project,status,location,path,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()


def test_summarize_writes_summary_memory_when_threshold_met(tmp_vault, anthropic_mock):
    sdk, set_response = anthropic_mock
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("summary")).mkdir(parents=True, exist_ok=True)
    Path(paths.audit_file).touch()
    cfg = KeeperConfig()

    # Seed 6 decisions for project "myapp" — exceeds daily threshold of 5
    seed = [
        (f"mem_2026-05-01_aa00{i:02d}", f"Decision {i}", "myapp")
        for i in range(6)
    ]
    for mid, title, proj in seed:
        _seed_decision(tmp_vault, mid, title=title, project=proj)
    _seed_fts(tmp_vault, seed)

    write_state(paths.state_file, {"last_contradict_at": None, "summaries": {}})
    set_response("## Decisions\n\n- We chose X for the auth path.\n\n## Observations\n\n- Y notes.")

    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=5.0)
    client = AnthropicClient(
        sdk=sdk, budget=bt,
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key="test",
    )

    report = run_summarize(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")

    assert report.summaries_written >= 1
    written = list(Path(paths.memory_dir("summary")).glob("*.md"))
    assert len(written) >= 1
    fm, body = frontmatter.parse(written[0].read_text())
    assert fm["type"] == "summary"
    assert fm["project"] == "myapp"
    assert fm["period"] == "daily"
    assert "## Decisions" in body
    assert isinstance(fm["covers"], list)
    assert len(fm["covers"]) == 6


def test_summarize_skips_when_below_threshold(tmp_vault, anthropic_mock):
    sdk, _ = anthropic_mock
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("summary")).mkdir(parents=True, exist_ok=True)
    Path(paths.audit_file).touch()
    cfg = KeeperConfig()

    # Only 3 decisions — below daily threshold of 5
    seed = [
        (f"mem_2026-05-01_bb00{i:02d}", f"D{i}", "myapp") for i in range(3)
    ]
    for mid, title, proj in seed:
        _seed_decision(tmp_vault, mid, title=title, project=proj)
    _seed_fts(tmp_vault, seed)
    write_state(paths.state_file, {"last_contradict_at": None, "summaries": {}})

    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=5.0)
    client = AnthropicClient(
        sdk=sdk, budget=bt,
        haiku_model="claude-haiku-4-5", sonnet_model="claude-sonnet-4-7",
        api_key="test",
    )

    report = run_summarize(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")

    assert report.summaries_written == 0


def test_summarize_skips_when_no_api_key(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=5.0)
    client = AnthropicClient(
        sdk=None, budget=bt,
        haiku_model="x", sonnet_model="y", api_key=None,
    )

    report = run_summarize(paths, cfg, schemas, audit, client,
                              dry_run=False, run_id="r-test")
    assert report.skipped is True
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/summarize.py`**

```python
"""Per-(project, period) summarization driven by Sonnet.

Triggers when (a) time since last summary for the period has elapsed,
AND (b) the new-memory threshold has been met. Writes a `summary` memory
with `covers: [memory_ids]` provenance."""

import secrets
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..fts import FtsReader
from ..frontmatter import serialize_memory
from ..llm.client import AnthropicClient, BudgetExceeded
from ..llm.prompts import summary_for_period
from ..logging import get_logger
from ..paths import VaultPaths
from ..state import read_state, write_state

log = get_logger(__name__)

_PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}
_BUCKET_ORDER = ["decision", "learning", "observation", "summary",
                 "todo", "entity", "question"]


@dataclass
class SummarizeReport:
    skipped: bool = False
    reason: str | None = None
    summaries_written: int = 0
    cost_usd: float = 0.0
    errors: int = 0


def _new_summary_id() -> str:
    today = datetime.now(UTC).date().isoformat()
    return f"mem_{today}_{secrets.token_hex(3)}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _read_body(path: str) -> str:
    try:
        from ..frontmatter import parse_memory_file
        _fm, body = parse_memory_file(path)
        return body
    except Exception:
        return ""


def run_summarize(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    client: AnthropicClient,
    *,
    dry_run: bool,
    run_id: str,
) -> SummarizeReport:
    if not cfg.summarize.enabled:
        return SummarizeReport(skipped=True, reason="disabled")
    if not client.has_key():
        return SummarizeReport(skipped=True, reason="missing ANTHROPIC_API_KEY")

    report = SummarizeReport()
    state = read_state(paths.state_file)
    summaries_state = state.get("summaries") or {}

    fts = FtsReader(paths.index_file)
    try:
        all_active = fts.list({"location": "memory", "status": "active"})
    finally:
        fts.close()

    # Group by project
    by_project: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in all_active:
        proj = m.get("project")
        if proj:
            by_project[proj].append(m)

    now = datetime.now(UTC)

    for project, project_memories in by_project.items():
        for period in ("daily", "weekly", "monthly"):
            period_cfg = getattr(cfg.summarize, period)
            if not period_cfg.enabled:
                continue
            cutoff = now - timedelta(days=_PERIOD_DAYS[period])
            recent = [
                m for m in project_memories
                if _parse_iso(m["updated"]) >= cutoff
            ]
            if len(recent) < period_cfg.min_new_memories:
                continue
            last_run = summaries_state.get(project, {}).get(period)
            if last_run:
                last_run_dt = _parse_iso(last_run)
                if (now - last_run_dt) < timedelta(days=_PERIOD_DAYS[period]):
                    continue

            # Order by bucket priority then recency desc, truncate
            ordered = sorted(
                recent,
                key=lambda m: (
                    _BUCKET_ORDER.index(m["type"]) if m["type"] in _BUCKET_ORDER else 99,
                    -_parse_iso(m["updated"]).timestamp(),
                ),
            )[:cfg.summarize.max_input_memories]

            input_memories = [
                {
                    "id": m["id"], "type": m["type"], "title": m["title"],
                    "content": _read_body(m["path"])[:1000],
                }
                for m in ordered
            ]
            prompt = summary_for_period(
                project=project, period=period, memories=input_memories,
            )

            if dry_run:
                log.info("[dry-run] would summarize",
                         project=project, period=period, count=len(ordered))
                report.summaries_written += 1
                continue

            try:
                resp = client.sonnet(prompt, op=f"summarize_{period}",
                                      run_id=run_id, max_tokens=1200)
            except BudgetExceeded:
                audit.write({
                    "op": "budget_exceeded",
                    "agent": "keeper", "session": run_id,
                    "monthly_total_usd": client._budget.month_to_date(),
                    "cap_usd": cfg.budget.monthly_usd_cap,
                })
                return report
            except Exception as e:
                log.warn("summarize: SDK call failed", err=str(e), project=project, period=period)
                report.errors += 1
                continue
            report.cost_usd += resp.cost_usd

            summary_id = _new_summary_id()
            iso = _now_iso()
            fm = {
                "id": summary_id, "type": "summary",
                "title": f"{period.capitalize()} summary for {project} — {datetime.now(UTC).date().isoformat()}",
                "agent": "keeper", "session": run_id,
                "created": iso, "updated": iso,
                "confidence": 1.0,
                "sources": [], "contradicts": [], "supersedes": [],
                "tags": [project, period, "auto-generated"],
                "project": project,
                "period": period,
                "covers": [m["id"] for m in ordered],
                "ttl_days": None, "status": "active",
                "human_reviewed": False, "human_approved": None,
                "schema_version": "0.1",
            }
            target = paths.memory_file("summary", summary_id, "memory")
            Path(target).parent.mkdir(parents=True, exist_ok=True)
            atomic_write(target, serialize_memory(fm, resp.text))

            audit.write({
                "op": "summarize",
                "agent": "keeper", "session": run_id,
                "project": project, "period": period,
                "memory_id": summary_id,
                "covers_count": len(ordered),
                "cost_usd": resp.cost_usd,
            })
            report.summaries_written += 1

            # Update state
            summaries_state.setdefault(project, {})[period] = iso

    if not dry_run:
        state["summaries"] = summaries_state
        write_state(paths.state_file, state)

    return report
```

- [ ] **Step 4: Run (expect 3 PASS).**

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/summarize.py packages/keeper/tests/ops/test_summarize.py
git commit -m "feat(keeper): implement summarize op (per-project daily/weekly/monthly)"
```

---

### Task 11: `cli/review.py` interactive walker

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/cli/__init__.py` (empty)
- Create: `packages/keeper/src/vault_mem_keeper/cli/review.py`
- Create: `packages/keeper/tests/cli/__init__.py` (empty)
- Create: `packages/keeper/tests/cli/test_review.py`

- [ ] **Step 1: Write failing tests for the walker logic**

```python
import json
from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.cli.review import (
    apply_supersede, ReviewSession,
)
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.proposals import Proposal, open_proposals


def _seed_pair_for_supersede(vault_root: Path) -> tuple[str, str]:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)

    older_id = "mem_2026-04-15_aaa001"
    newer_id = "mem_2026-04-29_bbb002"
    ts = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    for mid, title in [(older_id, "Use Supabase"), (newer_id, "Use Auth0")]:
        fm = {
            "id": mid, "type": "decision", "title": title,
            "agent": "human", "session": None,
            "created": ts, "updated": ts,
            "confidence": 0.85,
            "sources": [], "contradicts": [], "supersedes": [], "tags": [],
            "project": "myapp", "ttl_days": None, "status": "active",
            "human_reviewed": False, "human_approved": None,
            "schema_version": "0.1",
        }
        Path(paths.memory_file("decision", mid, "memory")).write_text(
            frontmatter.dumps(frontmatter.Post(f"body of {title}", **fm)),
        )
    return older_id, newer_id


def test_apply_supersede_M_with_N_archives_M_and_updates_N(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    older, newer = _seed_pair_for_supersede(tmp_vault)
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    proposals = open_proposals(paths.proposals_file)
    p = proposals.append(Proposal(
        kind="contradict",
        source_id=older, target_id=newer,
        severity="high", reasoning="...",
        suggested_action="supersede_M_with_N",
        model="claude-sonnet-4-7", cost_usd=0.0034, run_id="rt",
        source_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        target_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    ))

    apply_supersede(paths, audit, proposals, p,
                     archive_id=older, surviving_id=newer)

    # Archived
    assert not Path(paths.memory_file("decision", older, "memory")).exists()
    assert Path(paths.memory_file("decision", older, "archive")).exists()

    # Status flipped
    archived_fm, _ = frontmatter.parse(Path(paths.memory_file("decision", older, "archive")).read_text())
    assert archived_fm["status"] == "superseded"

    # supersedes set on surviving
    surviving_fm, _ = frontmatter.parse(Path(paths.memory_file("decision", newer, "memory")).read_text())
    assert older in surviving_fm["supersedes"]

    # Proposal status updated
    proposals_after = open_proposals(paths.proposals_file)
    fresh = proposals_after.get(p.id)
    assert fresh is not None
    assert fresh.status == "applied"


def test_review_session_walks_pending_with_a_then_q(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    older, newer = _seed_pair_for_supersede(tmp_vault)
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    proposals = open_proposals(paths.proposals_file)
    proposals.append(Proposal(
        kind="contradict",
        source_id=older, target_id=newer,
        severity="high", reasoning="x",
        suggested_action="supersede_M_with_N",
        model="claude-sonnet-4-7", cost_usd=0.0034, run_id="rt",
        source_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        target_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    ))
    proposals.append(Proposal(
        kind="contradict",
        source_id="mem_2026-04-15_ccc003", target_id="mem_2026-04-29_ddd004",
        severity="medium", reasoning="y",
        suggested_action="supersede_M_with_N",
        model="claude-sonnet-4-7", cost_usd=0.001, run_id="rt",
        source_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        target_updated=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    ))

    out = StringIO()

    sess = ReviewSession(
        paths=paths, audit=audit, proposals=proposals,
        budget_mtd=0.0, budget_cap=5.0,
        out=out, prompts=iter(["a", "q"]),
    )
    sess.run()

    # First proposal: applied. Second: untouched (pending).
    proposals_after = open_proposals(paths.proposals_file)
    statuses = [p.status for p in proposals_after.iter_pending()]
    assert len(statuses) == 1


def test_review_session_reject_marks_rejected(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    proposals = open_proposals(paths.proposals_file)
    p = proposals.append(Proposal(
        kind="contradict",
        source_id="mem_x", target_id="mem_y",
        severity="medium", reasoning="z",
        suggested_action="supersede_M_with_N",
        model="claude-sonnet-4-7", cost_usd=0.001, run_id="rt",
        source_updated="2026-05-01T00:00:00Z",
        target_updated="2026-05-01T00:00:00Z",
    ))
    out = StringIO()
    sess = ReviewSession(
        paths=paths, audit=audit, proposals=proposals,
        budget_mtd=0.0, budget_cap=5.0,
        out=out, prompts=iter(["r", "q"]),
    )
    sess.run()
    proposals_after = open_proposals(paths.proposals_file)
    fresh = proposals_after.get(p.id)
    assert fresh.status == "rejected"
```

- [ ] **Step 2: Run (expect FAIL).**

- [ ] **Step 3: Write `src/vault_mem_keeper/cli/__init__.py`** (empty file).

- [ ] **Step 4: Write `src/vault_mem_keeper/cli/review.py`**

```python
"""Interactive proposal walker. `vault-mem-keeper review` entry point.

Walks pending proposals from _system/proposals.jsonl one at a time,
prompting the user to accept/reject/skip/view each."""

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, TextIO

import frontmatter

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..frontmatter import parse_memory_file, serialize_memory
from ..logging import get_logger
from ..paths import VaultPaths
from ..proposals import Proposal, ProposalsHandle, open_proposals

log = get_logger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _find_memory_file(paths: VaultPaths, mid: str) -> tuple[str, str] | None:
    """Return (path, location) for a memory id, or None if not found."""
    from ..paths import LOCATIONS, MEMORY_TYPES
    for loc in LOCATIONS:
        if loc == "archive":
            p = Path(paths.archive_dir, f"{mid}.md")
            if p.is_file():
                return (str(p), "archive")
            continue
        for t in MEMORY_TYPES:
            p = Path(paths.memory_file(t, mid, loc))
            if p.is_file():
                return (str(p), loc)
    return None


def apply_supersede(
    paths: VaultPaths,
    audit: Auditor,
    proposals: ProposalsHandle,
    proposal: Proposal,
    *,
    archive_id: str,
    surviving_id: str,
) -> None:
    """Mark `archive_id`.status=superseded, move to archive/.
    Add `archive_id` to `surviving_id`.supersedes."""
    archive_path = _find_memory_file(paths, archive_id)
    surviving_path = _find_memory_file(paths, surviving_id)
    if not archive_path or not surviving_path:
        log.warn("apply_supersede: missing files",
                 archive_id=archive_id, surviving_id=surviving_id)
        return

    # 1. Read + flip status + atomic write archive memory at OLD location
    fm_a, body_a = parse_memory_file(archive_path[0])
    fm_a["status"] = "superseded"
    fm_a["updated"] = _now_iso()
    atomic_write(archive_path[0], serialize_memory(fm_a, body_a))

    # 2. Move to archive/
    archive_target = str(Path(paths.archive_dir, f"{archive_id}.md"))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    os.rename(archive_path[0], archive_target)

    # 3. Update surviving memory's supersedes
    fm_s, body_s = parse_memory_file(surviving_path[0])
    sup = list(fm_s.get("supersedes") or [])
    if archive_id not in sup:
        sup.append(archive_id)
    fm_s["supersedes"] = sup
    fm_s["updated"] = _now_iso()
    atomic_write(surviving_path[0], serialize_memory(fm_s, body_s))

    # 4. Mark proposal applied
    proposals.set_status(proposal.id, "applied")

    audit.write({
        "op": "proposal_applied",
        "agent": "keeper", "session": _now_iso()[:19],
        "proposal_id": proposal.id, "kind": proposal.kind,
        "source_id": proposal.source_id, "target_id": proposal.target_id,
        "action_taken": proposal.suggested_action,
    })


@dataclass
class ReviewSession:
    paths: VaultPaths
    audit: Auditor
    proposals: ProposalsHandle
    budget_mtd: float
    budget_cap: float
    out: TextIO
    prompts: Iterator[str]
    filter_kind: str | None = None
    filter_severity: str | None = None
    filter_project: str | None = None

    def _prompt(self) -> str:
        try:
            return next(self.prompts)
        except StopIteration:
            return "q"

    def _passes_filters(self, p: Proposal) -> bool:
        if self.filter_kind and p.kind != self.filter_kind:
            return False
        # severity rank gate
        if self.filter_severity:
            rank = {"low": 1, "medium": 2, "high": 3}
            if rank.get(p.severity, 0) < rank.get(self.filter_severity, 0):
                return False
        return True

    def run(self) -> None:
        all_pending = [p for p in self.proposals.iter_pending() if self._passes_filters(p)]
        total = len(all_pending)
        self.out.write(f"\n{total} pending proposals.\n")
        self.out.write(
            f"Budget this month: ${self.budget_mtd:.2f} / ${self.budget_cap:.2f} cap "
            f"({self.budget_mtd / max(self.budget_cap, 0.01) * 100:.0f}%).\n\n",
        )
        for i, p in enumerate(all_pending, start=1):
            self.out.write(f"[{i}/{total}] {p.id}  {p.kind}  severity={p.severity}\n")
            self.out.write("─" * 60 + "\n")
            self.out.write(f"  Source:  {p.source_id}\n  Target:  {p.target_id}\n\n")
            self.out.write(f"  Reasoning:\n    {p.reasoning}\n\n")
            self.out.write(f"  Suggested action: {p.suggested_action}\n")
            self.out.write(f"  Cost: ${p.cost_usd:.4f}  (model: {p.model})\n\n")
            self.out.write("  [a]ccept  [r]eject  [s]kip  [q]uit\n> ")
            choice = self._prompt().strip().lower()
            if choice == "a":
                if p.suggested_action == "supersede_M_with_N":
                    apply_supersede(self.paths, self.audit, self.proposals, p,
                                     archive_id=p.source_id, surviving_id=p.target_id)
                elif p.suggested_action == "supersede_N_with_M":
                    apply_supersede(self.paths, self.audit, self.proposals, p,
                                     archive_id=p.target_id, surviving_id=p.source_id)
                else:
                    self.out.write(f"  ⚠ Action {p.suggested_action} requires manual handling — skipped.\n")
                self.out.write("  ✓ Applied.\n\n")
            elif choice == "r":
                self.proposals.set_status(p.id, "rejected")
                self.audit.write({
                    "op": "proposal_rejected",
                    "agent": "keeper", "session": _now_iso()[:19],
                    "proposal_id": p.id,
                })
                self.out.write("  ✗ Rejected.\n\n")
            elif choice == "q":
                break
            else:
                self.out.write("  Skipped.\n\n")
```

- [ ] **Step 5: Run (expect 3 PASS).**

- [ ] **Step 6: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/cli packages/keeper/tests/cli
git commit -m "feat(keeper): add cli/review interactive proposal walker"
```

---

### Task 12: `__main__.py` extension — `review` subcommand

**Files:**
- Modify: `packages/keeper/src/vault_mem_keeper/__main__.py`

- [ ] **Step 1: In `__main__.py`, add a `review` subparser**

After the existing `doctor` subparser block, add:

```python
    p_review = sub.add_parser("review", help="Interactively review pending proposals")
    _vault_arg(p_review)
    p_review.add_argument("--filter", choices=["contradict", "summary"], default=None)
    p_review.add_argument("--severity", choices=["low", "medium", "high"], default=None)
    p_review.add_argument("--project", default=None)
    p_review.set_defaults(func=cmd_review)
```

Add the `cmd_review` function (after `cmd_doctor`):

```python
def cmd_review(args: argparse.Namespace) -> int:
    configure_logging()
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)

    from .audit import Auditor
    from .cli.review import ReviewSession
    from .config import load_keeper_config
    from .llm.budget import BudgetTracker
    from .proposals import open_proposals

    cfg = load_keeper_config(vault)
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch(exist_ok=True)
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=cfg.budget.monthly_usd_cap)
    proposals = open_proposals(paths.proposals_file)

    sess = ReviewSession(
        paths=paths, audit=audit, proposals=proposals,
        budget_mtd=bt.month_to_date(), budget_cap=cfg.budget.monthly_usd_cap,
        out=sys.stdout,
        prompts=(line.strip() for line in iter(sys.stdin.readline, "")),
        filter_kind=args.filter,
        filter_severity=args.severity,
        filter_project=args.project,
    )
    sess.run()
    return 0
```

(Add `from pathlib import Path` if not already imported.)

- [ ] **Step 2: Smoke test — `vault-mem-keeper review --help`**

```bash
cd packages/keeper && uv run python -m vault_mem_keeper review --help 2>&1 | head -10
```

Expected: usage text including `--filter`, `--severity`, `--project`, `--vault`.

- [ ] **Step 3: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/__main__.py
git commit -m "feat(keeper): add review subcommand to CLI"
```

---

### Task 13: `runner.py` extension — register contradict + summarize

**Files:**
- Modify: `packages/keeper/src/vault_mem_keeper/runner.py`
- Modify: `packages/keeper/tests/test_runner.py`

- [ ] **Step 1: Update `runner.py`**

Add imports:

```python
from .llm.budget import BudgetTracker
from .llm.client import make_client
from .ops import contradict as contradict_op, summarize as summarize_op
from .proposals import open_proposals
```

Update `DEFAULT_OPS_ORDER`:

```python
DEFAULT_OPS_ORDER = ["triage", "link", "decay", "archive", "contradict", "summarize"]
```

Extend `OpReport` dataclass with new counter fields:

```python
@dataclass
class OpReport:
    name: str
    skipped: bool = False
    skip_reason: str | None = None
    error: str | None = None
    promoted: int = 0
    archived: int = 0
    decayed: int = 0
    link_count: int = 0
    from_count: int = 0
    proposals_written: int = 0      # NEW
    summaries_written: int = 0      # NEW
    cost_usd: float = 0.0           # NEW
```

Update `_apply_op` to copy these new fields when present:

```python
def _apply_op(name: str, run_op_fn, *args, **kwargs) -> OpReport:
    rep = OpReport(name=name)
    try:
        result = run_op_fn(*args, **kwargs)
        for fld in ("promoted", "archived", "decayed", "link_count",
                     "from_count", "proposals_written", "summaries_written",
                     "cost_usd"):
            if hasattr(result, fld):
                setattr(rep, fld, getattr(result, fld))
        # Carry skipped/reason if op declared them
        if hasattr(result, "skipped") and getattr(result, "skipped"):
            rep.skipped = True
            rep.skip_reason = getattr(result, "reason", None) or "skipped"
    except Exception as e:
        log.exception(f"op failed: {name}")
        rep.error = str(e)
    return rep
```

In `run_pass`, after building `index, schemas, audit`, instantiate the LLM client:

```python
    bt = BudgetTracker(paths.budget_file, monthly_cap_usd=cfg.budget.monthly_usd_cap)
    llm_client = make_client(
        budget=bt,
        haiku_model=cfg.contradict.haiku_model,
        sonnet_model=cfg.contradict.sonnet_model,
    )
```

In the dispatch chain, add two new branches:

```python
        elif name == "contradict":
            report.ops[name] = _apply_op(
                "contradict", contradict_op.run_contradict,
                paths, cfg, schemas, audit, llm_client,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "summarize":
            report.ops[name] = _apply_op(
                "summarize", summarize_op.run_summarize,
                paths, cfg, schemas, audit, llm_client,
                dry_run=opts.dry_run, run_id=run_id,
            )
```

Update the keeper_run audit summary to include `pending_proposals` and `budget_mtd_usd`:

```python
    if not opts.dry_run:
        proposals = open_proposals(paths.proposals_file)
        try:
            pending_count = proposals.count_pending()
        finally:
            proposals.close()
        audit.write({
            "op": "keeper_run",
            "agent": "keeper",
            "session": run_id,
            "duration_ms": report.duration_ms,
            "summary": {
                name: {k: v for k, v in op.__dict__.items()
                       if k not in ("name", "skipped", "skip_reason") and v}
                for name, op in report.ops.items()
            },
            "pending_proposals": pending_count,
            "budget_mtd_usd": round(bt.month_to_date(), 4),
        })
```

- [ ] **Step 2: Add a runner test for the new fields**

Append to `tests/test_runner.py`:

```python
def test_keeper_run_includes_pending_proposals_and_budget(tmp_vault, monkeypatch):
    """The keeper_run audit summary surfaces pending_proposals and budget_mtd_usd."""
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()
    # Skip contradict/summarize (no API key) — they should report skipped, not error.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    raw_lines = Path(paths.audit_file).read_text().splitlines()
    lines = [json.loads(line) for line in raw_lines if line.strip()]
    keeper_run = next(line for line in lines if line["op"] == "keeper_run")
    assert "pending_proposals" in keeper_run
    assert "budget_mtd_usd" in keeper_run
    assert keeper_run["pending_proposals"] == 0
    assert keeper_run["budget_mtd_usd"] == 0.0
```

- [ ] **Step 3: Run (expect existing 4 + 1 new = 5 PASS).**

```bash
cd packages/keeper && uv run pytest tests/test_runner.py
```

- [ ] **Step 4: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/runner.py packages/keeper/tests/test_runner.py
git commit -m "feat(keeper): wire contradict + summarize ops into runner; surface pending_proposals + budget_mtd_usd"
```

---

### Task 14: TS-side `AuditEntry` widening

**Files:**
- Modify: `packages/mcp/src/audit/index.ts`
- Modify: `packages/mcp/src/audit/audit.test.ts`

- [ ] **Step 1: Add new interfaces in `audit/index.ts`**

After the existing keeper-op interfaces (`AuditDecayOp`, `AuditArchiveOp`, etc.), add:

```ts
export interface AuditContradictScanOp {
  op: "contradict_scan";
  agent: string;
  session: string | null;
  memories_scanned: number;
  pairs_judged: number;
  proposals_written: number;
  cost_usd: number;
}

export interface AuditSummarizeOp {
  op: "summarize";
  agent: string;
  session: string | null;
  project: string;
  period: string;
  memory_id: string;
  covers_count: number;
  cost_usd: number;
}

export interface AuditBudgetExceededOp {
  op: "budget_exceeded";
  agent: string;
  session: string | null;
  monthly_total_usd: number;
  cap_usd: number;
}

export interface AuditProposalAppliedOp {
  op: "proposal_applied";
  agent: string;
  session: string | null;
  proposal_id: string;
  kind: string;
  source_id: string;
  target_id: string;
  action_taken: string;
}

export interface AuditProposalRejectedOp {
  op: "proposal_rejected";
  agent: string;
  session: string | null;
  proposal_id: string;
}
```

Extend the `AuditEntry` union:

```ts
export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp
  | AuditContextOp | AuditFailedOp
  | AuditDecayOp | AuditArchiveOp | AuditLinkRebuildOp | AuditKeeperRunOp
  | AuditContradictScanOp | AuditSummarizeOp | AuditBudgetExceededOp
  | AuditProposalAppliedOp | AuditProposalRejectedOp;
```

- [ ] **Step 2: Add a TS audit test**

Append to `audit.test.ts`:

```ts
  it("serializes Phase 5 keeper-shape entries cleanly", () => {
    const a = new Auditor(logPath);
    a.write({ op: "contradict_scan", agent: "keeper", session: "01H",
              memories_scanned: 5, pairs_judged: 3,
              proposals_written: 1, cost_usd: 0.0042 });
    a.write({ op: "summarize", agent: "keeper", session: "01H",
              project: "myapp", period: "daily",
              memory_id: "mem_2026-05-01_xxxxxx",
              covers_count: 6, cost_usd: 0.0048 });
    a.write({ op: "budget_exceeded", agent: "keeper", session: "01H",
              monthly_total_usd: 5.12, cap_usd: 5.0 });
    a.write({ op: "proposal_applied", agent: "keeper", session: "01H",
              proposal_id: "P-2026-05-01_aaaaaa",
              kind: "contradict",
              source_id: "mem_a", target_id: "mem_b",
              action_taken: "supersede_M_with_N" });
    a.write({ op: "proposal_rejected", agent: "keeper", session: "01H",
              proposal_id: "P-2026-05-01_bbbbbb" });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    const cs = JSON.parse(lines[0]!);
    expect(cs.op).toBe("contradict_scan");
    expect(cs.proposals_written).toBe(1);
    const su = JSON.parse(lines[1]!);
    expect(su.period).toBe("daily");
    const be = JSON.parse(lines[2]!);
    expect(be.cap_usd).toBe(5.0);
    const pa = JSON.parse(lines[3]!);
    expect(pa.action_taken).toBe("supersede_M_with_N");
    const pr = JSON.parse(lines[4]!);
    expect(pr.proposal_id).toBe("P-2026-05-01_bbbbbb");
  });
```

- [ ] **Step 3: Run TS test + typecheck**

```bash
pnpm --filter @vault-mem/mcp test 2>&1 | grep "Tests" | head -1
pnpm --filter @vault-mem/mcp typecheck 2>&1 | tail -1
```

Expected: 107 passing (106 + 1 new). Typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/audit/index.ts packages/mcp/src/audit/audit.test.ts
git commit -m "feat(mcp): widen AuditEntry union for Phase 5 keeper ops"
```

---

### Task 15: Final verification + docs polish

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Add to `CHANGELOG.md`** under `## [Unreleased]`:

```markdown
### Added (Unreleased)

- **Phase 5 — Sonnet contradiction engine + summarization:**
  - New keeper ops `contradict` and `summarize` (Anthropic SDK; Haiku pre-filter + Sonnet judge for contradictions; per-project daily/weekly/monthly summaries with `covers: [memory_ids]` provenance).
  - New `_system/proposals.jsonl` proposal queue gated by interactive `vault-mem-keeper review` CLI.
  - Soft monthly USD cap with audit logging (`_system/budget.jsonl`); default $5/month.
  - `keeper_run` audit summary now surfaces `pending_proposals` and `budget_mtd_usd`.
  - New audit op shapes: `contradict_scan`, `summarize`, `budget_exceeded`, `proposal_applied`, `proposal_rejected`.
  - First external API dependency: `anthropic>=0.40.0`. Set `ANTHROPIC_API_KEY` env var; without it, contradict + summarize gracefully skip.
```

- [ ] **Step 2: Add a `Roadmap` line to `README.md`** under "Status":

Replace the existing "What's next" line with:

```markdown
**What's next:** Phase 4 (Telegram approval gate as another transport for the proposal queue introduced in Phase 5) and Phase 6 (Polish: Dataview dashboards, optional Obsidian plugin) are on the roadmap.
```

- [ ] **Step 3: Full test sweep + smoke**

```bash
cd /Users/ashishdhiman/WORK/Frozo-projects/frozo-vault-mem
pnpm --filter @vault-mem/mcp test 2>&1 | grep "Tests" | head -1
pnpm --filter @vault-mem/mcp typecheck 2>&1 | tail -1
cd packages/keeper && uv run pytest --ignore=tests/test_e2e.py 2>&1 | grep -E "passed|failed" | tail -1
cd packages/keeper && uv run ruff check src tests 2>&1 | tail -1
```

Expected:
- TS: 107 passing, typecheck clean
- Keeper (excl e2e): all passing including new ones from Tasks 2–13
- Ruff clean

- [ ] **Step 4: Manual smoke (no API key — graceful skip path)**

```bash
TMP=$(mktemp -d)
node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault"
unset ANTHROPIC_API_KEY
cd packages/keeper && uv run python -m vault_mem_keeper run --vault "$TMP/vault"
cd packages/keeper && uv run python -m vault_mem_keeper review --vault "$TMP/vault" </dev/null
node packages/mcp/bin/vault-mem-mcp tail-audit --vault "$TMP/vault" -n 10
rm -rf "$TMP"
```

Expected:
- `keeper run` reports contradict and summarize as skipped (`disabled or missing API key`).
- `review` shows "0 pending proposals."
- Tail-audit shows `keeper_run` with `pending_proposals: 0` and `budget_mtd_usd: 0.0`.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: announce Phase 5 in CHANGELOG; refresh README roadmap"
```

---

## Self-review

**Spec coverage map** (every spec section maps to at least one task):

- §3.1 Where Phase 5 lives → Task 13 (runner)
- §3.2 New module layout → Tasks 2 (state), 3 (proposals), 4 (budget), 5 (client), 6 (prompts), 9 (contradict), 10 (summarize), 11 (review CLI), 12 (CLI dispatch)
- §3.3 New external dependency → Task 1
- §3.4 New vault files → Tasks 1, 2, 3, 4
- §3.5 New CLI → Tasks 11, 12
- §3.6 Cost ceiling → Task 4
- §4.1 Contradiction detection → Task 9
- §4.2 Summarization → Task 10
- §4.3 Cost tracking → Task 4
- §4.4 Belief decay tuning → not a feature; review-only (no task)
- §5 Proposal queue + review CLI → Tasks 3, 11
- §6 Configuration additions → Task 8
- §7 Audit format additions → Task 14 (TS), implicit in Tasks 9/10/11/13 (Python writes)
- §8 Storage → Tasks 1, 2, 3, 4
- §9 Error handling → exercised in Tasks 9, 10, 11 (try/except + budget short-circuit)
- §10 Testing → tests in every TDD task; e2e gated on real API key (skipped on CI)
- §11 Acceptance criteria → final smoke in Task 15

**Placeholder scan:** No "TBD/TODO/implement later" remains. Every code block contains the exact code an executor needs.

**Type consistency:** `Proposal`, `ProposalsHandle`, `BudgetTracker`, `AnthropicClient`, `LlmResponse`, `BudgetExceeded`, `JudgeResponse`, `ContradictReport`, `SummarizeReport`, `ReviewSession`, `ContradictConfig`, `SummarizeConfig`, `BudgetConfig` defined exactly once and reused with matching shapes throughout.
