"""Runner: orchestrates a single keeper pass."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

import ulid  # noqa: E401

from .audit import Auditor
from .config import load_keeper_config
from .frontmatter import load_schemas
from .llm.budget import BudgetTracker
from .llm.client import make_client
from .logging import configure as configure_logging
from .logging import get_logger
from .ops import archive as archive_op
from .ops import contradict as contradict_op
from .ops import decay as decay_op
from .ops import link as link_op
from .ops import summarize as summarize_op
from .ops import triage as triage_op
from .paths import resolve_vault_path, vault_paths
from .proposals import open_proposals

log = get_logger(__name__)

DEFAULT_OPS_ORDER = ["triage", "link", "decay", "archive", "contradict", "summarize"]


@dataclass
class RunOpts:
    vault: str
    dry_run: bool = False
    ops: list[str] | None = None     # subset filter; None = all enabled


@dataclass
class OpReport:
    name: str
    skipped: bool = False
    skip_reason: str | None = None
    error: str | None = None
    # op-specific counters merged in via __dict__:
    promoted: int = 0
    archived: int = 0
    decayed: int = 0
    link_count: int = 0
    from_count: int = 0
    # Phase 5:
    proposals_written: int = 0
    pairs_judged: int = 0
    memories_scanned: int = 0
    summaries_written: int = 0
    cost_usd: float = 0.0
    budget_exceeded: bool = False


@dataclass
class RunReport:
    run_id: str
    started_at: str
    duration_ms: int
    ops: dict[str, OpReport] = field(default_factory=dict)
    pending_proposals: int = 0
    budget_mtd_usd: float = 0.0


def _apply_op(name: str, run_op_fn, *args, **kwargs) -> OpReport:
    rep = OpReport(name=name)
    try:
        result = run_op_fn(*args, **kwargs)
        # Carry skip metadata if the op returned a *_Report with skip fields
        if getattr(result, "skipped", False):
            rep.skipped = True
            rep.skip_reason = getattr(result, "skip_reason", None)
        for fld in (
            "promoted", "archived", "decayed", "link_count", "from_count",
            "proposals_written", "pairs_judged", "memories_scanned",
            "summaries_written", "cost_usd", "budget_exceeded",
        ):
            if hasattr(result, fld):
                setattr(rep, fld, getattr(result, fld))
    except Exception as e:
        log.exception(f"op failed: {name}")
        rep.error = str(e)
    return rep


def run_pass(opts: RunOpts) -> RunReport:
    configure_logging()

    vault = resolve_vault_path(flag=opts.vault)
    paths = vault_paths(vault)
    cfg = load_keeper_config(vault)
    schemas = load_schemas(vault)
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch(exist_ok=True)

    # LLM client (Phase 5). Built unconditionally so ops can call has_key() themselves.
    budget = BudgetTracker(paths.budget_file, cfg.budget.monthly_usd_cap)
    llm_client = make_client(
        budget=budget,
        haiku_model=cfg.contradict.haiku_model,
        sonnet_model=cfg.contradict.sonnet_model,
    )

    run_id = str(ulid.ULID())
    started = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    t0 = monotonic()

    ops_to_run = opts.ops or DEFAULT_OPS_ORDER
    report = RunReport(run_id=run_id, started_at=started, duration_ms=0)

    for name in ops_to_run:
        op_cfg = getattr(cfg, name, None)
        if op_cfg is None:
            report.ops[name] = OpReport(name=name, skipped=True, skip_reason="unknown op")
            continue
        if not op_cfg.enabled:
            report.ops[name] = OpReport(name=name, skipped=True, skip_reason="disabled")
            continue

        if name == "triage":
            report.ops[name] = _apply_op(
                "triage", triage_op.run_triage, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "link":
            report.ops[name] = _apply_op(
                "link", link_op.run_link, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "decay":
            report.ops[name] = _apply_op(
                "decay", decay_op.run_decay, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "archive":
            report.ops[name] = _apply_op(
                "archive", archive_op.run_archive, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "contradict":
            report.ops[name] = _apply_op(
                "contradict", contradict_op.run_contradict, paths, cfg, schemas, audit,
                llm_client=llm_client, dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "summarize":
            report.ops[name] = _apply_op(
                "summarize", summarize_op.run_summarize, paths, cfg, schemas, audit,
                llm_client=llm_client, dry_run=opts.dry_run, run_id=run_id,
            )

    report.duration_ms = int((monotonic() - t0) * 1000)

    # Phase 5 surface in keeper_run audit summary
    try:
        report.pending_proposals = open_proposals(paths.proposals_file).count_pending()
    except Exception as e:
        log.warn("runner: failed to count pending proposals", err=str(e))
    try:
        report.budget_mtd_usd = budget.month_to_date()
    except Exception as e:
        log.warn("runner: failed to read budget mtd", err=str(e))

    if not opts.dry_run:
        audit.write({
            "op": "keeper_run",
            "agent": "keeper",
            "session": run_id,
            "duration_ms": report.duration_ms,
            "summary": {
                name: {k: v for k, v in op.__dict__.items()
                       if k not in ("name", "skipped", "skip_reason") and v}
                for name, op in report.ops.items()
            },
            "pending_proposals": report.pending_proposals,
            "budget_mtd_usd": round(report.budget_mtd_usd, 6),
        })

    return report
