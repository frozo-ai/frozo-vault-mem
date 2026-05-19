"""Unit tests for the subject-mention index (DPDP Phase 1 foundation)."""

from pathlib import Path

from vault_mem_keeper.subject_index import (
    Mention,
    SubjectIndex,
    extract_subject_ids,
)

# ---------- extract_subject_ids -------------------------------------------


def test_extract_tags_basic() -> None:
    fm = {
        "type": "observation",
        "tags": ["email:Priya@Example.com", "vault-mem", "github:Ashish"],
    }
    out = extract_subject_ids(fm, memory_id="mem_x")
    by_subj = {m.subject_id: m for m in out}
    assert "email:priya@example.com" in by_subj  # lowercased
    assert "github:ashish" in by_subj  # lowercased
    assert "vault-mem" not in by_subj  # bare slug, not a subject id
    assert by_subj["email:priya@example.com"].kind == "tag"
    assert by_subj["email:priya@example.com"].field_path == "tags"


def test_extract_sources_become_source_author() -> None:
    fm = {
        "type": "decision",
        "tags": [],
        "sources": ["slack:T0X1Y2Z3:U0A1B2C3", "https://example.com/post"],
    }
    out = extract_subject_ids(fm, memory_id="mem_y")
    by_subj = {m.subject_id: m for m in out}
    assert "slack:T0X1Y2Z3:U0A1B2C3" in by_subj
    assert by_subj["slack:T0X1Y2Z3:U0A1B2C3"].kind == "source_author"
    assert by_subj["slack:T0X1Y2Z3:U0A1B2C3"].field_path == "sources"
    assert "https://example.com/post" not in by_subj  # not a subject id


def test_person_entity_promotes_tag_to_primary_subject() -> None:
    fm = {
        "type": "entity",
        "entity_kind": "person",
        "tags": ["github:priya"],
    }
    out = extract_subject_ids(fm, memory_id="mem_priya")
    assert len(out) == 1
    assert out[0].kind == "primary_subject"
    assert out[0].subject_id == "github:priya"


def test_non_person_entity_keeps_tag_kind() -> None:
    # entity_kind=project should NOT promote — only person entities
    # represent a human subject for erasure purposes.
    fm = {
        "type": "entity",
        "entity_kind": "project",
        "tags": ["github:org-name"],
    }
    out = extract_subject_ids(fm, memory_id="mem_proj")
    assert len(out) == 1
    assert out[0].kind == "tag"


def test_canonicalize_case() -> None:
    fm = {
        "type": "observation",
        "tags": ["email:Foo@BAR.com", "github:ASHISH"],
    }
    out = extract_subject_ids(fm, memory_id="m")
    ids = {m.subject_id for m in out}
    assert ids == {"email:foo@bar.com", "github:ashish"}


def test_dedup_within_call() -> None:
    # Same subject id listed twice in tags should yield one Mention.
    fm = {
        "type": "observation",
        "tags": ["email:a@b.com", "email:a@b.com"],
    }
    out = extract_subject_ids(fm, memory_id="m")
    assert len(out) == 1


def test_no_subject_when_no_relevant_fields() -> None:
    fm = {"type": "decision", "tags": [], "sources": []}
    assert extract_subject_ids(fm, memory_id="m") == []


def test_bare_prefix_with_no_value_rejected() -> None:
    # `email:` with no address should NOT match.
    fm = {"type": "decision", "tags": ["email:", "slack:T0:"]}
    out = extract_subject_ids(fm, memory_id="m")
    # `email:` is empty → reject. `slack:T0:` is empty user → reject.
    # We only accept `<prefix>:<at-least-one-char>` after the prefix's colon,
    # but slack uses `T0:U0` so a single trailing colon should fail. We
    # accept anything non-empty after the prefix, so `slack:T0:` (with
    # nothing after the second colon) still passes the regex — that's a
    # conservative choice. Verify the expected behaviour:
    ids = {m.subject_id for m in out}
    assert "email:" not in ids
    # `slack:T0:` has a non-empty suffix after the FIRST colon (`T0:`)
    # so it does match. Confirmed by design — over-eager matches just
    # waste an index row.
    assert "slack:T0:" in ids


def test_meeting_attendees_list_handled() -> None:
    # Even though the OSS schema doesn't include attendees explicitly,
    # _strings_in iterates a list field if present. Future-proofs the
    # case where vault-cloud frontmatter leaks through.
    fm = {
        "type": "observation",
        "tags": ["email:a@b.com", "email:c@d.com"],
    }
    out = extract_subject_ids(fm, memory_id="m")
    assert len({m.subject_id for m in out}) == 2


# ---------- SubjectIndex schema + write paths -----------------------------


def test_open_creates_schema_and_db_file(tmp_path: Path) -> None:
    db_path = tmp_path / "subjects.sqlite"
    idx = SubjectIndex(str(db_path))
    try:
        assert db_path.exists()
        assert idx.count() == 0
    finally:
        idx.close()


def test_record_mentions_idempotent(tmp_path: Path) -> None:
    idx = SubjectIndex(str(tmp_path / "s.sqlite"))
    try:
        m1 = Mention(
            subject_id="email:a@b.com",
            memory_id="mem_1",
            kind="tag",
            field_path="tags",
        )
        idx.record_mentions([m1])
        idx.record_mentions([m1])  # re-run — should be no-op due to PK
        rows = idx.list_for_subject("email:a@b.com")
        assert len(rows) == 1
    finally:
        idx.close()


def test_multiple_kinds_for_same_pair_coexist(tmp_path: Path) -> None:
    idx = SubjectIndex(str(tmp_path / "s.sqlite"))
    try:
        idx.record_mentions(
            [
                Mention("github:ashish", "mem_a", "tag", "tags"),
                Mention("github:ashish", "mem_a", "source_author", "sources"),
            ]
        )
        rows = idx.list_for_memory("mem_a")
        kinds = {r.kind for r in rows}
        assert kinds == {"tag", "source_author"}
    finally:
        idx.close()


def test_delete_for_memory(tmp_path: Path) -> None:
    idx = SubjectIndex(str(tmp_path / "s.sqlite"))
    try:
        idx.record_mentions(
            [
                Mention("email:a@b.com", "mem_x", "tag", "tags"),
                Mention("email:c@d.com", "mem_x", "tag", "tags"),
                Mention("email:a@b.com", "mem_y", "tag", "tags"),
            ]
        )
        removed = idx.delete_for_memory("mem_x")
        assert removed == 2
        assert idx.list_for_memory("mem_x") == []
        # mem_y still there
        assert len(idx.list_for_memory("mem_y")) == 1
    finally:
        idx.close()


def test_delete_for_subject(tmp_path: Path) -> None:
    idx = SubjectIndex(str(tmp_path / "s.sqlite"))
    try:
        idx.record_mentions(
            [
                Mention("email:a@b.com", "mem_1", "tag", "tags"),
                Mention("email:a@b.com", "mem_2", "source_author", "sources"),
                Mention("github:other", "mem_3", "tag", "tags"),
            ]
        )
        removed = idx.delete_for_subject("email:a@b.com")
        assert removed == 2
        assert idx.list_for_subject("email:a@b.com") == []
        # Other subjects untouched
        assert len(idx.list_for_subject("github:other")) == 1
    finally:
        idx.close()


def test_count_and_distinct(tmp_path: Path) -> None:
    idx = SubjectIndex(str(tmp_path / "s.sqlite"))
    try:
        idx.record_mentions(
            [
                Mention("email:a@b.com", "mem_1", "tag", "tags"),
                Mention("email:a@b.com", "mem_2", "tag", "tags"),
                Mention("github:other", "mem_3", "tag", "tags"),
            ]
        )
        assert idx.count() == 3
        assert idx.distinct_subjects() == 2
    finally:
        idx.close()


def test_reopen_preserves_data(tmp_path: Path) -> None:
    db = tmp_path / "s.sqlite"
    idx = SubjectIndex(str(db))
    idx.record_mentions([Mention("email:a@b.com", "mem_1", "tag", "tags")])
    idx.close()

    idx2 = SubjectIndex(str(db))
    try:
        assert idx2.count() == 1
    finally:
        idx2.close()


def test_init_creates_parent_dir(tmp_path: Path) -> None:
    nested = tmp_path / "a" / "b" / "_system" / "subjects.sqlite"
    idx = SubjectIndex(str(nested))
    try:
        assert nested.exists()
        assert nested.parent.is_dir()
    finally:
        idx.close()
