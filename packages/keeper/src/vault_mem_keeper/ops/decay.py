"""Confidence decay: erode confidence per type over time, advancing
last_decay_at by completed periods (preserves partial-period progress)."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import parse_memory_file, serialize_memory, validate_frontmatter
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths

log = get_logger(__name__)


@dataclass
class DecayReport:
    decayed: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _to_iso_z(d: datetime) -> str:
    return d.astimezone(UTC).isoformat().replace("+00:00", "Z")


def run_decay(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> DecayReport:
    report = DecayReport()
    if not cfg.decay.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        rate = cfg.decay.rates.get(t)
        if rate is None:
            continue
        mem_dir = Path(paths.memory_dir(t))
        if not mem_dir.is_dir():
            continue
        for md in sorted(mem_dir.glob("*.md")):
            try:
                fm, content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("decay: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("decay: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            anchor_str = fm.get("last_decay_at") or fm.get("updated") or fm.get("created")
            anchor = _parse_iso(anchor_str)
            elapsed_days = (now - anchor).days
            periods = elapsed_days // rate
            if periods <= 0:
                report.skipped += 1
                continue

            current_conf = float(fm.get("confidence") or 0.0)
            delta = -periods * cfg.decay.decay_amount_per_period
            new_conf = max(0.0, current_conf + delta)
            if abs(new_conf - current_conf) < 0.001:
                report.skipped += 1
                continue

            new_anchor = anchor + timedelta(days=periods * rate)

            if dry_run:
                log.info("[dry-run] would decay",
                         id=fm["id"], from_conf=current_conf, to_conf=new_conf, periods=periods)
                report.decayed += 1
                continue

            fm["confidence"] = new_conf
            fm["last_decay_at"] = _to_iso_z(new_anchor)
            atomic_write(str(md), serialize_memory(fm, content))
            audit.write({
                "op": "decay",
                "agent": "keeper",
                "session": run_id,
                "id": fm["id"],
                "from_confidence": current_conf,
                "to_confidence": new_conf,
                "delta": delta,
                "periods": periods,
            })
            report.decayed += 1

    return report
