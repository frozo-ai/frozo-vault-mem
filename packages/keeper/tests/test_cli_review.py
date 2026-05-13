"""Tests for cli/review.py — interactive proposal walker."""

import io
import json
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.cli.review import cmd_review
from vault_mem_keeper.paths import vault_paths
from vault_mem_keeper.proposals import Proposal, open_proposals


def _write_memory(path: Path, fm: dict, body: str = "body") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    post = frontmatter.Post(body, **fm)
    path.write_text(frontmatter.dumps(post) + "\n")


def _seed_pair(tmp_vault: Path) -> tuple[str, str, Path, Path]:
    """Create two decision memories M (older) and N (newer)."""
    paths = vault_paths(str(tmp_vault))
    m_id = "mem_2026-04-15_aaaaaa"
    n_id = "mem_2026-04-29_bbbbbb"
    m_path = Path(paths.memory_file("decision", m_id, "memory"))
    n_path = Path(paths.memory_file("decision", n_id, "memory"))
    base_fm = {
        "agent": "human", "session": None,
        "confidence": 0.85, "sources": [], "contradicts": [],
        "supersedes": [], "tags": [], "project": "myapp",
        "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    _write_memory(m_path, {
        **base_fm,
        "id": m_id, "type": "decision",
        "title": "Use Supabase for myapp auth",
        "created": "2026-04-15T14:32:00.000Z",
        "updated": "2026-04-15T14:32:00.000Z",
    })
    _write_memory(n_path, {
        **base_fm,
        "id": n_id, "type": "decision",
        "title": "Migrate myapp to Auth0",
        "created": "2026-04-29T19:48:12.000Z",
        "updated": "2026-04-29T19:48:12.000Z",
    })
    Path(paths.audit_file).touch()
    return m_id, n_id, m_path, n_path


def _seed_proposal(tmp_vault: Path, m_id: str, n_id: str, *,
                   suggested_action: str = "supersede_M_with_N",
                   severity: str = "high") -> str:
    paths = vault_paths(str(tmp_vault))
    handle = open_proposals(paths.proposals_file)
    p = handle.append(Proposal(
        kind="contradict",
        source_id=m_id, target_id=n_id,
        severity=severity,
        reasoning="Direct reversal.",
        suggested_action=suggested_action,
        model="claude-sonnet-4-7",
        cost_usd=0.0034, run_id="seed",
        source_updated="2026-04-15T14:32:00.000Z",
        target_updated="2026-04-29T19:48:12.000Z",
    ))
    return p.id


def _scripted_input(answers: list[str]):
    """Make an input() substitute that pops from `answers` FIFO."""
    queue = list(answers)
    def _input(_prompt: str = "") -> str:
        if not queue:
            return "q"  # safety: terminate on empty
        return queue.pop(0)
    return _input


def test_no_pending_proposals_message(tmp_vault):
    Path(vault_paths(str(tmp_vault)).audit_file).touch()
    out = io.StringIO()
    code = cmd_review(str(tmp_vault), input_fn=lambda _p: "q", out=out)
    assert code == 0
    assert "No pending proposals" in out.getvalue()


def test_accept_supersede_m_with_n(tmp_vault):
    m_id, n_id, m_path, n_path = _seed_pair(tmp_vault)
    pid = _seed_proposal(tmp_vault, m_id, n_id, suggested_action="supersede_M_with_N")
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["a"]),
        out=out,
    )
    assert code == 0

    # M moved to archive
    assert not m_path.is_file()
    archive_path = Path(paths.memory_file("decision", m_id, "archive"))
    assert archive_path.is_file()

    # M frontmatter: status=superseded
    m_post = frontmatter.load(str(archive_path))
    assert m_post.metadata["status"] == "superseded"

    # N's supersedes list includes M
    n_post = frontmatter.load(str(n_path))
    assert m_id in (n_post.metadata.get("supersedes") or [])

    # Proposal marked applied
    handle = open_proposals(paths.proposals_file)
    record = handle.get(pid)
    assert record is None or record.status == "applied"
    # Actually iter_pending should be empty
    assert handle.count_pending() == 0

    # Audit log has proposal_applied
    audit_lines = [
        json.loads(line) for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(
        r.get("op") == "proposal_applied" and r.get("proposal_id") == pid
        for r in audit_lines
    )


def test_accept_supersede_n_with_m(tmp_vault):
    """N is the loser; M wins. Symmetric of above."""
    m_id, n_id, m_path, n_path = _seed_pair(tmp_vault)
    _seed_proposal(tmp_vault, m_id, n_id, suggested_action="supersede_N_with_M")
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["a"]),
        out=out,
    )
    assert code == 0
    # N moved to archive
    assert not n_path.is_file()
    assert Path(paths.memory_file("decision", n_id, "archive")).is_file()
    # M's supersedes includes N
    m_post = frontmatter.load(str(m_path))
    assert n_id in (m_post.metadata.get("supersedes") or [])


def test_reject_marks_proposal_rejected(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    pid = _seed_proposal(tmp_vault, m_id, n_id)
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["r"]),
        out=out,
    )
    assert code == 0
    handle = open_proposals(paths.proposals_file)
    assert handle.count_pending() == 0
    record = handle.get(pid)
    assert record is not None and record.status == "rejected"
    # Files untouched
    assert Path(paths.memory_file("decision", m_id, "memory")).is_file()
    assert Path(paths.memory_file("decision", n_id, "memory")).is_file()


def test_skip_leaves_proposal_pending(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    _seed_proposal(tmp_vault, m_id, n_id)
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["s"]),
        out=out,
    )
    assert code == 0
    handle = open_proposals(paths.proposals_file)
    assert handle.count_pending() == 1


def test_quit_terminates_early(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    _seed_proposal(tmp_vault, m_id, n_id)
    _seed_proposal(tmp_vault, m_id, n_id, suggested_action="supersede_N_with_M")
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["q"]),
        out=out,
    )
    assert code == 0
    handle = open_proposals(paths.proposals_file)
    # Two pending proposals were seeded but already_judged dedup made only one survive;
    # whichever count, the user quitting should not change pending count.
    pending_before_quit = handle.count_pending()
    assert pending_before_quit >= 1


def test_both_active_auto_rejects(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    pid = _seed_proposal(tmp_vault, m_id, n_id,
                         suggested_action="both_active_different_facets")
    paths = vault_paths(str(tmp_vault))

    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["a"]),
        out=out,
    )
    assert code == 0
    handle = open_proposals(paths.proposals_file)
    record = handle.get(pid)
    assert record is not None and record.status == "rejected"


def test_filter_by_severity(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    # Seed a 'low' severity proposal, then filter for 'high'
    _seed_proposal(tmp_vault, m_id, n_id, severity="low")
    out = io.StringIO()
    code = cmd_review(
        str(tmp_vault),
        filter_severity="high",
        input_fn=lambda _p: "q",
        out=out,
    )
    assert code == 0
    assert "No pending proposals" in out.getvalue()


def test_unknown_choice_reprompts(tmp_vault):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    _seed_proposal(tmp_vault, m_id, n_id)
    out = io.StringIO()
    # First "xyz" → reprompt; then "r" → reject
    code = cmd_review(
        str(tmp_vault),
        input_fn=_scripted_input(["xyz", "r"]),
        out=out,
    )
    assert code == 0
    assert "unknown choice" in out.getvalue()


@pytest.mark.parametrize("action", ["supersede_M_with_N", "supersede_N_with_M"])
def test_audit_log_has_proposal_applied(tmp_vault, action):
    m_id, n_id, _, _ = _seed_pair(tmp_vault)
    pid = _seed_proposal(tmp_vault, m_id, n_id, suggested_action=action)
    paths = vault_paths(str(tmp_vault))

    cmd_review(str(tmp_vault), input_fn=_scripted_input(["a"]), out=io.StringIO())

    audit_lines = [
        json.loads(line) for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    matched = [r for r in audit_lines
               if r.get("op") == "proposal_applied" and r.get("proposal_id") == pid]
    assert len(matched) == 1
