"""Review CLI handling of the subject_erase_request kind (DPDP Phase 3).

Simulates the wire flow: TS MCP tool writes a subject_erase_request
proposal → Python review CLI walks pending proposals → operator types
'a' to approve → run_erase_subject fires.
"""

import json
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path

import frontmatter

from vault_mem_keeper.cli.review import cmd_review
from vault_mem_keeper.ops.reindex_subjects import run_reindex_subjects
from vault_mem_keeper.paths import vault_paths


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _write_memory(vault_root: Path, mid: str, *,
                  type_: str = "entity",
                  entity_kind: str | None = "person",
                  tags: list[str] | None = None) -> None:
    paths = vault_paths(str(vault_root))
    path = Path(paths.memory_file(type_, mid, "memory"))
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = {
        "id": mid, "type": type_, "title": f"T {mid}",
        "agent": "human", "session": None,
        "created": _now_iso(), "updated": _now_iso(),
        "confidence": 0.8, "sources": [], "contradicts": [],
        "supersedes": [], "tags": tags or [], "project": None,
        "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    if entity_kind is not None:
        fm["entity_kind"] = entity_kind
    Path(path).write_text(frontmatter.dumps(frontmatter.Post("body", **fm)))


def _write_proposal(vault_root: Path, **fields) -> str:
    """Write a record to proposals.jsonl mimicking what the TS MCP tool emits."""
    paths = vault_paths(str(vault_root))
    Path(paths.proposals_file).parent.mkdir(parents=True, exist_ok=True)
    record = {
        "kind": "subject_erase_request",
        "subject_id": "email:test@example.com",
        "reason": "DPDP SAR #1",
        "requested_by_agent": "claude-code",
        "source_id": "", "target_id": "", "severity": "high",
        "reasoning": "", "suggested_action": "run_erase_subject",
        "model": "", "cost_usd": 0.0, "run_id": "",
        "source_updated": "", "target_updated": "",
        "v": 1, "id": "P-2026-05-19_abc123",
        "status": "pending", "created_at": _now_iso(),
        **fields,
    }
    with open(paths.proposals_file, "a") as f:
        f.write(json.dumps(record) + "\n")
    return record["id"]


def test_review_approves_subject_erase_and_fires_cascade(tmp_vault: Path) -> None:
    """Approving a subject_erase_request runs the cascade end-to-end."""
    paths = vault_paths(str(tmp_vault))

    # Memory that should be full_deleted: entity person tagged with the subject.
    _write_memory(tmp_vault, "mem_a", type_="entity", entity_kind="person",
                  tags=["email:test@example.com"])
    run_reindex_subjects(paths)

    # MCP-tool-emitted proposal lands in proposals.jsonl
    proposal_id = _write_proposal(tmp_vault)

    out = StringIO()
    # Sequence: 'a' (accept) for the only proposal, then EOF closes the loop.
    inputs = iter(["a"])
    exit_code = cmd_review(
        str(tmp_vault),
        input_fn=lambda _prompt: next(inputs),
        out=out,
    )
    assert exit_code == 0

    output = out.getvalue()
    assert "subject_erase_request" in output
    assert "email:test@example.com" in output  # subject shown to operator
    assert "applied" in output

    # Cascade actually fired: original memory gone, stub at archive/erased/
    assert not Path(paths.memory_file("entity", "mem_a", "memory")).exists()
    assert Path(tmp_vault, "archive", "erased", "mem_a.md").exists()

    # Proposal status flipped to applied
    records = [
        json.loads(line)
        for line in Path(paths.proposals_file).read_text().splitlines()
        if line.strip()
    ]
    by_id = {r["id"]: r for r in records}
    assert by_id[proposal_id]["status"] == "applied"

    # Audit log has the cascade + the proposal_applied marker
    audit_lines = [
        json.loads(line)
        for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    op_names = [e.get("op") for e in audit_lines]
    assert "subject_erased" in op_names
    assert "subject_erased_complete" in op_names
    assert "proposal_applied" in op_names


def test_review_rejects_subject_erase_leaves_vault_untouched(tmp_vault: Path) -> None:
    paths = vault_paths(str(tmp_vault))
    _write_memory(tmp_vault, "mem_a", type_="entity", entity_kind="person",
                  tags=["email:keep@x.com"])
    run_reindex_subjects(paths)
    proposal_id = _write_proposal(tmp_vault, subject_id="email:keep@x.com")

    out = StringIO()
    inputs = iter(["r"])
    exit_code = cmd_review(
        str(tmp_vault),
        input_fn=lambda _prompt: next(inputs),
        out=out,
    )
    assert exit_code == 0

    # Memory still in place; no stub.
    assert Path(paths.memory_file("entity", "mem_a", "memory")).exists()
    assert not Path(tmp_vault, "archive", "erased", "mem_a.md").exists()

    # Proposal status = rejected
    records = [
        json.loads(line)
        for line in Path(paths.proposals_file).read_text().splitlines()
        if line.strip()
    ]
    by_id = {r["id"]: r for r in records}
    assert by_id[proposal_id]["status"] == "rejected"


def test_review_filter_subject_erase_request_only(tmp_vault: Path) -> None:
    """When --filter subject_erase_request is set, contradict proposals
    are hidden."""
    paths = vault_paths(str(tmp_vault))
    # Plant a contradict proposal too (mimics keeper output)
    Path(paths.proposals_file).parent.mkdir(parents=True, exist_ok=True)
    contradict = {
        "kind": "contradict",
        "source_id": "mem_x", "target_id": "mem_y",
        "severity": "high", "reasoning": "x vs y",
        "suggested_action": "merge", "model": "haiku",
        "cost_usd": 0.001, "run_id": "r1",
        "source_updated": _now_iso(), "target_updated": _now_iso(),
        "v": 1, "id": "P-2026-05-19_aaa111",
        "status": "pending", "created_at": _now_iso(),
    }
    erase = {
        "kind": "subject_erase_request",
        "subject_id": "email:filtered@x.com",
        "reason": "test",
        "requested_by_agent": "x",
        "source_id": "", "target_id": "", "severity": "high",
        "reasoning": "", "suggested_action": "run_erase_subject",
        "model": "", "cost_usd": 0, "run_id": "",
        "source_updated": "", "target_updated": "",
        "v": 1, "id": "P-2026-05-19_bbb222",
        "status": "pending", "created_at": _now_iso(),
    }
    with open(paths.proposals_file, "w") as f:
        f.write(json.dumps(contradict) + "\n")
        f.write(json.dumps(erase) + "\n")

    out = StringIO()
    # Skip the one proposal we see; we just want to verify the filter
    # excludes the contradict.
    inputs = iter(["s"])
    cmd_review(
        str(tmp_vault),
        filter_kind="subject_erase_request",
        input_fn=lambda _prompt: next(inputs),
        out=out,
    )
    output = out.getvalue()
    assert "1 pending proposal" in output  # only the erase shows
    assert "email:filtered@x.com" in output
    assert "mem_x" not in output  # contradict was filtered out
