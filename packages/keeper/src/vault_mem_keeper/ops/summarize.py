"""Per-project rollup summaries (daily/weekly/monthly) via Sonnet.

At the end of each keeper run, decide which (project, period) pairs need
a fresh summary. Regen criteria are AND'd: enough time elapsed AND enough
new memories since the last summary. Writes one `summary` memory per
regenerated period under `memory/summaries/`."""

import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import serialize_memory
from ..fts import FtsReader
from ..llm.client import BudgetExceeded, LlmClient
from ..llm.prompts import summary_for_period
from ..logging import get_logger
from ..paths import VaultPaths
from ..state import read_state, write_state

log = get_logger(__name__)

_PERIODS: tuple[str, ...] = ("daily", "weekly", "monthly")
_PERIOD_DAYS: dict[str, int] = {"daily": 1, "weekly": 7, "monthly": 30}
_BUCKET_PRIORITY: list[str] = [
    "decision", "learning", "observation",
    "summary", "todo", "entity", "question",
]


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat().replace("+00:00", "Z")


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _new_summary_id() -> str:
    today = _now().date().isoformat()
    return f"mem_{today}_{secrets.token_hex(3)}"


def _sort_key(m: dict[str, Any]) -> tuple[int, float]:
    bucket_idx = (
        _BUCKET_PRIORITY.index(m["type"])
        if m.get("type") in _BUCKET_PRIORITY else 99
    )
    try:
        ts = _parse_iso(m.get("updated", "1970-01-01T00:00:00Z")).timestamp()
    except ValueError:
        ts = 0.0
    return (bucket_idx, -ts)


@dataclass
class SummarizeReport:
    skipped: bool = False
    skip_reason: str | None = None
    summaries_written: int = 0
    cost_usd: float = 0.0
    errors: int = 0
    budget_exceeded: bool = False
    per_project: dict[str, list[str]] = field(default_factory=dict)


def run_summarize(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],  # noqa: ARG001  # op trusts FTS rows; no per-field re-validation
    audit: Auditor,
    *,
    llm_client: LlmClient | None = None,
    dry_run: bool,
    run_id: str,
) -> SummarizeReport:
    report = SummarizeReport()

    if not cfg.summarize.enabled:
        report.skipped = True
        report.skip_reason = "disabled"
        return report
    if llm_client is None or not llm_client.has_key():
        report.skipped = True
        report.skip_reason = "missing ANTHROPIC_API_KEY"
        return report

    fts = FtsReader(paths.index_file)
    try:
        canonical = fts.list({"location": "memory", "status": "active"})
    except Exception as e:
        log.warn("summarize: FTS unavailable", err=str(e))
        report.skipped = True
        report.skip_reason = f"fts unavailable: {e}"
        return report
    finally:
        fts.close()

    by_project: dict[str, list[dict[str, Any]]] = {}
    for m in canonical:
        proj = m.get("project")
        if not proj:
            continue
        by_project.setdefault(proj, []).append(m)

    if not by_project:
        return report

    state = read_state(paths.state_file)
    state.setdefault("summaries", {})
    now = _now()

    for project, mems in sorted(by_project.items()):
        for period in _PERIODS:
            period_cfg = getattr(cfg.summarize, period)
            if not period_cfg.enabled:
                continue
            period_days = _PERIOD_DAYS[period]
            window_cutoff_iso = (
                (now - timedelta(days=period_days)).isoformat().replace("+00:00", "Z")
            )

            # Time gate: last summary must be at least period_days old (or absent)
            last_ts_iso = (state["summaries"].get(project) or {}).get(period)
            if last_ts_iso:
                try:
                    last_dt = _parse_iso(last_ts_iso)
                except ValueError:
                    last_dt = None
                if last_dt and (now - last_dt) < timedelta(days=period_days):
                    continue

            candidates = [
                m for m in mems
                if (m.get("updated") or "") >= window_cutoff_iso
            ]
            if len(candidates) < period_cfg.min_new_memories:
                continue

            ordered = sorted(candidates, key=_sort_key)[: cfg.summarize.max_input_memories]
            prompt = summary_for_period(
                project=project,
                period=period,
                memories=[
                    {
                        "id": m["id"],
                        "type": m["type"],
                        "title": m.get("title", ""),
                        "content": m.get("body", ""),
                    }
                    for m in ordered
                ],
            )

            try:
                resp = llm_client.sonnet(
                    prompt, op=f"summarize_{period}", run_id=run_id, max_tokens=2048,
                )
            except BudgetExceeded:
                report.budget_exceeded = True
                break
            except Exception as e:
                log.warn("summarize: sonnet call failed",
                         project=project, period=period, err=str(e))
                report.errors += 1
                continue
            report.cost_usd += resp.cost_usd

            summary_id = _new_summary_id()
            now_iso = _now_iso()
            summary_fm = {
                "id": summary_id,
                "type": "summary",
                "title": f"{period.capitalize()} summary for {project} — {now.date().isoformat()}",
                "agent": "keeper",
                "session": run_id,
                "created": now_iso,
                "updated": now_iso,
                "confidence": 1.0,
                "sources": [],
                "contradicts": [],
                "supersedes": [],
                "tags": [project, period, "auto-generated"],
                "project": project,
                "ttl_days": None,
                "status": "active",
                "human_reviewed": False,
                "human_approved": None,
                "schema_version": "0.1",
                "period": period,
                "covers": [m["id"] for m in ordered],
            }

            if dry_run:
                report.summaries_written += 1
                report.per_project.setdefault(project, []).append(period)
                continue

            target = paths.memory_file("summary", summary_id, "memory")
            atomic_write(target, serialize_memory(summary_fm, resp.text))

            state["summaries"].setdefault(project, {})[period] = now_iso
            report.summaries_written += 1
            report.per_project.setdefault(project, []).append(period)
            audit.write({
                "op": "summarize",
                "agent": "keeper",
                "session": run_id,
                "project": project,
                "period": period,
                "memory_id": summary_id,
                "covers_count": len(ordered),
                "cost_usd": round(resp.cost_usd, 6),
            })
        if report.budget_exceeded:
            break

    if not dry_run:
        write_state(paths.state_file, state)
        if report.budget_exceeded:
            audit.write({
                "op": "budget_exceeded",
                "agent": "keeper",
                "session": run_id,
                "during": "summarize",
            })

    return report
