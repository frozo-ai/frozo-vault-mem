import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.fts import FtsReader


def _seed(db_path: str) -> None:
    """Create the FTS5 schema and seed three rows."""
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    rows = [
        ("mem_2026-04-27_aaaaaa", "decision", "Use Supabase", "supabase rls",
         json.dumps(["auth"]), "kincare", "active", "memory",
         "/v/memory/decisions/mem_2026-04-27_aaaaaa.md", "2026-04-27T14:32:00.000Z"),
        ("mem_2026-04-27_bbbbbb", "observation", "Pricing", "supabase free tier",
         json.dumps([]), "kincare", "active", "inbox",
         "/v/inbox/observations/mem_2026-04-27_bbbbbb.md", "2026-04-27T14:32:00.000Z"),
        ("mem_2026-04-27_cccccc", "decision", "Other choice", "ops",
         json.dumps([]), "frozo", "archived", "archive",
         "/v/archive/mem_2026-04-27_cccccc.md", "2026-04-27T14:32:00.000Z"),
    ]
    insert_sql = (
        "INSERT INTO memories_fts"
        " (id,type,title,body,tags,project,status,location,path,updated)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    db.executemany(insert_sql, rows)
    db.commit()
    db.close()


def test_list_returns_all_filter_matched_rows():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "index.sqlite"))
        _seed(db_path)
        r = FtsReader(db_path)
        try:
            assert len(r.list({})) == 3
            assert len(r.list({"type": "decision"})) == 2
            assert len(r.list({"project": "kincare"})) == 2
            assert len(r.list({"location": "memory"})) == 1
            assert len(r.list({"location": "memory", "project": "kincare"})) == 1
            assert len(r.list({"status": "archived"})) == 1
        finally:
            r.close()


def test_list_returns_parsed_tags():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "index.sqlite"))
        _seed(db_path)
        r = FtsReader(db_path)
        try:
            rows = r.list({"id": "mem_2026-04-27_aaaaaa"})
            # `id` filter not in API; filter manually
            rows = [x for x in r.list({}) if x["id"] == "mem_2026-04-27_aaaaaa"]
            assert rows[0]["tags"] == ["auth"]
        finally:
            r.close()


def test_handles_missing_index_file():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "missing.sqlite"))
        r = FtsReader(db_path)
        # SQLite's read-only "file:" URI fails on open if file missing — should raise.
        try:
            with pytest.raises(sqlite3.OperationalError):
                r.list({})
        finally:
            r.close()
