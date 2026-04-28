"""JSONL audit log writer. Matches TS Auditor shape exactly so tail-audit
displays keeper writes alongside MCP server writes."""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any


def _hash_query(q: str) -> str:
    return "sha256:" + hashlib.sha256(q.encode("utf-8")).hexdigest()


class Auditor:
    def __init__(self, log_path: str) -> None:
        self.log_path = log_path

    def write(self, entry: dict[str, Any]) -> None:
        record: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "v": 1,
        }
        # For search and context ops with `query`, replace with query_hash.
        op = entry.get("op")
        if op in ("search", "context") and "query" in entry:
            payload = {k: v for k, v in entry.items() if k != "query"}
            payload["query_hash"] = _hash_query(entry["query"])
            record.update(payload)
        else:
            record.update(entry)

        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
