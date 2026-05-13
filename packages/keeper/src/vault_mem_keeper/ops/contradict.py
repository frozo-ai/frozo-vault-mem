"""Pairwise contradiction detection across canonical memories.

End-of-run scan: for each memory whose `updated` timestamp is newer than
`state.last_contradict_at`, fetch its Lance neighbors and ask Haiku
(same topic?) then Sonnet (actual contradiction?). High/medium contradictions
land in `_system/proposals.jsonl` for human review via `keeper review`."""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..audit import Auditor
from ..config import KeeperConfig
from ..fts import FtsReader
from ..lance import LanceReader
from ..llm.client import BudgetExceeded, LlmClient
from ..llm.prompts import contradict_judge, contradict_prefilter, parse_judge_response
from ..logging import get_logger
from ..paths import VaultPaths
from ..proposals import Proposal, open_proposals
from ..state import read_state, write_state

log = get_logger(__name__)

_SEVERITY_RANK: dict[str, int] = {"low": 1, "medium": 2, "high": 3}


def _is_yes(text: str) -> bool:
    return text.strip().lower().startswith("yes")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class ContradictReport:
    skipped: bool = False
    skip_reason: str | None = None
    memories_scanned: int = 0
    pairs_judged: int = 0
    proposals_written: int = 0
    cost_usd: float = 0.0
    errors: int = 0
    budget_exceeded: bool = False


def run_contradict(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],  # noqa: ARG001  # accepted for op-signature uniformity
    audit: Auditor,
    *,
    llm_client: LlmClient | None = None,
    dry_run: bool,
    run_id: str,
) -> ContradictReport:
    report = ContradictReport()

    if not cfg.contradict.enabled:
        report.skipped = True
        report.skip_reason = "disabled"
        return report
    if llm_client is None or not llm_client.has_key():
        report.skipped = True
        report.skip_reason = "missing ANTHROPIC_API_KEY"
        return report

    state = read_state(paths.state_file)
    threshold = state.get("last_contradict_at") or "1970-01-01T00:00:00Z"
    min_rank = _SEVERITY_RANK.get(cfg.contradict.min_severity, 2)

    fts = FtsReader(paths.index_file)
    try:
        canonical = fts.list({
            "location": "memory",
            "status": "active",
            "type": cfg.contradict.types_to_scan,
        })
    except Exception as e:
        log.warn("contradict: FTS unavailable", err=str(e))
        report.skipped = True
        report.skip_reason = f"fts unavailable: {e}"
        return report
    finally:
        fts.close()

    fts_by_id: dict[str, dict[str, Any]] = {row["id"]: row for row in canonical}
    new_canonical = [m for m in canonical if (m.get("updated") or "") > threshold]
    report.memories_scanned = len(new_canonical)

    if not new_canonical:
        # Still advance the watermark so re-runs don't re-scan the same set
        state["last_contradict_at"] = _now_iso()
        if not dry_run:
            write_state(paths.state_file, state)
        return report

    try:
        lance = LanceReader(paths.lance_dir)
    except Exception as e:
        log.warn("contradict: Lance unavailable", err=str(e))
        report.skipped = True
        report.skip_reason = f"lance unavailable: {e}"
        return report

    proposals = open_proposals(paths.proposals_file)

    try:
        for m in new_canonical:
            try:
                self_row = lance.get_by_id(m["id"])
            except Exception as e:
                log.warn("contradict: lance lookup failed", id=m["id"], err=str(e))
                report.errors += 1
                continue
            if not self_row:
                continue

            neighbors = lance.search(
                self_row["vector"],
                filter_={"status": "active", "location": "memory", "type": m["type"]},
                limit=cfg.contradict.top_k + 1,
            )
            for n in neighbors:
                if n["id"] == m["id"]:
                    continue
                n_fts = fts_by_id.get(n["id"])
                n_body = n_fts.get("body", "") if n_fts else ""
                n_title = (n_fts.get("title") if n_fts else None) or n.get("title", "")
                n_updated = (n_fts.get("updated") if n_fts else None) or n.get("updated") or ""
                if proposals.already_judged(m["id"], n["id"], m["updated"], n_updated):
                    continue

                # Pre-filter (Haiku): same topic?
                try:
                    pre = llm_client.haiku(
                        contradict_prefilter(
                            a_title=m.get("title", ""), a_body=m.get("body", ""),
                            b_title=n_title, b_body=n_body,
                        ),
                        op="contradict_prefilter", run_id=run_id, max_tokens=8,
                    )
                except BudgetExceeded:
                    report.budget_exceeded = True
                    break
                except Exception as e:
                    log.warn("contradict: prefilter failed", err=str(e))
                    report.errors += 1
                    continue
                report.cost_usd += pre.cost_usd
                if not _is_yes(pre.text):
                    continue

                # Judge (Sonnet): real contradiction?
                try:
                    judge = llm_client.sonnet(
                        contradict_judge(
                            a_id=m["id"], b_id=n["id"],
                            a_title=m.get("title", ""), a_body=m.get("body", ""),
                            b_title=n_title, b_body=n_body,
                        ),
                        op="contradict_judge", run_id=run_id, max_tokens=512,
                    )
                except BudgetExceeded:
                    report.budget_exceeded = True
                    break
                except Exception as e:
                    log.warn("contradict: judge failed", err=str(e))
                    report.errors += 1
                    continue
                report.cost_usd += judge.cost_usd
                report.pairs_judged += 1

                parsed = parse_judge_response(judge.text)
                if parsed is None:
                    log.warn("contradict: judge returned malformed JSON",
                             pair=(m["id"], n["id"]))
                    report.errors += 1
                    continue
                if not parsed.has_contradiction:
                    continue
                if _SEVERITY_RANK.get(parsed.severity, 0) < min_rank:
                    continue

                if dry_run:
                    report.proposals_written += 1
                    continue

                proposals.append(Proposal(
                    kind="contradict",
                    source_id=m["id"],
                    target_id=n["id"],
                    severity=parsed.severity,
                    reasoning=parsed.reasoning,
                    suggested_action=parsed.suggested_action,
                    model=cfg.contradict.sonnet_model,
                    cost_usd=pre.cost_usd + judge.cost_usd,
                    run_id=run_id,
                    source_updated=m["updated"],
                    target_updated=n_updated,
                ))
                report.proposals_written += 1
            if report.budget_exceeded:
                break
    finally:
        lance.close()

    state["last_contradict_at"] = _now_iso()
    if not dry_run:
        write_state(paths.state_file, state)
        audit.write({
            "op": "contradict_scan",
            "agent": "keeper",
            "session": run_id,
            "memories_scanned": report.memories_scanned,
            "pairs_judged": report.pairs_judged,
            "proposals_written": report.proposals_written,
            "cost_usd": round(report.cost_usd, 6),
        })
        if report.budget_exceeded:
            audit.write({
                "op": "budget_exceeded",
                "agent": "keeper",
                "session": run_id,
                "during": "contradict",
            })

    return report
