# Vault-Mem Phase 3 — Hygiene Daemon (Keeper) Design

**Status:** Draft for implementation
**Date:** 2026-04-28
**Owner:** the maintainer
**PRD:** [`vault-mem-prd.md`](../../../vault-mem-prd.md) §8 Phase 3, §5.2
**Phase 1 spec:** [`2026-04-27-vault-mem-mcp-design.md`](2026-04-27-vault-mem-mcp-design.md)
**Phase 2 spec:** [`2026-04-27-vault-mem-phase-2-design.md`](2026-04-27-vault-mem-phase-2-design.md)
**Branch base:** `main` (post Phase 2 merge `9ffa1c3`)

---

## 1. Context & purpose

Phase 1 shipped a working MCP server with FTS5 + 4 tools. Phase 2 added local embeddings, LanceDB, hybrid semantic search, and `memory.context`. Phase 3 adds the **hygiene daemon** — a Python script that runs every 30 min via `launchd`, performs autonomous coherence operations on the vault, and exits.

PRD Phase 3 v0.1 covers four operations:

1. **Inbox triage** — promote agent-written memories from `inbox/<type>/` to `memory/<type>/` once they're stable enough.
2. **Auto-linking** — for each canonical memory, compute top-K semantic neighbors and write to `_system/links.jsonl`.
3. **Confidence decay** — erode `confidence` over time per type, with the `last_decay_at` field recording boundaries.
4. **Archive** — move memories to `archive/` when TTL expires or confidence falls below a floor.

Done-when (PRD §8): *"Vault stays coherent without my intervention for 2 weeks."*

After Phase 3 ships, Phase 4 (Telegram approval gate) and Phase 5 (Sonnet contradiction engine + summarization) follow. Phase 3 deliberately operates on **non-destructive or trivially-reversible ops only** — every file mutation has a clear reverse path through audit.

## 2. Scope

**In scope:**
- New monorepo subpackage `packages/keeper/` (Python 3.12+, `uv`-managed).
- Stateless `python -m vault_mem_keeper run` entry point invoked by `launchd` every 30 min.
- Four operations: triage, link, decay, archive.
- `--dry-run` flag.
- Status and doctor subcommands.
- launchd plist template at `ops/keeper/com.vaultmem.keeper.plist`.
- Extension of `_system/config.yaml` with a `keeper:` section.
- Audit log integration (writes with `agent: "keeper"` to the same `_system/audit.log`).
- TS-side `AuditEntry` union extension to type-check the new `op` values.
- vault `_system/links.jsonl` file format.

**Out of scope** (Phase 4 / 5 / never):
- Telegram approval gate (Phase 4).
- Dedupe / merge memories (Phase 4 — destructive ops require Telegram).
- Contradiction detection (Phase 5).
- Summarization (Phase 5).
- Daemon-side writes to FTS/Lance indexes (relies on MCP server's chokidar watcher to reconcile).
- Cross-platform install (Linux/systemd deferred).
- Web UI / GUI for run preview.
- Retry-with-backoff (next 30-min tick is the retry).
- Concurrent op execution within a run.
- Reinforcement on edit (decay continues unless user bumps `confidence` explicitly).
- Multi-vault per daemon instance.

## 3. Architecture overview

### 3.1 Process model

- **Scheduler:** macOS `launchd` plist runs `python -m vault_mem_keeper run` every 30 min via `StartInterval = 1800`. The plist file is committed at `ops/keeper/com.vaultmem.keeper.plist` as a template; the user copies it to `~/Library/LaunchAgents/` and runs `launchctl load -w`. **Alternative for users on pm2:** documented in the keeper README — `pm2 start ./bin/run-keeper.sh --cron-restart "*/30 * * * *" --no-autorestart`.
- **Stateless invocation.** Each run opens fresh handles to the vault's SQLite + LanceDB, processes, closes, exits. Failure recovery is automatic on the next tick.
- **No persistent process.** No memory across runs; all state lives on disk.

### 3.2 Vault access pattern: direct file/DB

The daemon reads and writes the vault directly:

- `.md` files via `python-frontmatter` + atomic temp+rename writes
- FTS index via `sqlite3` standard library (read-only `mode=ro` URI)
- LanceDB via the official `lancedb` PyPI client (read-only queries; no writes — the MCP server owns Lance writes)
- Audit log via append-only JSONL writes (matching the TS `Auditor.write` shape exactly)

**Indexes go briefly stale** after a daemon run (file moves, frontmatter rewrites) until the MCP server's chokidar watcher reconciles them on its next event. This is an acceptable v0.1 trade-off — the audit log is authoritative, and `doctor`'s `row_count_match` check tolerates the gap (it's already designed to skip when either count is 0; minor mismatch after a keeper run resolves itself within seconds of the MCP server's next event).

### 3.3 Repo layout

```
vault-mem/
├── packages/
│   ├── mcp/                              # Phase 1+2 (TypeScript) — unchanged
│   └── keeper/                           # NEW (Phase 3, Python)
│       ├── pyproject.toml                # uv-managed deps
│       ├── uv.lock
│       ├── README.md
│       ├── src/vault_mem_keeper/
│       │   ├── __init__.py
│       │   ├── __main__.py                # CLI entry: run | status | doctor
│       │   ├── config.py
│       │   ├── paths.py                   # mirror of TS vault/paths.ts
│       │   ├── frontmatter.py             # YAML I/O + JSON Schema validation
│       │   ├── atomic_write.py            # temp + fsync + rename
│       │   ├── audit.py                   # JSONL append
│       │   ├── fts.py                     # SQLite read-only
│       │   ├── lance.py                   # LanceDB queries
│       │   ├── ops/
│       │   │   ├── __init__.py
│       │   │   ├── triage.py
│       │   │   ├── link.py
│       │   │   ├── decay.py
│       │   │   └── archive.py
│       │   ├── runner.py                  # orchestrates a full pass
│       │   └── logging.py
│       └── tests/
└── ops/
    └── keeper/
        └── com.vaultmem.keeper.plist      # launchd template
```

**Module size targets:** every module ≤200 LOC, single responsibility. The `ops/` modules each take a `paths`, `config`, `schemas`, `audit`, `dry_run`, `run_id` and produce an `OpReport`.

### 3.4 The TS-side change

The MCP server gains zero new tools. The only TS change is widening `AuditEntry` (in `packages/mcp/src/audit/index.ts`) to include the new `op` values produced by the keeper, so type-checking remains strict on the audit log readers (`tail-audit` etc.). The runtime accepts these without changes — the auditor's `appendFileSync` is shape-agnostic.

## 4. Operations

### 4.1 Inbox triage (`ops/triage.py`)

**Goal:** move `inbox/<type>/<id>.md` → `memory/<type>/<id>.md` once stable.

**Config (in `_system/config.yaml`):**
```yaml
keeper:
  triage:
    enabled: true
    min_age_minutes: 1440                              # 24h grace for human edit
    min_confidence: 0.7                                # below this, never auto-promote
    promote_immediately_if_human_reviewed: true
```

**Algorithm per run:**

```
For each .md in inbox/<type>/:
  1. Parse frontmatter; if invalid against schema → skip + warn.
  2. If status != "active" → skip.
  3. If confidence < min_confidence → skip.
  4. If human_reviewed == true and promote_immediately_if_human_reviewed → promote.
  5. Else if (now - max(created, updated)) < min_age_minutes → skip.
  6. Else → promote.

promote(id):
  src = inbox/<type>/<id>.md
  dst = memory/<type>/<id>.md
  os.makedirs(dirname(dst), exist_ok=True)
  os.rename(src, dst)
  audit.write({op: "promote", agent: "keeper", session: run_id, id, from: src, to: dst, reason: "auto"})
```

**Idempotency:** post-promote the source no longer exists; subsequent runs skip naturally. Crash mid-rename leaves either source or destination intact (POSIX rename atomicity).

### 4.2 Auto-link (`ops/link.py`)

**Goal:** for each canonical memory, write top-K semantic neighbors to `_system/links.jsonl`.

**Config:**
```yaml
keeper:
  link:
    enabled: true
    top_k: 5
    min_similarity: 0.55
    cross_type_allowed: true
    rebuild_full_each_run: true
```

**Algorithm:**

```
1. Open Lance read-only.
2. List all memories where location == "memory" via FTS list().
3. For each memory M:
     read its vector from Lance (lance.get_by_id(M.id))
     candidates = lance.search(vec, filter: {status:"active", location:"memory"}, limit: top_k+1)
     drop the candidate whose id == M.id (self-match — id-based, NOT score-based)
     filter by min_similarity
     filter by cross_type_allowed
     keep top top_k
     emit row: {v:1, from: M.id, to: c.id, score, computed_at, embed_model, run_id}
4. Atomic temp+rename write to _system/links.jsonl.
5. audit.write({op: "link_rebuild", agent: "keeper", session: run_id, count, embed_model})
```

**`links.jsonl` format (one JSON object per line):**

```json
{"v":1,"from":"mem_2026-04-27_a8f3c0","to":"mem_2026-04-25_b1e9aa","score":0.81,"computed_at":"2026-04-28T03:00:00.000Z","embed_model":"Xenova/all-MiniLM-L6-v2:int8","run_id":"01KQAB..."}
```

**Idempotency:** file is rewritten in full on every run. Cost: O(N) Lance queries; <1s for vault sizes <5k.

### 4.3 Confidence decay (`ops/decay.py`)

**Goal:** erode `confidence` per type over time, preserving partial-period progress via `last_decay_at`.

**Config:**
```yaml
keeper:
  decay:
    enabled: true
    rates:                                  # period in days; null = no decay
      decision: null
      observation: 30
      learning: 60
      todo: null
      summary: null
      entity: null
      question: null
    decay_amount_per_period: 0.05
```

**Algorithm:**

```
For each memory in memory/<type>/<id>.md:
  if rates[type] is None → skip
  last_decay_at = frontmatter.get("last_decay_at", frontmatter["updated"])
  elapsed_days = (now - last_decay_at).days
  periods = elapsed_days // rates[type]      # integer floor
  if periods == 0 → skip
  delta = -periods * decay_amount_per_period
  new_confidence = max(0.0, confidence + delta)
  if abs(new_confidence - confidence) < 0.001 → skip (already at floor)
  rewrite frontmatter atomically:
    confidence = new_confidence
    last_decay_at = last_decay_at + timedelta(days = periods * rates[type])
  audit.write({op: "decay", agent: "keeper", session: run_id, id, from_confidence, to_confidence, delta, periods})
```

**Why `last_decay_at` advances by completed periods, not "now":** preserves partial-period progress across long downtimes. If decay was last applied at day 30 and the next run is day 35, only 1 period has elapsed (30→60 boundary not crossed). `last_decay_at` advances by 30 days, so 5 days of progress carry forward to the next decay tick.

**Reinforcement semantics:** content edits (which bump `updated`) do **not** reset `last_decay_at`. The user must explicitly raise `confidence` to "reinforce" a memory.

### 4.4 Archive (`ops/archive.py`)

**Goal:** move memories that are TTL-expired or below the confidence floor from `memory/<type>/` to `archive/`.

**Config:**
```yaml
keeper:
  archive:
    enabled: true
    archive_below_confidence: 0.3
    respect_ttl_days: true
```

**Algorithm:**

```
For each memory in memory/<type>/<id>.md:
  reasons = []
  if memory.ttl_days is not null and respect_ttl_days:
    expiry = max(created, updated) + ttl_days
    if now >= expiry: reasons.append("ttl_expired")
  if memory.confidence < archive_below_confidence:
    reasons.append("low_confidence")
  if reasons:
    rewrite frontmatter atomically: status = "archived"
    src = memory/<type>/<id>.md
    dst = archive/<id>.md       # archive layout: flat, no type subfolders (Phase 1 design)
    os.rename(src, dst)
    audit.write({op: "archive", agent: "keeper", session: run_id, id, from, to, reasons})
```

**Idempotency:** source no longer exists post-archive. Archive `.md` keeps full frontmatter (with `status: "archived"`). The TS `memory.read` tool's archive disk-fallback handles them.

## 5. Run orchestration (`runner.py`)

```python
def run(opts) -> RunReport:
    config = load_config(opts.vault)         # validates _system/config.yaml + keeper section
    schemas = load_schemas(opts.vault)
    audit = Auditor(paths.audit_log)
    run_id = ulid()                           # one ULID per run, attached to every audit line

    ops = opts.ops or DEFAULT_ORDER          # default: triage → link → decay → archive
    # ordering matters:
    #   triage before link (promoted memories appear in canonical for linking)
    #   decay before archive (newly-decayed below-floor memories archive same run)

    report = RunReport(run_id=run_id, started_at=now(), ops={})
    for name in ops:
        if not config.keeper[name].enabled:
            report.ops[name] = OpReport(skipped=True, reason="disabled")
            continue
        try:
            report.ops[name] = OPS[name](paths, config, schemas, audit, dry_run=opts.dry_run, run_id=run_id)
        except Exception as e:
            log.exception(f"keeper op {name} failed")
            report.ops[name] = OpReport(error=str(e))
            # continue to next op — one failure shouldn't block others

    audit.write({"op": "keeper_run", "agent": "keeper", "session": run_id,
                 "duration_ms": elapsed_ms,
                 "summary": {n: counts for n, counts in report.ops.items()}})
    return report
```

**Output (non-dry-run):**

```
keeper run 01KQAB...  started 2026-04-28T03:00:00Z  vault=/Users/REPLACE_USER/vault-mem
  triage   : promoted 2 / skipped 4 / errors 0
  link     : rebuilt links.jsonl with 47 rows across 12 memories
  decay    : decayed 6 observations (avg delta -0.05) / skipped 8
  archive  : archived 1 (reasons: ttl_expired)
  total    : 234 ms
```

**Output (dry-run):** same shape, each line prefixed with `[dry-run]`, plus a per-op listing of intended actions (`would promote mem_2026-04-27_aaaaaa`, etc.). No file mutations, no audit appends, no `links.jsonl` rewrite.

## 6. Audit format compatibility

Keeper writes to the **same `_system/audit.log`** as the TS server. JSONL shape unchanged. New `op` values (with `agent: "keeper"`):

| Op | Fields beyond ts/v/op/agent/session |
|---|---|
| `promote` | `id`, `from`, `to`, `reason: "auto"` |
| `link_rebuild` | `count`, `embed_model` |
| `decay` | `id`, `from_confidence`, `to_confidence`, `delta`, `periods` |
| `archive` | `id`, `from`, `to`, `reasons: [...]` |
| `keeper_run` | `duration_ms`, `summary: {triage: {...}, link: {...}, ...}` |

The TS `AuditEntry` union (in `packages/mcp/src/audit/index.ts`) is widened to include these as additional union members, so `tail-audit` and any future audit-querying code stays type-strict.

## 7. Configuration

The `keeper:` section is added to `_system/config.yaml`. The `init` CLI's bundled `vault-template/_system/config.yaml.example` gets the new section as defaults. Existing vaults continue to work because the keeper validates with reasonable defaults if a section is missing — but a bare `keeper:` block (with `enabled: false` everywhere) is added during a future config migration.

**Default `keeper:` section in `vault-template/_system/config.yaml.example`:**

```yaml
keeper:
  triage:
    enabled: true
    min_age_minutes: 1440
    min_confidence: 0.7
    promote_immediately_if_human_reviewed: true
  link:
    enabled: true
    top_k: 5
    min_similarity: 0.55
    cross_type_allowed: true
    rebuild_full_each_run: true
  decay:
    enabled: true
    rates:
      decision: null
      observation: 30
      learning: 60
      todo: null
      summary: null
      entity: null
      question: null
    decay_amount_per_period: 0.05
  archive:
    enabled: true
    archive_below_confidence: 0.3
    respect_ttl_days: true
```

The keeper's `config.py` validates the section against a Python `pydantic` (or `dataclasses` + `jsonschema`) model. Strategy: use `pydantic` v2 since it's the de-facto Python validation library and gives clean error messages. Adds one dep.

**TS-side awareness:** the existing TS config validator does not need to know about the `keeper:` section — Phase 1's `loadConfig` in `packages/mcp/src/config/index.ts` validates only the fields it cares about. Extra keys are tolerated (they pass the existing Ajv config schema's `additionalProperties: true` default behavior at the top level). Verify and adjust if needed in implementation.

## 8. Storage

### 8.1 New: `_system/links.jsonl`

JSONL, one row per `(from, to)` directed link. Format described in §4.2. Rewritten in full on every link run (atomic temp+rename). Gitignored:

```
_system/links.jsonl
```

(Append to `vault-template/.gitignore`.)

### 8.2 New frontmatter field: `last_decay_at`

Phase 1's schema additivity rule (in `vault-template/_system/schema/_common.json`) holds: new optional fields are allowed. Add `last_decay_at` as an optional ISO 8601 string. Update the schema:

```json
{
  ...
  "properties": {
    ...
    "last_decay_at": { "type": "string", "format": "date-time" }
  }
}
```

`last_decay_at` is optional. Memories that have never been decayed (or whose type has `null` decay rate) simply don't have it. The decay op falls back to `updated` if missing.

### 8.3 frontmatter field: `auto_links` is NOT added

Per Section 2.2 (B) decision: auto-links live in `links.jsonl`, not in memory frontmatter. No schema change for this.

### 8.4 Audit log

Same file `_system/audit.log`. Same JSONL format. New `op` values appended.

## 9. Error handling

Three categories:

1. **Per-memory** (schema fail, file missing, frontmatter unparseable) → `WARN` log + increment op `errors` counter + continue. Run completes; the memory shows up next time too.
2. **Per-op** (Lance can't open, SQLite locked, disk full) → `ERROR` log + op marked `errored` in the report + next op proceeds. No partial state — atomic writes guarantee.
3. **Run-level** (config invalid, vault path missing) → `ERROR` log + exit non-zero. launchd records failure in its log; next 30-min tick retries.

**No partial state.** Every file mutation is atomic temp+rename. Crash mid-op = at most one memory not yet processed.

## 10. Testing strategy

### 10.1 Unit (per module)

- `paths`, `frontmatter`, `atomic_write`, `audit` — pure functions / I/O on tmp dirs. Test fixtures cross-validate against the TS counterparts.
- `fts.list/search` — open `:memory:` SQLite, FTS5 schema, assert query shapes.
- `lance` — open a tmp Lance dir, upsert known vectors, assert nearest-neighbor returns expected ids.
- `config` — pydantic model validation against fixture YAML.

### 10.2 Integration (per op, against tmpVault)

- `triage`: build a vault with N memories at varied ages and confidences, run triage, assert which moved.
- `link`: build a vault with 5 memories using deterministic seed vectors, run link, assert `links.jsonl` content.
- `decay`: build memories with explicit `last_decay_at` and `confidence`, simulate elapsed time, assert frontmatter updates.
- `archive`: build memories at TTL boundary and below confidence floor, assert correct ones move to `archive/`.

### 10.3 End-to-end

- One pytest test that:
  - Initializes a vault using the existing TS `init` CLI (subprocess invocation).
  - Seeds memories via `memory.write` (subprocess invocation).
  - Runs the keeper non-dry-run.
  - Asserts the expected file system mutations occurred.
  - Re-runs `vault-mem-mcp doctor` and asserts ≥9 PASS lines (or notes which counts went stale).

- One dry-run test that asserts no file mutations after running keeper.

### 10.4 What's not tested

- Exact ULID values, audit timestamp values, run-id text.
- launchd plist itself — it's config; smoke-test by `launchctl load` manually.
- Snapshot byte-level content of `links.jsonl` (timestamps vary).

## 11. Acceptance criteria

This phase ships when:

1. `cd packages/keeper && uv sync` installs cleanly.
2. `uv run python -m vault_mem_keeper run --vault /tmp/test-vault --dry-run` on a freshly-init'd test vault completes in <2s with a per-op summary, no errors.
3. `uv run pytest` passes all unit + integration + e2e tests.
4. After running keeper non-dry-run on a test vault with seeded inputs:
   - Promoted memories exist in `memory/<type>/`.
   - `_system/links.jsonl` exists and contains expected rows.
   - Decayed memories have lower `confidence` and updated `last_decay_at`.
   - Archived memories exist in `archive/`.
5. The TS `tail-audit` displays keeper entries (`agent: "keeper"`) cleanly mixed with mcp entries.
6. `launchctl load -w ~/Library/LaunchAgents/com.vaultmem.keeper.plist` installs the daemon. `launchctl start com.vaultmem.keeper` triggers a real run that succeeds.
7. **Live test:** seed `~/vault-mem/` with a memory `confidence: 0.3, ttl_days: 1, created: <yesterday>`. Trigger keeper. Confirm the memory moves to `archive/` and the audit log records the action.
8. **Long-term gate (post-merge, human-observed):** vault stays coherent for 14 days without manual triage.

When 1–7 hold, Phase 3 v0.1 is ready to merge. Gate 8 is the soak test the user runs.

---

## Appendix A — Python dependencies

| Package | Purpose |
|---|---|
| `python-frontmatter` | YAML frontmatter I/O for memory `.md` files |
| `pyyaml` | (transitive via python-frontmatter) |
| `jsonschema` | JSON Schema draft-07 validation against `_system/schema/*.json` |
| `pydantic` | Validate the `keeper:` section of `config.yaml` |
| `lancedb` | LanceDB Python client (read-only queries) |
| `structlog` | Structured logging |
| `python-ulid` | ULID generation for run_id |
| `pytest` (dev) | Test runner |
| `pytest-asyncio` (dev) | If any LanceDB calls are async |
| `ruff` (dev) | Lint + format |

Versions pinned in `pyproject.toml` at implementation time.

## Appendix B — launchd plist template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.vaultmem.keeper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/REPLACE_USER/.local/bin/uv</string>
    <string>run</string>
    <string>--directory</string>
    <string>/Users/REPLACE_USER/path/to/vault-mem/packages/keeper</string>
    <string>python</string>
    <string>-m</string>
    <string>vault_mem_keeper</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VAULT_MEM_PATH</key> <string>/Users/REPLACE_USER/vault-mem</string>
  </dict>
  <key>StartInterval</key>    <integer>1800</integer>
  <key>StandardErrorPath</key><string>/Users/REPLACE_USER/Library/Logs/vault-mem-keeper.err.log</string>
  <key>StandardOutPath</key>  <string>/Users/REPLACE_USER/Library/Logs/vault-mem-keeper.out.log</string>
  <key>RunAtLoad</key>        <false/>
</dict>
</plist>
```

The user customizes the absolute paths (`uv` location, repo location, vault location, log paths) before installing. Documented in `packages/keeper/README.md`.

## Appendix C — Schema additivity (carries from Phase 1+2)

The Phase 1 rule still holds. Phase 3 adds **one optional field** to `_common.json`: `last_decay_at: string (date-time)`. Optional → no migration of existing memories needed. The keeper's `decay` op tolerates missing `last_decay_at` by falling back to `updated`.

## Appendix D — Why the daemon doesn't write to FTS/Lance directly

The MCP server's chokidar watcher is the canonical source-of-truth for index reconciliation. When the keeper moves a file or rewrites frontmatter, the watcher (running inside the MCP server) sees the file event and updates both indexes. Two consequences:

1. **The indexes are briefly stale** between a keeper run and the MCP server's next chokidar event. If the MCP server isn't running at all, indexes stay stale until it's launched again. The `doctor`'s `row_count_match` check tolerates this (skipped when either count is 0; transient mismatch resolves quickly).
2. **The keeper doesn't duplicate the embedder.** It would be a real liability — the TS embedder uses `@xenova/transformers` (ONNX in WASM); the Python equivalent would be `sentence-transformers` (Python). Same model, different runtimes, with subtle byte-different vectors. By having the daemon delegate index updates entirely to the MCP server, we sidestep this entirely.

Trade-off: if the user runs the keeper without ever running the MCP server, the FTS and Lance indexes degrade over time as keeper-induced file moves accumulate. Mitigation: `doctor` flags the mismatch on next MCP server start; `reindex` rebuilds. Phase 3 acceptance criterion #6 implicitly assumes the MCP server runs at least occasionally during the 14-day soak test.
