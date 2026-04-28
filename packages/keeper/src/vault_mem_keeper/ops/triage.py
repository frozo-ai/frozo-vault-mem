"""Inbox triage: promote inbox/<type>/<id>.md → memory/<type>/<id>.md."""

import os
from dataclasses import dataclass
from datetime import datetime, UTC
from pathlib import Path
from typing import Any

from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import parse_memory_file, validate_frontmatter
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths

log = get_logger(__name__)


@dataclass
class TriageReport:
    promoted: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 timestamp; treat trailing 'Z' as UTC."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def run_triage(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> TriageReport:
    report = TriageReport()
    if not cfg.triage.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        inbox_dir = Path(paths.inbox_dir(t))
        if not inbox_dir.is_dir():
            continue
        for md in sorted(inbox_dir.glob("*.md")):
            try:
                fm, _content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("triage: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("triage: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            if fm.get("status") != "active":
                report.skipped += 1
                continue
            if (fm.get("confidence") or 0.0) < cfg.triage.min_confidence:
                report.skipped += 1
                continue

            human_reviewed = bool(fm.get("human_reviewed"))
            if not (human_reviewed and cfg.triage.promote_immediately_if_human_reviewed):
                created = _parse_iso(fm["created"])
                updated = _parse_iso(fm.get("updated", fm["created"]))
                anchor = max(created, updated)
                age_min = (now - anchor).total_seconds() / 60
                if age_min < cfg.triage.min_age_minutes:
                    report.skipped += 1
                    continue

            mid = fm["id"]
            dst = Path(paths.memory_file(t, mid, "memory"))
            if dry_run:
                log.info("[dry-run] would promote", id=mid, src=str(md), dst=str(dst))
                report.promoted += 1
                continue

            dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(str(md), str(dst))
            audit.write({
                "op": "promote",
                "agent": "keeper",
                "session": run_id,
                "id": mid,
                "from": str(md),
                "to": str(dst),
                "reason": "auto",
            })
            report.promoted += 1

    return report
