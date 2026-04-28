# Vault-Mem MCP Server — Design (Phase 0 + Phase 1)

**Status:** Draft for implementation
**Date:** 2026-04-27
**Owner:** the maintainer
**PRD:** [`vault-mem-prd.md`](../../../vault-mem-prd.md)
**Phase:** 0 (vault scaffolding) + 1 (MCP server v0.1) bundled

---

## 1. Context & purpose

Vault-Mem is a personal-use, local-first shared memory layer for any MCP-aware agent stack (Claude Code, Cursor, custom agents). Every agent write becomes a typed markdown file in an Obsidian vault with enforced YAML frontmatter. See the PRD for full motivation.

This document specifies the first shippable artifact:

1. The **vault scaffolding** — folder layout, JSON Schemas for all 7 memory types, markdown templates, config, audit log, sample memory.
2. A **TypeScript MCP server** — local stdio daemon exposing `memory_read`, `memory_write`, `memory_search`, plus `memory_promote` and a small set of CLI subcommands.

After this phase ships, Claude Code can read and write memories during a real coding session, and the vault remains coherent and human-editable in Obsidian.

## 2. Scope

**In scope:**
- Monorepo skeleton (this repo) with `packages/mcp/` and `vault-template/`.
- Vault scaffolding (Phase 0).
- MCP server (Phase 1) on Node 20 LTS + pnpm + stdio transport.
- 4 MCP tools: `memory_read`, `memory_write`, `memory_search`, `memory_promote`.
- 4 CLI subcommands: `init`, `doctor`, `reindex`, `tail-audit`.
- SQLite FTS5 index with chokidar-driven incremental updates.
- JSONL audit log.
- Schema additivity rule (documented policy, not a runner).

**Out of scope** (do not build, even if it feels small):
- Embeddings / semantic search (Phase 2).
- `memory_update`, `memory_link`, `memory_contradict`, `memory_query`, `memory_recent`, `memory_context` (Phase 2+).
- Hygiene daemon, Telegram approval, network transport, bearer-token auth.
- Schema migration runner, audit log rotation, Obsidian plugin.
- Multi-vault support, hot reload, backup/restore commands.

## 3. Architecture overview

### 3.1 Monorepo layout

```
vault-mem/
├── docs/superpowers/specs/        # design docs
├── vault-mem-prd.md
├── CLAUDE.md
├── README.md
├── pnpm-workspace.yaml
├── package.json                   # root workspace
├── .gitignore
├── packages/
│   └── mcp/                       # vault-mem-mcp
│       ├── src/
│       ├── test/
│       ├── bin/vault-mem-mcp
│       ├── package.json
│       └── tsconfig.json
└── vault-template/                # Phase 0 deliverable
    ├── memory/{decisions,observations,todos,learnings,summaries,entities,questions}/
    ├── projects/
    ├── inbox/{decisions,observations,todos,learnings,summaries,entities,questions}/
    ├── archive/
    ├── _system/
    │   ├── schema/                # JSON Schema draft-07
    │   ├── templates/             # markdown templates
    │   ├── config.yaml.example
    │   └── audit.log              # empty starter
    └── .gitignore                 # excludes _system/index.sqlite{,-wal,-shm}
```

The `vault-template/` is committed in this repo. The `init` command materializes a working vault elsewhere (default `~/vault-mem/`) by copying it.

### 3.2 Runtime & tooling

- **Runtime:** Node 20 LTS.
- **Package manager:** pnpm with a workspace at the repo root (`pnpm-workspace.yaml`).
- **TypeScript:** strict mode, ESM. Dev: `tsx`. Build: `tsc`.
- **Test:** Vitest.
- **Logging:** `pino` to stderr (stdout is reserved for the MCP protocol). Pretty in dev, JSON in prod.

### 3.3 Vault path resolution

Resolved at server startup, in this priority order:

1. `--vault <path>` CLI flag
2. `VAULT_MEM_PATH` environment variable
3. Default: `~/vault-mem/`

### 3.4 Server module boundaries (`packages/mcp/src/`)

Each module is small, focused, and unit-testable in isolation:

| Module | Responsibility |
|---|---|
| `config/` | Resolve vault path, load `_system/config.yaml`, validate, expose as a typed object |
| `schema/` | Load + compile JSON Schemas from `_system/schema/`; expose `validate(type, frontmatter)` |
| `vault/` | File I/O: atomic write, read, list, lock. Owns temp+rename + advisory-lock dance |
| `id/` | Generate `mem_<YYYY-MM-DD>_<6 hex chars>` IDs; collision check |
| `audit/` | Append-only JSONL writer for `_system/audit.log` |
| `index/` | SQLite FTS5 lifecycle: open, populate, incremental upsert/delete, search; chokidar wiring |
| `tools/` | The 4 MCP tool handlers — each thin: validate args → call vault/index → format response |
| `cli/` | The 4 CLI subcommands (`init`, `doctor`, `reindex`, `tail-audit`) |
| `server/` | MCP SDK wiring: stdio transport, tool registration, client info |

The MCP SDK only enters at the `server` and `tools` boundary. Everything else is plain Node.

## 4. Vault scaffolding (Phase 0)

### 4.1 JSON Schemas (`vault-template/_system/schema/`)

Seven type schemas plus a shared base, all JSON Schema draft-07:

```
_system/schema/
├── _common.json     # base fields shared by all types
├── decision.json    # extends _common, requires title; ttl_days default null
├── observation.json # ttl_days default 90
├── todo.json        # adds status enum: todo|doing|done|cancelled
├── learning.json    # ttl_days default 180
├── summary.json     # adds period: daily|weekly|monthly; covers: [memory_ids]
├── entity.json      # adds entity_kind: person|project|tool|concept
└── question.json    # adds resolved_by: id|null
```

**`_common.json` field set:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Pattern: `mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}` (6 hex chars from `randomBytes(3)`) |
| `type` | enum | yes | One of the 7 types |
| `title` | string | yes | Human-readable; used for FTS title-weighted search |
| `agent` | string | yes | E.g., `claude-code`, `cursor`, `human` |
| `session` | string \| null | yes | ULID for the MCP connection that produced the write |
| `created` | string (ISO 8601) | yes | Set by server, immutable |
| `updated` | string (ISO 8601) | yes | Set by server on each write |
| `confidence` | number 0..1 | no | Default 0.7 for agent writes, 1.0 for human |
| `sources` | array<string> | no | Wikilinks or memory IDs |
| `contradicts` | array<string> | no | Memory IDs |
| `supersedes` | array<string> | no | Memory IDs |
| `tags` | array<string> | no | Free-form |
| `project` | string \| null | no | Project key for filtering |
| `ttl_days` | integer \| null | no | null = permanent |
| `status` | enum | yes | `active` \| `archived` \| `superseded` |
| `human_reviewed` | boolean | no | Default false |
| `human_approved` | boolean \| null | no | Default null |
| `schema_version` | string | yes | E.g., `"0.1"` |

Type-specific schemas use `allOf: [{ $ref: "_common.json" }, { ...overrides }]`.

### 4.2 Schema additivity rule

**Until further notice, all schema changes from v0.1 onward are additive only:**

- New optional fields are allowed.
- Renaming, removing, type-narrowing, or making an existing optional field required is **not** allowed without a versioned migration.
- The `schema_version` field on every memory makes future migrations possible without rewriting history.
- This rule is documented in this spec and in the vault README. The migration runner itself is out of scope until the first breaking change is genuinely needed (see PRD §10 risk #2).

### 4.3 Markdown templates (`vault-template/_system/templates/`)

One `.md` per type. Each has frontmatter pre-filled with placeholder tokens (`{{id}}`, `{{created}}`, etc.) that the Obsidian Templater plugin (or the `init` command's sample insertion) substitutes. Body skeletons match the PRD example — e.g., `decision.md` includes `## Rationale`, `## Considered alternatives`, `## Constraints`.

### 4.4 Config file (`vault-template/_system/config.yaml.example`)

```yaml
vault_version: 0.1
schema_version: 0.1
default_agent: human
inbox_routing: always       # v0.1: every agent write lands in inbox/
fts:
  index_path: _system/index.sqlite   # gitignored
  rebuild_on_startup: false
audit:
  log_path: _system/audit.log
```

The `init` command copies this to `_system/config.yaml` and stamps a generated `vault_id` (UUID) into it.

### 4.5 Sample memory

`vault-template/memory/decisions/sample-decision.md` — a real, schema-valid decision memory. Doubles as a smoke-test fixture and as a "what does a memory look like" reference for future-you.

### 4.6 `.gitignore` inside the materialized vault

```
_system/index.sqlite
_system/index.sqlite-wal
_system/index.sqlite-shm
```

The vault itself is git-tracked (per PRD §12 Q5 backup strategy). The FTS index is rebuildable from source and excluded.

## 5. MCP tool API (Phase 1)

All tool handlers live in `packages/mcp/src/tools/`. Each handler:
1. Validates input against the tool's input JSON Schema (Ajv).
2. Calls `vault/`, `schema/`, `index/`, `audit/` as needed.
3. Returns a structured result or a typed error.

### 5.1 `memory_read`

```ts
input:  { id: string }
output: {
  id: string
  type: MemoryType
  frontmatter: Record<string, unknown>
  content: string                        // markdown body, no frontmatter
  path: string                           // absolute path
  location: "inbox" | "memory" | "archive"
}
```

**Errors:** `not_found`, `invalid_schema` (file exists but frontmatter fails validation — surfaced loudly).

### 5.2 `memory_write`

```ts
input: {
  type: MemoryType
  fields: Record<string, unknown>     // frontmatter; id/created/updated auto-filled
  content: string                      // markdown body
  agent?: string                       // overrides MCP clientInfo.name if set
}
output: {
  id: string
  path: string                         // always inside inbox/<type>/ in v0.1
  warnings: string[]                   // non-fatal issues (e.g., missing recommended tags)
}
```

**Server-controlled fields** (caller cannot override): `id`, `created`, `updated`, `agent` (resolved per Section 5.6), `session`, `status: "active"`, `schema_version`.

**Behavior:** every write lands in `inbox/<type>/<id>.md` per PRD §6 Flow A. Validation failure returns an error with the full Ajv error array; no file written, no audit entry, no index change.

**Errors:** `schema_validation_failed`, `inbox_write_failed`.

### 5.3 `memory_search`

```ts
input: {
  query: string                                                       // FTS5 MATCH expression
  type?: MemoryType | MemoryType[]
  project?: string
  status?: "active" | "archived" | "superseded"
  location?: "inbox" | "memory" | "archive" | "any"                   // default: "any"
  limit?: number                                                       // default 20, max 100
}
output: {
  results: Array<{
    id: string
    type: MemoryType
    title: string
    snippet: string                                                    // FTS5 snippet() with highlights
    score: number                                                      // BM25
    location: "inbox" | "memory" | "archive"
    path: string
    project: string | null
    tags: string[]
    updated: string
  }>
  total: number                                                        // before limit
}
```

Single SQL query. Filters apply as `WHERE` clauses on indexed columns; FTS5 MATCH on `title` + `body` + `tags`.

### 5.4 `memory_promote` (manual triage helper)

Without the hygiene daemon (Phase 3), every write lives in `inbox/` indefinitely. `memory_promote` lets the human or a trusted agent manually graduate a memory from `inbox/<type>/` to `memory/<type>/`.

```ts
input: {
  id: string
  reason?: string                      // optional, recorded in audit
}
output: {
  id: string
  from: string                         // old absolute path (in inbox)
  to: string                           // new absolute path (in memory)
}
```

**Behavior:**
1. Resolve current path; refuse if not in `inbox/`.
2. Re-validate the file against schema before move (catch any drift since write).
3. Atomic move: `renameSync(inbox/<type>/<id>.md, memory/<type>/<id>.md)`. Same-filesystem rename is a single atomic syscall on POSIX.
4. Audit line: `{op: "promote", id, from, to, reason}`.
5. Index `location` column updates via the chokidar reconcile path (unlink + add events on the moved file).

**Note:** `memory_promote` is a pure location change — frontmatter is **not** rewritten. The `updated` field tracks when content changed; promote is a triage event captured in the audit log, not a content edit.

**Errors:** `not_found`, `not_in_inbox`, `invalid_schema`, `promote_failed`.

### 5.5 Agent identity resolution

`agent` for any tool call is resolved as: `tool_arg.agent ?? mcp_session.clientInfo.name ?? config.default_agent ?? "unknown"`.

`session` is a server-generated ULID set once per MCP connection (not per call). Logged in audit. Stored in frontmatter for `write` and `promote`.

## 6. CLI subcommands

The same `vault-mem-mcp` binary takes a leading subcommand. With no subcommand it runs the MCP stdio server (the default mode).

### 6.1 `init`

```
vault-mem-mcp init [--target ~/vault-mem] [--git]
```

- Copies `vault-template/` to `--target`, refusing if the target is non-empty.
- Renames `_system/config.yaml.example` → `_system/config.yaml` and stamps a generated `vault_id` UUID.
- If `--git` is passed, runs `git init` and creates an initial commit.

### 6.2 `doctor`

```
vault-mem-mcp doctor [--vault <path>]
```

Validates startup invariants (Section 9.4) and prints a checklist with PASS/FAIL per item:

- Vault path exists and is a directory
- All required folders present
- All 7 type schemas + `_common.json` parse and compile under Ajv
- `_system/config.yaml` exists and validates
- FTS index opens cleanly; sample query succeeds
- Number of memories per location (inbox / memory / archive) matches index row counts
- Audit log file exists and is appendable

Exit code 0 on all-pass, 1 on any fail.

### 6.3 `reindex`

```
vault-mem-mcp reindex [--vault <path>]
```

Drops `_system/index.sqlite`, walks `inbox/`, `memory/`, `archive/`, parses every `.md`, and rebuilds the FTS index in a single transaction. Reports row count and elapsed time.

### 6.4 `tail-audit`

```
vault-mem-mcp tail-audit [--vault <path>] [-n 50] [--follow]
```

Tails `_system/audit.log` with each JSONL line pretty-printed. `--follow` watches for new lines (like `tail -f`). Useful for observing live agent activity during a Claude Code session.

## 7. Data flow

### 7.1 Write path (`memory_write`)

```
1. Receive tool call → tools/write.ts
2. Validate input shape against tool input schema (Ajv)
3. Resolve agent + session from MCP context
4. Generate id: mem_<YYYY-MM-DD>_<6 hex chars from randomBytes(3)>
   - Collision check: if id already exists, regenerate (vanishingly rare)
5. Build full frontmatter: input.fields + computed fields + type-specific defaults
6. Validate full frontmatter against _system/schema/<type>.json (Ajv)
   - On failure: error, no file written, no audit, no index change
7. Serialize via gray-matter stringify({frontmatter, content})
8. Atomic write to inbox/<type>/<id>.md (temp + fsync + rename + dir fsync)
9. Append audit JSONL: {ts, agent, session, op:"write", id, type, path, schema_version}
10. Insert into FTS index (synchronous SQL transaction)
11. Return {id, path, warnings}
```

**Failure semantics:**
- Step 8 fails → nothing committed.
- Step 9 fails after 8 → file exists but unaudited; surface as `warnings[]` entry. The file is the source of truth, audit is a log.
- Step 10 fails after 8/9 → file + audit recorded, index stale; log a warning. The chokidar watcher reconciles on its next tick.

### 7.2 Read path (`memory_read`)

```
1. tools/read.ts receives {id}
2. Look up id in FTS index → path + location
   - Fallback: scan inbox/<type>/, memory/<type>/, archive/ for <id>.md
3. Read file
4. gray-matter parse → {frontmatter, content}
5. Validate frontmatter against _system/schema/<type>.json
6. Append audit line: {ts, agent, session, op:"read", id}
7. Return {id, type, frontmatter, content, path, location}
```

### 7.3 Search path (`memory_search`)

```
1. tools/search.ts receives {query, type?, project?, status?, location?, limit?}
2. Build SQL with bind params:
   SELECT id, type, title, project, tags, updated, location, path,
          snippet(memories_fts, ...) AS snippet,
          bm25(memories_fts) AS score
   FROM memories_fts
   WHERE memories_fts MATCH :query
     AND (:type     IS NULL OR type     IN (:type_list))
     AND (:project  IS NULL OR project  = :project)
     AND (:status   IS NULL OR status   = :status)
     AND (:location IS NULL OR location IN (:loc_list))
   ORDER BY score
   LIMIT :limit
3. Execute synchronously (better-sqlite3)
4. Append audit line: {ts, agent, session, op:"search", query_hash, result_count}
   - Hash, not store, the query — avoids leaking sensitive search terms
5. Return {results, total}
```

### 7.4 Promote path (`memory_promote`)

```
1. tools/promote.ts receives {id, reason?}
2. Look up id; assert location == "inbox"
3. Read + parse + validate file (refuse promote if frontmatter is invalid)
4. Compute target: memory/<type>/<id>.md
5. renameSync(inboxPath, targetPath)   // single atomic syscall, same FS
6. Append audit: {op:"promote", id, from, to, reason, agent, session}
7. Watcher reconciles index location automatically (unlink event on inbox path,
   add event on memory path; row's location column updates accordingly)
8. Return {id, from, to}
```

The frontmatter is not modified. `updated` continues to mean "when content last changed".

### 7.5 File watcher (chokidar)

Runs continuously alongside the server. Watches `inbox/`, `memory/`, `archive/` for `.md` add/change/unlink, debounced 200ms per file:

- **Add or change** → re-parse, re-validate, FTS upsert.
- **Unlink** → FTS delete by path.
- **Move** (e.g., promote, future daemon archive) → unlink + add events; the row's `location` column reflects the new prefix.

This handles three cases for free:
1. Obsidian edits (you fix a typo by hand).
2. Daemon promotions / archives in later phases.
3. Self-healing when synchronous FTS insert in step 10 of the write path fails.

## 8. Storage

### 8.1 Atomic write (`vault/atomicWrite.ts`)

```
write(absPath, contents):
  tmp = `${absPath}.tmp.${pid}.${randHex(8)}`
  fd  = openSync(tmp, 'w')
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(tmp, absPath)             // atomic on POSIX, same filesystem
  fsyncDirSync(dirname(absPath))
```

The temp suffix includes pid + random bytes so two concurrent writes never collide on the temp path.

### 8.2 Locking

- **Per-file advisory locks** via `proper-lockfile` around `memory_write` and `memory_promote`. Locks the destination path; concurrent writes to the same `id` serialize.
- **No global vault lock.** Reads never lock. SQLite WAL mode provides reader/writer concurrency on the index.
- **Obsidian edits are unlocked.** The watcher reconciles them. If the user happens to be editing a file at the instant the server writes to it, the rename wins atomically and Obsidian reloads from disk (its default).

The Python keeper (Phase 3) will honor the same lock-file conventions via `filelock`.

### 8.3 Audit log format (`_system/audit.log`)

Append-only JSONL, one operation per line:

```json
{"ts":"2026-04-27T14:32:00.123+05:30","v":1,"op":"write","agent":"claude-code","session":"01HX...","id":"mem_2026-04-27_a8f3","type":"decision","path":"inbox/decisions/mem_2026-04-27_a8f3.md","schema_version":"0.1"}
{"ts":"2026-04-27T14:33:01.045+05:30","v":1,"op":"read","agent":"cursor","session":"01HY...","id":"mem_2026-04-27_a8f3"}
{"ts":"2026-04-27T14:33:15.789+05:30","v":1,"op":"search","agent":"claude-code","session":"01HX...","query_hash":"sha256:...","result_count":4}
{"ts":"2026-04-27T15:02:45.612+05:30","v":1,"op":"promote","agent":"human","session":"01HZ...","id":"mem_2026-04-27_a8f3","from":"inbox/decisions/mem_2026-04-27_a8f3.md","to":"memory/decisions/mem_2026-04-27_a8f3.md","reason":"reviewed"}
```

- `v: 1` is the audit format version.
- `query_hash` (SHA-256 of the query string) — never the raw query — to avoid leaking sensitive search terms into a permanent log.
- Writes use `appendFileSync` with `{flag: 'a'}`. POSIX guarantees atomic line-level appends ≤4096 bytes; our lines are well under.
- No rotation in v0.1. Projected ~50 ops/day × ~300 bytes = ~15 KB/day = ~5 MB/year. Acceptable.

### 8.4 FTS5 index (`_system/index.sqlite`)

**Schema:**

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  title,
  body,
  tags,
  project UNINDEXED,
  status UNINDEXED,
  location UNINDEXED,
  path UNINDEXED,
  updated UNINDEXED,
  tokenize='porter unicode61'
);

PRAGMA user_version = 1;  -- index schema version
```

`UNINDEXED` columns are stored on the same row but not full-text-indexed; they are filter and return fields. Searchable surface: `title`, `body`, `tags`. BM25 weights are default; tunable later if title matches need to rank higher.

**Lifecycle:**

- **Open on startup.** If the file is missing or `config.fts.rebuild_on_startup: true`, walk the vault and batch-insert in one transaction.
- **Incremental during runtime.** Each `memory_write` does a synchronous `INSERT`. Chokidar handles external edits and promotes via upsert/delete.
- **Schema migrations.** `PRAGMA user_version` tracks the index schema version. On startup, if the on-disk version is older than the code expects, drop and rebuild. Cheap and correct.
- **Corruption recovery.** Any SQLite error on open → log, drop the file, rebuild. The index is never authoritative; the `.md` files are.

## 9. Configuration & startup

### 9.1 Server-level configuration

| Source | Variable | Default |
|---|---|---|
| CLI flag | `--vault <path>` | — |
| Env var | `VAULT_MEM_PATH` | `~/vault-mem/` |
| CLI flag | `--log-level <level>` | — |
| Env var | `VAULT_MEM_LOG_LEVEL` | `info` |

CLI flag overrides env; env overrides default.

### 9.2 Vault-level configuration (`_system/config.yaml`)

Fields per Section 4.4. Loaded once at startup; no hot reload. Restart the server to pick up changes.

### 9.3 Logging

- `pino`, output to **stderr** (stdout is reserved for MCP protocol over stdio).
- Pretty in dev (`NODE_ENV !== "production"`), JSON otherwise.
- Per-tool-call correlation id included in every log line related to that call.

### 9.4 Startup invariants

The server refuses to start if any of these fail:

1. Vault path resolves to an existing directory.
2. `_system/schema/_common.json` exists and parses.
3. All 7 type-specific schemas exist and compile under Ajv.
4. `_system/config.yaml` exists and validates.

If any of 1–4 fail, the server prints a clear remediation hint pointing at `vault-mem-mcp init` and exits with code 2.

Required folders (`memory/<7-types>/`, `inbox/<7-types>/`, `archive/`, `_system/`) are created idempotently if missing — not a fatal condition.

## 10. Error handling

Three error categories with clean MCP mappings:

1. **User errors** — bad input shape, schema validation failure, unknown id, promote-from-non-inbox. Returned as a structured tool error: `{ kind: "schema_validation_failed", details: [...Ajv errors] }`. Logged at `debug` only.
2. **Vault errors** — file system issues (permissions, disk full, missing schemas at startup). Logged at `error`. Returned as `{ kind: "vault_error", message }`. Server keeps running; never crashes on a per-call failure.
3. **Bugs** — anything uncaught. A wrapper at the tool boundary catches, logs at `error` with stack and a correlation id, and returns `{ kind: "internal_error", correlation_id }`. An audit line `op:"<op>:failed"` is still appended so attempted-but-failed writes are visible after the fact.

The server only crashes on startup invariant failures (Section 9.4) — those are explicit and actionable.

## 11. Testing strategy

**Framework:** Vitest. `pnpm test` (single run) and `pnpm test --watch` (dev).

**Three layers:**

1. **Unit (most code, fast).** Pure modules: `id`, `schema`, `audit`, `vault/atomicWrite` (with a tmp dir per test), `index` (with `:memory:` SQLite). No MCP SDK involved.
2. **Integration (per tool).** For each of the 4 tools, spin up a fresh tmp vault from `vault-template/`, exercise the handler directly (not through MCP transport), assert on disk state + audit log + index. This is the layer that catches "I broke the write protocol" bugs and exercises every error category.
3. **End-to-end (one smoke test).** Start the server with stdio transport, send actual MCP `initialize` + `tools/call` messages via the MCP SDK's test client, assert one happy-path round-trip per tool. Guards against SDK wiring breakage. Kept minimal because the value-vs-cost is in the integration layer.

**Fixtures:** the `vault-template/` directory doubles as the test fixture. Tests `cp -R` it to a temp dir per integration test. Real and test layouts stay identical — no drift.

**No formal coverage targets.** The integration layer is required to hit every error category in Section 10.

## 12. Acceptance criteria

This phase is **done** when all of the following hold:

1. `pnpm install` from the repo root sets up the workspace cleanly.
2. `pnpm --filter mcp build` produces a working binary at `packages/mcp/bin/vault-mem-mcp`.
3. `pnpm --filter mcp test` passes all unit, integration, and e2e tests.
4. `vault-mem-mcp init --target /tmp/test-vault --git` produces a valid vault that opens cleanly in Obsidian.
5. `vault-mem-mcp doctor --vault /tmp/test-vault` reports all-pass.
6. The MCP server is registered in Claude Code's MCP config and a real Claude Code session can:
   a. Call `memory_write` to record a decision; the file appears in `inbox/decisions/` and is schema-valid.
   b. Call `memory_search` and find that decision.
   c. Call `memory_read` by id and get the full frontmatter + content back.
   d. Call `memory_promote` to move it to `memory/decisions/`; subsequent searches reflect the new location.
7. `vault-mem-mcp tail-audit --follow` shows audit lines appearing in real time during the session above.
8. After all of the above, opening the vault in Obsidian shows the memories as readable, well-formatted markdown — no manual cleanup needed.

When 1–8 hold, Phase 1 is shipped and the next planning cycle (Phase 2 — embeddings) can begin.

---

**Appendix A — Dependencies (proposed)**

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server + transports |
| `ajv` + `ajv-formats` | JSON Schema validation |
| `better-sqlite3` | SQLite (FTS5 enabled) |
| `chokidar` | File watcher |
| `gray-matter` | Frontmatter parse / serialize |
| `proper-lockfile` | Per-file advisory locks |
| `pino` (+ `pino-pretty` in dev) | Structured logging |
| `ulid` | Session IDs |
| `yaml` | Vault config parsing |
| `commander` | CLI subcommand routing |
| `vitest` (dev) | Test runner |
| `tsx` (dev) | TS dev runner |
| `typescript` (dev) | Compiler |

Pinning, exact versions, and any audit-flagged transitive deps are decided at implementation time.
