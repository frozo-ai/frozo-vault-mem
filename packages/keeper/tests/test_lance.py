import tempfile

import lancedb

from vault_mem_keeper.lance import LanceReader

EMBED_DIM = 384


def _seed_lance(dir_path: str) -> None:
    """Seed a Lance table with 3 rows mirroring the TS schema."""
    db = lancedb.connect(dir_path)
    rows = [
        {
            "id": f"mem_2026-04-27_{suffix}",
            "vector": [0.05] * EMBED_DIM,
            "type": "decision",
            "title": title,
            "project": "myapp",
            "tags": ["auth"],
            "status": "active",
            "location": "memory",
            "path": f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
            "updated": "2026-04-27T14:32:00.000Z",
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        }
        for suffix, title in [
            ("aaaaaa", "alpha"),
            ("bbbbbb", "beta"),
            ("cccccc", "gamma"),
        ]
    ]
    # Vary one vector so search has a clear winner
    rows[0]["vector"] = [0.5] + [0.0] * (EMBED_DIM - 1)
    rows[1]["vector"] = [0.0, 0.5] + [0.0] * (EMBED_DIM - 2)
    rows[2]["vector"] = [0.0, 0.0, 0.5] + [0.0] * (EMBED_DIM - 3)
    db.create_table("memories", rows)


def test_get_by_id_returns_row_with_vector():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        row = r.get_by_id("mem_2026-04-27_aaaaaa")
        assert row is not None
        assert row["title"] == "alpha"
        assert len(row["vector"]) == EMBED_DIM


def test_search_returns_nearest_first():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        # Query vector matching row aaaaaa exactly
        qvec = [0.5] + [0.0] * (EMBED_DIM - 1)
        out = r.search(qvec, filter_={}, limit=3)
        assert out[0]["id"] == "mem_2026-04-27_aaaaaa"


def test_search_filter_by_status():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        qvec = [0.0] * EMBED_DIM
        out = r.search(qvec, filter_={"status": "active"}, limit=10)
        assert len(out) == 3
        out2 = r.search(qvec, filter_={"status": "archived"}, limit=10)
        assert len(out2) == 0


def test_count_returns_row_count():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        assert r.count() == 3
