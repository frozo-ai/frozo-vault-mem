"""Soft monthly USD cap for Anthropic API spend.

Reads/appends `_system/budget.jsonl`. month_to_date() sums cost_usd
for the current calendar month; is_exceeded() returns True when over
the configured cap. record_call() appends a per-call line."""

import json
from datetime import UTC, datetime
from pathlib import Path


class BudgetTracker:
    def __init__(self, log_path: str, monthly_cap_usd: float) -> None:
        self._path = log_path
        self._cap = monthly_cap_usd

    def month_to_date(self) -> float:
        if not Path(self._path).is_file():
            return 0.0
        now = datetime.now(UTC)
        prefix = f"{now.year:04d}-{now.month:02d}-"
        total = 0.0
        for line in Path(self._path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = rec.get("ts", "")
            if isinstance(ts, str) and ts.startswith(prefix):
                total += float(rec.get("cost_usd") or 0.0)
        return total

    def is_exceeded(self) -> bool:
        return self.month_to_date() >= self._cap

    def remaining(self) -> float:
        return max(0.0, self._cap - self.month_to_date())

    def record_call(
        self, *, model: str, input_tokens: int, output_tokens: int,
        cost_usd: float, op: str, run_id: str,
    ) -> None:
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "v": 1,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_usd,
            "op": op,
            "run_id": run_id,
        }
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
