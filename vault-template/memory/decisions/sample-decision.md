---
id: mem_2026-04-27_000001
type: decision
title: "Use SQLite FTS5 for the keyword index"
agent: human
session: null
created: "2026-04-27T14:32:00.000Z"
updated: "2026-04-27T14:32:00.000Z"
confidence: 0.85
sources:
  - "[[meeting-2026-04-25]]"
  - "[[code-review-pr-142]]"
contradicts: []
supersedes: []
tags: [storage, search, architecture]
project: vault-mem
ttl_days: null
status: active
human_reviewed: true
human_approved: true
schema_version: "0.1"
---

# Use SQLite FTS5 for the keyword index

## Rationale

SQLite FTS5 ships with Node's `better-sqlite3` binding, requires zero server
setup, and stores the index as a single file alongside the vault. Portability
and zero-server overhead are hard constraints for a local-first tool.

## Considered alternatives

- **Postgres FTS** — rejected: requires a running server, breaks the
  zero-dependency install story.
- **Elasticsearch / OpenSearch** — rejected: heavyweight, not local-first,
  overkill for single-user vault sizes (<10k memories).
- **Dedicated search service (Typesense, Meilisearch)** — rejected: another
  process to manage; no advantage over SQLite at this scale.

## Constraints

- Single-user, local-first
- Zero-server overhead
- Rebuildable from source `.md` files at any time (index is derived data)
