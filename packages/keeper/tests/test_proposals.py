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
