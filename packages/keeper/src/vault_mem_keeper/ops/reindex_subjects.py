"""One-shot backfill: scan canonical + inbox memories, extract subject
mentions from frontmatter, write them to `_system/subjects.sqlite`.

Used for:
- Legacy vaults that predate the DPDP Phase 1 spec (memories written
  before the MCP write-path hook existed).
- After bulk schema changes that affect extraction logic.
- Diagnostic re-runs from `vault-mem-keeper reindex-subjects`.

`archive/` is NOT scanned: archived memories are out of the active set
and should not contribute to subject-mention rows. The eventual erasure
verifier checks `archive/` separately (spec §5).
"""

from dataclasses import dataclass
from pathlib import Path

from ..frontmatter import parse_memory_file
from ..paths import MEMORY_TYPES, VaultPaths
from ..subject_index import Mention, SubjectIndex, extract_subject_ids


@dataclass
class ReindexSubjectsReport:
    scanned: int = 0
    skipped_unreadable: int = 0
    mentions_written: int = 0
    distinct_subjects: int = 0


def _iter_memory_files(paths: VaultPaths) -> list[tuple[str, str]]:
    """Yield (memory_id, abs_path) for every .md file under
    inbox/<plural>/ and memory/<plural>/. archive/ excluded by design.
    """
    out: list[tuple[str, str]] = []
    for t in MEMORY_TYPES:
        for loc_dir in (paths.inbox_dir(t), paths.memory_dir(t)):
            d = Path(loc_dir)
            if not d.is_dir():
                continue
            for f in sorted(d.glob("*.md")):
                # memory_id is the filename stem; we trust the
                # filesystem layout rather than parsing the frontmatter
                # `id` (matches what the indexer + supersede etc. do).
                out.append((f.stem, str(f)))
    return out


def run_reindex_subjects(
    paths: VaultPaths, *, dry_run: bool = False
) -> ReindexSubjectsReport:
    """Walk the vault, populate the subject-mentions index.

    Idempotent: each memory's rows are deleted-then-rewritten so the
    index reflects CURRENT frontmatter, not historical state. Safe to
    re-run after schema or extraction-rule changes.

    `dry_run=True` does extraction + counts but writes nothing — useful
    for the CLI's `--dry-run` flag and for quick mention-count
    diagnostics without touching the db file.
    """
    report = ReindexSubjectsReport()

    files = _iter_memory_files(paths)
    report.scanned = len(files)

    # Collect first, then write — keeps the SubjectIndex open for a
    # short window and lets dry-run skip the db entirely.
    all_mentions: list[Mention] = []
    affected_ids: set[str] = set()
    for memory_id, abs_path in files:
        try:
            fm, _body = parse_memory_file(abs_path)
        except Exception:
            report.skipped_unreadable += 1
            continue
        mentions = extract_subject_ids(fm, memory_id=memory_id)
        if mentions:
            affected_ids.add(memory_id)
            all_mentions.extend(mentions)

    if dry_run:
        report.mentions_written = len(all_mentions)
        report.distinct_subjects = len({m.subject_id for m in all_mentions})
        return report

    idx = SubjectIndex(paths.subjects_db)
    try:
        for mid in affected_ids:
            idx.delete_for_memory(mid)
        report.mentions_written = idx.record_mentions(all_mentions)
        report.distinct_subjects = idx.distinct_subjects()
    finally:
        idx.close()

    return report
