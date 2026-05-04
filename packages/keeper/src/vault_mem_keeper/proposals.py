"""Append-only JSONL store for keeper-emitted proposals.

Idempotency uses an order-normalized pair key so that re-judging the
same memory pair (regardless of which side is "source") is detected.
A pair is re-evaluated if EITHER memory's updated timestamp has
advanced since the proposal was stored."""

import json
import secrets
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from .atomic_write import atomic_write


def pair_dedup_key(
    source_id: str, target_id: str,
    source_updated: str, target_updated: str,
) -> tuple[str, str, str]:
    """Normalize pair so (A,B) and (B,A) hash identically."""
    a, b = sorted([source_id, target_id])
    newer = max(source_updated, target_updated)
    return (a, b, newer)


@dataclass
class Proposal:
    kind: str                       # "contradict" (more in future)
    source_id: str
    target_id: str
    severity: str                   # "low" | "medium" | "high"
    reasoning: str
    suggested_action: str
    model: str
    cost_usd: float
    run_id: str
    source_updated: str
    target_updated: str
    # filled by ProposalsHandle.append:
    v: int = 1
    id: str = ""
    status: str = "pending"
    created_at: str = ""


def _new_proposal_id() -> str:
    today = datetime.now(UTC).date().isoformat()
    suffix = secrets.token_hex(3)
    return f"P-{today}_{suffix}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class ProposalsHandle:
    def __init__(self, path: str) -> None:
        self._path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if not Path(path).is_file():
            Path(path).write_text("")
        self._records: list[dict] = []
        self._load()

    def _load(self) -> None:
        self._records = []
        for line in Path(self._path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                self._records.append(json.loads(line))

    def append(self, p: Proposal) -> Proposal:
        if not p.id:
            p.id = _new_proposal_id()
        if not p.created_at:
            p.created_at = _now_iso()
        record = asdict(p)
        # Append to disk
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._records.append(record)
        return p

    def already_judged(
        self, source_id: str, target_id: str,
        source_updated: str, target_updated: str,
    ) -> bool:
        # Normalize the new request's pair
        req_a, req_b = sorted([source_id, target_id])
        # Map id→timestamp for the request
        req_ts: dict[str, str] = {source_id: source_updated, target_id: target_updated}
        for r in self._records:
            r_a, r_b = sorted([r["source_id"], r["target_id"]])
            if (r_a, r_b) != (req_a, req_b):
                continue
            # Same pair: check that NEITHER side has a newer timestamp in the request.
            # Map id→timestamp for the stored record
            r_ts: dict[str, str] = {r["source_id"]: r["source_updated"], r["target_id"]: r["target_updated"]}  # noqa: E501
            # For each id in the pair, the stored ts must be >= the request ts
            pair_ids = [req_a, req_b]
            all_covered = all(r_ts.get(pid, "") >= req_ts.get(pid, "") for pid in pair_ids)
            if all_covered:
                return True
        return False

    def set_status(self, proposal_id: str, status: str) -> None:
        for r in self._records:
            if r["id"] == proposal_id:
                r["status"] = status
                break
        # Rewrite full file atomically
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in self._records)
        atomic_write(self._path, body + ("\n" if body else ""))

    def iter_pending(self) -> Iterator[Proposal]:
        for r in self._records:
            if r.get("status") == "pending":
                fields = {k: v for k, v in r.items() if k in Proposal.__dataclass_fields__}
                yield Proposal(**fields)

    def get(self, proposal_id: str) -> Proposal | None:
        for r in self._records:
            if r["id"] == proposal_id:
                fields = {k: v for k, v in r.items() if k in Proposal.__dataclass_fields__}
                return Proposal(**fields)
        return None

    def count_pending(self) -> int:
        return sum(1 for r in self._records if r.get("status") == "pending")

    def close(self) -> None:
        # No persistent file handle; close is a no-op for symmetry.
        pass


def open_proposals(path: str) -> ProposalsHandle:
    return ProposalsHandle(path)
