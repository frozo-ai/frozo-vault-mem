import json
import sqlite3
from pathlib import Path

import lancedb
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.ops.link import run_link
from vault_mem_keeper.paths import vault_paths


EMBED_DIM = 384


def _seed_indexes(vault_root: str) -> None:
    """Seed FTS5 + Lance with 3 memories where the first two are similar."""
    paths = vault_paths(vault_root)

    # FTS5
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
    for suffix, title in [("aaaaaa", "alpha"), ("bbbbbb", "alpha-ish"), ("cccccc", "gamma")]:
        rows.append(
            (f"mem_2026-04-27_{suffix}", "decision", title, "body",
             json.dumps([]), None, "active", "memory",
             f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
             "2026-04-27T14:32:00.000Z"),
        )
    db.executemany(
        "INSERT INTO memories_fts (id,type,title,body,tags,project,status,location,path,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()

    # Lance
    lancedb_db = lancedb.connect(paths.lance_dir)
    lance_rows = []
    for i, suffix in enumerate(["aaaaaa", "bbbbbb", "cccccc"]):
        # Similar vectors for aaaaaa and bbbbbb (e.g., both biased toward dim 0)
        v = [0.0] * EMBED_DIM
        if suffix == "aaaaaa":
            v[0] = 1.0
        elif suffix == "bbbbbb":
            v[0] = 0.95
            v[1] = 0.05
        else:
            v[2] = 1.0
        lance_rows.append({
            "id": f"mem_2026-04-27_{suffix}",
            "vector": v,
            "type": "decision",
            "title": "alpha" if suffix in ("aaaaaa", "bbbbbb") else "gamma",
            "project": None,
            "tags": [],
            "status": "active",
            "location": "memory",
            "path": f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
            "updated": "2026-04-27T14:32:00.000Z",
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        })
    lancedb_db.create_table("memories", lance_rows)


def test_link_writes_links_jsonl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _seed_indexes(str(tmp_vault))
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    cfg = KeeperConfig()

    report = run_link(paths, cfg, schemas={}, audit=audit, dry_run=False, run_id="test")

    assert Path(paths.links_file).is_file()
    rows = [json.loads(line) for line in Path(paths.links_file).read_text().splitlines() if line.strip()]
    # aaaaaa and bbbbbb should be each other's neighbors
    aa_to = [r["to"] for r in rows if r["from"] == "mem_2026-04-27_aaaaaa"]
    bb_to = [r["to"] for r in rows if r["from"] == "mem_2026-04-27_bbbbbb"]
    assert "mem_2026-04-27_bbbbbb" in aa_to
    assert "mem_2026-04-27_aaaaaa" in bb_to
    assert report.from_count >= 1
    assert report.link_count >= 1


def test_dry_run_does_not_write_links_jsonl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _seed_indexes(str(tmp_vault))
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    cfg = KeeperConfig()

    run_link(paths, cfg, schemas={}, audit=audit, dry_run=True, run_id="test")

    assert not Path(paths.links_file).is_file()
