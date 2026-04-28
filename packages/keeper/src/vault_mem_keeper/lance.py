"""Read-only LanceDB queries.

The keeper does not write to Lance; the MCP server's watcher reconciles
the index after keeper-induced file changes."""

from collections.abc import Iterable
from typing import Any

import lancedb

TABLE_NAME = "memories"


def _escape(s: str) -> str:
    return s.replace("'", "''")


def _build_where(filter_: dict[str, Any]) -> str | None:
    parts: list[str] = []
    if "type" in filter_:
        t = filter_["type"]
        if isinstance(t, list):
            parts.append("type IN (" + ", ".join(f"'{_escape(x)}'" for x in t) + ")")
        else:
            parts.append(f"type = '{_escape(t)}'")
    if "project" in filter_ and filter_["project"]:
        parts.append(f"project = '{_escape(filter_['project'])}'")
    if "status" in filter_ and filter_["status"]:
        parts.append(f"status = '{_escape(filter_['status'])}'")
    if "location" in filter_ and filter_["location"] and filter_["location"] != "any":
        parts.append(f"location = '{_escape(filter_['location'])}'")
    return " AND ".join(parts) if parts else None


def _row_to_dict(r: Any) -> dict[str, Any]:
    return {
        "id": str(r["id"]),
        "vector": list(r["vector"]),
        "type": str(r["type"]),
        "title": str(r["title"]),
        "project": str(r["project"]) if r["project"] is not None else None,
        "tags": [str(x) for x in (r["tags"] or [])],
        "status": str(r["status"]),
        "location": str(r["location"]),
        "path": str(r["path"]),
        "updated": str(r["updated"]),
        "schema_version": str(r.get("schema_version", "0.1")),
        "embed_model": str(r.get("embed_model", "")),
    }


class LanceReader:
    def __init__(self, dir_path: str) -> None:
        self._db = lancedb.connect(dir_path)
        self._table = self._db.open_table(TABLE_NAME)

    def get_by_id(self, mid: str) -> dict[str, Any] | None:
        rows = self._table.search().where(f"id = '{_escape(mid)}'").limit(1).to_list()
        return _row_to_dict(rows[0]) if rows else None

    def search(
        self,
        qvec: list[float] | Iterable[float],
        filter_: dict[str, Any],
        limit: int,
    ) -> list[dict[str, Any]]:
        query = self._table.search(list(qvec)).limit(limit)
        where = _build_where(filter_)
        if where:
            query = query.where(where)
        rows = query.to_list()
        return [_row_to_dict(r) for r in rows]

    def count(self) -> int:
        return self._table.count_rows()

    def close(self) -> None:
        # LanceDB has no explicit close; GC handles it. No-op for symmetry.
        pass
