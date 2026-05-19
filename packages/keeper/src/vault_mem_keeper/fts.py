"""SQLite queries against the MCP server's FTS5 index.

The keeper is read-only by default (FtsReader), but `delete_by_ids()`
is provided as a module-level escape hatch for the DPDP erasure
cascade (spec §4) which needs to atomically drop FTS rows for memories
it just archived. The MCP server's chokidar watcher would eventually
do the same on its own — the cascade calls it explicitly so the
verifier can pass immediately rather than after the next watch tick."""

import json
import sqlite3
from pathlib import Path
from typing import Any


def _parse_tags(v: Any) -> list[str]:
    if not v:
        return []
    try:
        parsed = json.loads(str(v))
        return [str(x) for x in parsed] if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


class FtsReader:
    def __init__(self, index_path: str) -> None:
        self._index_path = index_path
        # Lazy-open: we only connect when first query runs (lets tests probe missing files cleanly).
        self._db: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        if self._db is None:
            uri = f"file:{self._index_path}?mode=ro"
            self._db = sqlite3.connect(uri, uri=True)
            self._db.row_factory = sqlite3.Row
        return self._db

    def list(self, filter_: dict[str, Any]) -> list[dict[str, Any]]:
        """Filter-only enumeration — no FTS5 MATCH. Mirrors TS IndexHandle.list."""
        clauses: list[str] = []
        params: list[Any] = []
        if "type" in filter_:
            t = filter_["type"]
            if isinstance(t, list):
                clauses.append(f"type IN ({','.join(['?']*len(t))})")
                params.extend(t)
            else:
                clauses.append("type = ?")
                params.append(t)
        if "project" in filter_:
            clauses.append("project = ?")
            params.append(filter_["project"])
        if "status" in filter_:
            clauses.append("status = ?")
            params.append(filter_["status"])
        if "location" in filter_ and filter_["location"] != "any":
            clauses.append("location = ?")
            params.append(filter_["location"])

        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"""
            SELECT id, type, title, body, tags, project, status, location, path, updated
            FROM memories_fts {where_sql}
        """
        cur = self._connect().execute(sql, params)
        return [
            {
                "id": r["id"],
                "type": r["type"],
                "title": r["title"],
                "body": r["body"],
                "tags": _parse_tags(r["tags"]),
                "project": r["project"],
                "status": r["status"],
                "location": r["location"],
                "path": r["path"],
                "updated": r["updated"],
            }
            for r in cur.fetchall()
        ]

    def count(self) -> int:
        cur = self._connect().execute("SELECT COUNT(*) AS n FROM memories_fts")
        return int(cur.fetchone()["n"])

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None


# ---------------------------------------------------------------------------
# Write helpers (DPDP erasure cascade only).
# ---------------------------------------------------------------------------


def delete_by_ids(index_path: str, ids: list[str]) -> int:
    """Remove rows from `memories_fts` matching `ids`. Returns the
    number of rows actually deleted.

    Opens the FTS sqlite in r/w mode briefly, then closes. Safe to
    call concurrently with the MCP server (SQLite WAL + busy_timeout
    handles short contention).

    If the FTS db file doesn't exist (fresh vault, never indexed),
    this is a no-op returning 0.
    """
    if not ids:
        return 0
    if not Path(index_path).exists():
        return 0
    db = sqlite3.connect(index_path)
    try:
        db.execute("PRAGMA busy_timeout = 5000")
        cur = db.executemany(
            "DELETE FROM memories_fts WHERE id = ?",
            [(i,) for i in ids],
        )
        db.commit()
        return cur.rowcount or 0
    finally:
        db.close()


def count_for_ids(index_path: str, ids: list[str]) -> int:
    """How many rows in `memories_fts` match `ids`. Used by the
    audit-subject verifier to check for drift after erase."""
    if not ids:
        return 0
    if not Path(index_path).exists():
        return 0
    db = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    try:
        placeholders = ",".join(["?"] * len(ids))
        cur = db.execute(
            f"SELECT COUNT(*) FROM memories_fts WHERE id IN ({placeholders})",
            ids,
        )
        return int(cur.fetchone()[0])
    finally:
        db.close()
