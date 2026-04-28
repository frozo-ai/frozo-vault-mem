"""Archive op: move TTL-expired or low-confidence memories from
memory/<type>/ to archive/."""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
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
class ArchiveReport:
    archived: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def run_archive(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> ArchiveReport:
    report = ArchiveReport()
    if not cfg.archive.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        mem_dir = Path(paths.memory_dir(t))
        if not mem_dir.is_dir():
            continue
        for md in sorted(mem_dir.glob("*.md")):
            try:
                fm, content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("archive: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("archive: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            reasons: list[str] = []
            ttl = fm.get("ttl_days")
            if cfg.archive.respect_ttl_days and ttl is not None:
                created = _parse_iso(fm["created"])
                updated = _parse_iso(fm.get("updated", fm["created"]))
                anchor = max(created, updated)
                expiry = anchor + timedelta(days=int(ttl))
                if now >= expiry:
                    reasons.append("ttl_expired")
            if float(fm.get("confidence") or 0.0) < cfg.archive.archive_below_confidence:
                reasons.append("low_confidence")
            if not reasons:
                report.skipped += 1
                continue

            mid = fm["id"]
            dst = Path(paths.memory_file(t, mid, "archive"))

            if dry_run:
                log.info("[dry-run] would archive", id=mid, src=str(md), dst=str(dst), reasons=reasons)
                report.archived += 1
                continue

            fm["status"] = "archived"
            atomic_write(str(md), serialize_memory(fm, content))    # update status before move
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(str(md), str(dst))
            audit.write({
                "op": "archive",
                "agent": "keeper",
                "session": run_id,
                "id": mid,
                "from": str(md),
                "to": str(dst),
                "reasons": reasons,
            })
            report.archived += 1

    return report
