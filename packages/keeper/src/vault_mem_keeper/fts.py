"""Read-only SQLite queries against the MCP server's FTS5 index.

The keeper never writes to this index; the MCP server's chokidar watcher
reconciles it after keeper-induced file changes."""

import json
import sqlite3
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
