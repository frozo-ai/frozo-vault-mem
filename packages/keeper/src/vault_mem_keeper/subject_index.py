"""Subject-mention index for DPDP/GDPR per-subject erasure (spec §3).

The index lives at `<vault>/_system/subjects.sqlite` and maps
`subject_id → memory_id[]` so the eventual `erase-subject` cascade
(Phase 2) can find every memory tied to a person without scanning the
entire vault on each request.

Populated by:
- This module's `extract_subject_ids()` — runs over frontmatter to find
  canonical `<prefix>:<value>` subject ids in `tags` and `sources` fields,
  and treats `entity` memories with `entity_kind: person` as primary
  subjects for whatever canonical ids they carry.
- The Phase 1 `reindex_subjects` op — bulk backfill.
- The keeper `link` op — body-scan against known subjects (Phase 1
  follow-up; not in this commit).
- The MCP server's `memory_write` path — write-time extraction (Phase 1
  TS follow-up; not in this commit).

Schema mirrors spec §3.3. Both Python (this module) and TypeScript
(future) write to the same SQLite file; both use `CREATE TABLE IF NOT
EXISTS` on connect. WAL mode keeps concurrent writers safe at our scale.
"""

import os
import re
import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

# Canonical subject-id prefixes per spec §3.1. Anything matching
# `^(prefix):` is a candidate. Validation of the suffix is left light
# — over-eager matches just waste an index row.
SUBJECT_PREFIXES: tuple[str, ...] = (
    "email",
    "slack",
    "github",
    "linear",
    "notion",
    "local",
)

# Anchored full-string match: a tag/source must BE a subject id, not
# merely contain one. Suffix is anything non-empty so we don't accept
# `email:` with no address.
_SUBJECT_RE = re.compile(
    r"^(?:" + "|".join(SUBJECT_PREFIXES) + r"):.+$"
)

MentionKind = Literal["primary_subject", "source_author", "tag", "body_match"]


@dataclass(frozen=True)
class Mention:
    """One (subject, memory) link with kind + originating field path."""

    subject_id: str
    memory_id: str
    kind: MentionKind
    field_path: str  # "" when not field-bound (e.g. body_match)


def _canonicalize(subject_id: str) -> str:
    """Lowercase the email local-part/domain so 'Email:Foo@X.com' and
    'email:foo@x.com' collapse. Other prefixes pass through — Slack IDs,
    GitHub logins, and Linear/Notion UUIDs all preserve case to match
    what the source systems return."""
    if subject_id.startswith("email:"):
        return "email:" + subject_id[6:].lower()
    if subject_id.startswith("github:"):
        return "github:" + subject_id[7:].lower()
    return subject_id


def _strings_in(value: Any) -> Iterable[str]:
    """Flatten one level: yield strings from a value that might be a
    string, list of strings, or anything else (ignored)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for v in value:
            if isinstance(v, str):
                yield v


def extract_subject_ids(
    frontmatter: dict[str, Any], memory_id: str
) -> list[Mention]:
    """Return Mentions for one memory based on its frontmatter alone.

    OSS-schema fields scanned (per spec §3.2):
    - `tags` (array of strings) — any element matching the subject-id regex
      becomes a `tag` mention. For `entity` memories with
      `entity_kind: person`, those same tags promote to `primary_subject`.
    - `sources` (array of strings) — any element matching the regex
      becomes a `source_author` mention.

    Body-scan (`body_match`) is NOT done here — that's a keeper `link`
    op responsibility (deferred, requires a known-subjects table to
    match against).

    Returns deduplicated mentions: (subject_id, kind, field_path) is
    unique per call; same (subject, kind) wins last across field paths.
    """
    is_person_entity = (
        frontmatter.get("type") == "entity"
        and frontmatter.get("entity_kind") == "person"
    )

    raw_mentions: dict[tuple[str, MentionKind, str], Mention] = {}

    def add(sid: str, kind: MentionKind, field: str) -> None:
        canonical = _canonicalize(sid)
        key = (canonical, kind, field)
        raw_mentions[key] = Mention(
            subject_id=canonical,
            memory_id=memory_id,
            kind=kind,
            field_path=field,
        )

    for tag in _strings_in(frontmatter.get("tags")):
        if _SUBJECT_RE.match(tag):
            # For person entities, the memory IS the canonical record
            # of this subject — promote tag → primary_subject so the
            # erasure cascade marks this memory for full-delete (not
            # just scrub).
            kind: MentionKind = "primary_subject" if is_person_entity else "tag"
            add(tag, kind, "tags")

    for src in _strings_in(frontmatter.get("sources")):
        if _SUBJECT_RE.match(src):
            add(src, "source_author", "sources")

    return list(raw_mentions.values())


# ---------------------------------------------------------------------------


_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS subject_mentions (
  subject_id   TEXT NOT NULL,
  memory_id    TEXT NOT NULL,
  mention_kind TEXT NOT NULL,
  field_path   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (subject_id, memory_id, mention_kind, field_path)
);
CREATE INDEX IF NOT EXISTS idx_subject_mentions_subject
  ON subject_mentions(subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_mentions_memory
  ON subject_mentions(memory_id);
"""


class SubjectIndex:
    """Read/write wrapper over `_system/subjects.sqlite`.

    Open once per process; reuse the connection. Thread-safe via
    SQLite's own locking + WAL mode (we set both at open time).
    `close()` is optional — Python will GC the connection. Tests
    that want to assert "no open file handles" should call it.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._db = sqlite3.connect(db_path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        # WAL for safe concurrent reads while keeper writes; busy_timeout
        # keeps the writer happy if a reader holds a brief lock.
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.executescript(_SCHEMA_DDL)

    @property
    def path(self) -> str:
        return self._db_path

    def close(self) -> None:
        self._db.close()

    # -- write paths ---------------------------------------------------

    def record_mentions(self, mentions: Iterable[Mention]) -> int:
        """Upsert mentions. Returns count actually written.

        Idempotent: same (subject_id, memory_id, kind, field_path) on
        re-run does nothing — the PRIMARY KEY + ON CONFLICT IGNORE
        absorbs it without rewriting `created_at`.
        """
        rows = list(mentions)
        if not rows:
            return 0
        now_ms = int(time.time() * 1000)
        self._db.executemany(
            """
            INSERT INTO subject_mentions
              (subject_id, memory_id, mention_kind, field_path, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (subject_id, memory_id, mention_kind, field_path)
              DO NOTHING
            """,
            [
                (m.subject_id, m.memory_id, m.kind, m.field_path, now_ms)
                for m in rows
            ],
        )
        return len(rows)

    def delete_for_memory(self, memory_id: str) -> int:
        """Drop all mentions tied to a memory id. Returns rows removed.
        Used by reindex (so a memory's mentions reflect its CURRENT
        frontmatter, not stale state) and by the eventual erasure
        cascade."""
        cur = self._db.execute(
            "DELETE FROM subject_mentions WHERE memory_id = ?", (memory_id,)
        )
        return cur.rowcount or 0

    def delete_for_subject(self, subject_id: str) -> int:
        """Drop every row for a subject. Used by the erasure cascade
        at its final cleanup step (after the .md files are gone)."""
        cur = self._db.execute(
            "DELETE FROM subject_mentions WHERE subject_id = ?", (subject_id,)
        )
        return cur.rowcount or 0

    # -- read paths ----------------------------------------------------

    def list_for_subject(self, subject_id: str) -> list[Mention]:
        cur = self._db.execute(
            """
            SELECT subject_id, memory_id, mention_kind, field_path
            FROM subject_mentions
            WHERE subject_id = ?
            ORDER BY memory_id, mention_kind, field_path
            """,
            (subject_id,),
        )
        return [
            Mention(
                subject_id=r["subject_id"],
                memory_id=r["memory_id"],
                kind=r["mention_kind"],
                field_path=r["field_path"],
            )
            for r in cur.fetchall()
        ]

    def list_for_memory(self, memory_id: str) -> list[Mention]:
        cur = self._db.execute(
            """
            SELECT subject_id, memory_id, mention_kind, field_path
            FROM subject_mentions
            WHERE memory_id = ?
            ORDER BY subject_id, mention_kind, field_path
            """,
            (memory_id,),
        )
        return [
            Mention(
                subject_id=r["subject_id"],
                memory_id=r["memory_id"],
                kind=r["mention_kind"],
                field_path=r["field_path"],
            )
            for r in cur.fetchall()
        ]

    def count(self) -> int:
        cur = self._db.execute("SELECT COUNT(*) AS n FROM subject_mentions")
        return int(cur.fetchone()["n"])

    def distinct_subjects(self) -> int:
        cur = self._db.execute(
            "SELECT COUNT(DISTINCT subject_id) AS n FROM subject_mentions"
        )
        return int(cur.fetchone()["n"])
