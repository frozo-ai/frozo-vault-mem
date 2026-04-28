# Vault-Mem Phase 2 — Embedding Index & Semantic Search Design

**Status:** Draft for implementation
**Date:** 2026-04-27
**Owner:** the maintainer
**PRD:** [`vault-mem-prd.md`](../../../vault-mem-prd.md) §8 Phase 2
**Phase 1 spec:** [`2026-04-27-vault-mem-mcp-design.md`](2026-04-27-vault-mem-mcp-design.md)
**Branch base:** `main` (post Phase 1 merge `e35cfb5`)

---

## 1. Context & purpose

Phase 1 shipped a working MCP server with FTS5 keyword search. Phase 2 adds:

- A local embedding pipeline using `@xenova/transformers` running ONNX-quantized `all-MiniLM-L6-v2` in the existing Node process (no Python dependency).
- A LanceDB vector index parallel to the FTS5 index.
- A new `mode: "fts" | "semantic" | "hybrid"` parameter on `memory_search` (default `hybrid`, using Reciprocal Rank Fusion).
- A new `memory_context(project, max_tokens, query?)` tool that returns curated context for a project — summary-led when no query, semantic-led when query supplied.

The Phase 2 "done when" gate (PRD §8): *"Semantic search finds relevant memories I didn't explicitly mention."*

After Phase 2 ships, Phase 3 (Python hygiene daemon) gets started. Phase 3's auto-linking and decay logic depend on the vector index produced here.

## 2. Scope

**In scope:**
- New module `src/embedder/` with lazy-loaded Transformers.js pipeline.
- New module `src/index/lance.ts` mirroring the Phase 1 `IndexHandle` shape for LanceDB.
- New module `src/index/hybrid.ts` implementing Reciprocal Rank Fusion.
- New tool `memory_context`.
- Extension of `memory_search` with `mode` parameter (default `hybrid`).
- Extension of `memory_write` to also embed + Lance upsert synchronously.
- Extension of the chokidar watcher to also embed + Lance upsert on file events.
- Extension of `populate` to batch-embed during initial vault scan.
- Extension of `reindex` CLI to drop and rebuild both indexes.
- Extension of `doctor` CLI to add `embeddings_index` and `embeddings_count_match` checks.
- Vault `.gitignore` extended for `_system/embeddings.lance/`.

**Out of scope** (Phase 3+ or never):
- Hygiene daemon (auto-linking, decay, contradiction detection, summarization).
- ANN indexes (HNSW/IVF-PQ).
- Larger embedding models, multi-vector per memory, chunking, cross-encoder reranking.
- Embedding-path config field (hardcoded under `_system/`).
- Lance index management commands (build/optimize).
- Online learning / fine-tuning.

## 3. Architecture overview

### 3.1 Process model

Single Node process. No new sub-processes.

- Embedder model loads **lazily** on first call — first write/search after server start pays ~1–2s (cold HF cache) or ~300ms (warm cache). Subsequent calls reuse the cached pipeline.
- LanceDB connection opens on server start (parallel to the SQLite connection), closes on shutdown.

### 3.2 Module layout (extension of Phase 1)

```
packages/mcp/src/
├── embedder/
│   └── index.ts            # NEW: lazy-load + embed(text) + embedBatch(texts)
├── index/
│   ├── sqlite.ts           # Phase 1: FTS5 (unchanged)
│   ├── lance.ts            # NEW: vector index — open/upsert/delete/getById/search/rebuild/count/close
│   ├── hybrid.ts           # NEW: rrfMerge(ftsResults, semResults, k, limit)
│   ├── populate.ts         # extended: also batches Lance upserts
│   └── watcher.ts          # extended: also upserts Lance on reconcile
├── tools/
│   ├── search.ts           # extended: mode param, dispatches FTS/semantic/hybrid
│   ├── context.ts          # NEW
│   ├── write.ts            # extended: embed + Lance upsert sync
│   └── promote.ts          # extended: in-place Lance metadata update
└── cli/
    ├── reindex.ts          # extended: drops + rebuilds both indexes
    └── doctor.ts           # extended: 2 new checks (9 total)
```

### 3.3 Vault layout addition

```
<vault>/_system/
├── audit.log
├── config.yaml
├── index.sqlite          # Phase 1 FTS5
└── embeddings.lance/     # NEW (gitignored)
    └── memories.lance    # the Lance table
```

`<vault>/.gitignore` extended:
```
_system/embeddings.lance/
```

## 4. Embedding pipeline

### 4.1 Model

- **Identifier:** `Xenova/all-MiniLM-L6-v2` from HuggingFace Hub.
- **Format:** ONNX, int8-quantized (~22 MB download). Cosine similarity is bit-equivalent to FP32 sentence-transformers for sentence-length text (quantization noise at ~1e-4 magnitude, well below cosine's discrimination threshold).
- **Dimension:** 384.
- **Window:** 256 tokens (~1000–1200 chars). Tokenizer truncates beyond.
- **Pooling:** mean. Output normalized so cosine similarity equals dot product.

### 4.2 Input construction

```ts
function buildEmbedText(fm: Frontmatter, body: string): string {
  const tagsLine = fm.tags?.length ? fm.tags.join(", ") : "";
  return [fm.title, tagsLine, body].filter(Boolean).join("\n");
}
```

Title leads; tags follow as a comma-separated phrase (helps when humans embed tag-like queries); body is concatenated last and gets truncated by the tokenizer if it exceeds the window.

If the rendered text exceeds 256 tokens, we log a `pino.warn` so it shows up in `tail-audit`. The memory is still indexed (truncated for semantic; full content for FTS).

### 4.3 Lazy load semantics

```ts
// src/embedder/index.ts (sketch)
let pipelinePromise: Promise<Pipeline> | null = null;

export async function embed(text: string): Promise<Float32Array> {
  pipelinePromise ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });
  const fe = await pipelinePromise;
  const out = await fe(text, { pooling: "mean", normalize: true });
  return out.data as Float32Array;
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // Parallel via Promise.all; tokenizer handles batching internally.
}
```

The promise is module-scoped, so concurrent first-callers share the load. The HF cache at `~/.cache/huggingface/` (or wherever `HF_HOME` points) survives across server restarts.

### 4.4 Failure handling

If `embedder.embed()` rejects (model load failure, OOM, network error on cold cache), the surrounding tool returns success at the file/FTS layer with `warnings: ["semantic_index_lagged"]`. The chokidar watcher will retry on its next reconcile. `doctor` flags the inconsistency on next run.

## 5. LanceDB schema

### 5.1 Table

Database directory: `<vault>/_system/embeddings.lance/` (Lance format on disk).
Table name: `memories`.

Schema (Apache Arrow types):

| Column | Type | Notes |
|---|---|---|
| `id` | `Utf8` | primary key — same as memory id |
| `vector` | `FixedSizeList<Float32, 384>` | mean-pooled, L2-normalized |
| `type` | `Utf8` | filter |
| `title` | `Utf8` | snippet display |
| `project` | `Utf8` (nullable) | filter |
| `tags` | `List<Utf8>` | future filter |
| `status` | `Utf8` | filter |
| `location` | `Utf8` | filter (`inbox` / `memory` / `archive`) |
| `path` | `Utf8` | absolute path on disk |
| `updated` | `Utf8` | ISO 8601 |
| `schema_version` | `Utf8` | mirror of memory frontmatter `schema_version` |
| `embed_model` | `Utf8` | e.g., `"Xenova/all-MiniLM-L6-v2:int8"` — load-bearing for migrations |

### 5.2 Lifecycle

- **Open on server start:** if directory missing, create + new table. If table exists but the schema's vector column dimension or `embed_model` differs from the server's compiled defaults → log warning, drop table, rebuild from disk.
- **No ANN index in v0.1.** LanceDB falls back to brute-force scan + cosine, which is ~1ms for vault sizes under 5k memories. Reconsider when crossing that threshold.
- **Corruption recovery:** Lance open errors → log, blow away the directory, rebuild. The index is never authoritative; `.md` files are.

### 5.3 Migration story

When the embedding model changes (future Phase 3+ decision to upgrade to e.g. `mxbai-embed-large`):
1. Code's `EMBED_MODEL_ID` constant updates.
2. On startup, the lifecycle check sees mismatch → drops Lance table.
3. `populate` rebuilds with new model on next call (or via explicit `reindex --semantic-only`).

No row-by-row migration needed — vectors are derived data.

## 6. MCP tool API

### 6.1 `memory_search` — extended

```ts
input: {
  query: string
  type?: MemoryType | MemoryType[]
  project?: string
  status?: "active" | "archived" | "superseded"
  location?: "inbox" | "memory" | "archive" | "any"
  limit?: number                       // default 20, max 100
  mode?: "fts" | "semantic" | "hybrid" // NEW. default "hybrid"
}
output: {
  results: Array<{
    id: string
    type: MemoryType
    title: string
    snippet: string
    score: number                      // mode-specific (see §6.1.2)
    location: Location
    path: string
    project: string | null
    tags: string[]
    updated: string
  }>
  total: number
}
```

#### 6.1.1 Dispatch logic

```ts
const mode = input.mode ?? "hybrid";

switch (mode) {
  case "fts":      return ftsSearch(input);                    // Phase 1 path, BM25
  case "semantic": return semanticSearch(input);               // embed query, cosine via Lance
  case "hybrid": {
    const [fts, sem] = await Promise.all([
      ftsSearch({ ...input, limit: 50 }),                      // overfetch
      semanticSearch({ ...input, limit: 50 }),
    ]);
    return rrfMerge(fts, sem, 60, input.limit ?? 20);
  }
}
```

Filters (`type`, `project`, `status`, `location`) apply identically across modes — they constrain the candidate pool *before* ranking. The semantic path passes filters as a Lance `where` predicate; the FTS path uses the existing SQL `WHERE` clause.

#### 6.1.2 Score semantics

- `mode: "fts"` → BM25 (negative; lower-magnitude = better).
- `mode: "semantic"` → cosine similarity (0–1; higher = better).
- `mode: "hybrid"` → RRF score (small positive; higher = better; not comparable across modes).

Documented in the tool's MCP description so callers know.

### 6.2 `memory_context` — new

```ts
input: {
  project: string                      // required
  max_tokens: number                   // default 4000, max 16000
  query?: string                       // optional — if set, semantic-led
  include_inbox?: boolean              // default false
}
output: {
  items: Array<{
    id: string
    type: MemoryType
    title: string
    content: string                    // markdown body, no frontmatter
    tokens: number                     // estimated
    bucket: "summary" | "decision" | "observation" | "learning" | "todo" | "entity" | "question"
  }>
  total_tokens: number
  truncated: number                    // count of memories eligible but excluded for budget
}
```

#### 6.2.1 Algorithm — `query` is null (recency-led, summary-first)

```
1. Bucket all eligible memories (project=X, status=active, location filter):
     summaries  (sorted by updated desc)
     decisions  (sorted by updated desc)
     learnings  (sorted by updated desc)
     observations (sorted by updated desc)
     entities   (sorted by updated desc)
     questions  (sorted by updated desc, unresolved first)
     todos      (sorted by updated desc, todo_status in [todo, doing])
2. Greedy pack walk:
     for each bucket in the order above:
       for each memory in the bucket:
         const memTokens = estimateTokens(content)   // char/3.5 heuristic, see §6.2.3
         if total_tokens + memTokens > max_tokens: increment truncated; continue
         else: append, total_tokens += memTokens
3. Return items in walk order; total_tokens = sum.
```

#### 6.2.2 Algorithm — `query` is set (semantic-led, summary floor)

```
1. Always pull latest 1 summary for the project (if exists) — non-negotiable lead.
2. Embed query → qvec.
3. Lance search with filter project=X, status=active, location filter, limit: 50 — sorted by cosine.
4. Skip the summary already included from step 1.
5. Greedy-pack into max_tokens.
6. Return items in score order (summary always first); total_tokens = sum.
```

#### 6.2.3 Token estimation

`Math.ceil(content.length / 3.5)` — char-based heuristic, English-tuned. Good enough for budgeting.

We do *not* truncate within an item. If a single memory exceeds `max_tokens`, it goes to `truncated` count and is skipped — caller can ask for more budget or pass a `query` to focus.

### 6.3 Unchanged tools

`memory_read`, `memory_write` (API), `memory_promote` (API). Internals updated:

- `memory_write` now performs steps 5–6 of §7.1 in addition to Phase 1 logic.
- `memory_promote` updates Lance metadata in place after the rename (avoids re-embed).

## 7. Data flow

### 7.1 Write path (`memory_write`)

```
1. Validate input shape (Phase 1)
2. Resolve agent + session (Phase 1)
3. Generate id (Phase 1)
4. Build full frontmatter + validate against schema (Phase 1)
5. Atomic write to inbox/<type>/<id>.md (Phase 1)
6. Append audit JSONL (Phase 1)
7. FTS5 INSERT (Phase 1)
8. NEW: const vector = await embedder.embed(buildEmbedText(fm, content))
9. NEW: lance.upsert({id, vector, type, title, project, status: "active", location: "inbox", path: targetPath, updated: now, schema_version, embed_model: EMBED_MODEL_ID})
10. Return { id, path, warnings }
```

If step 8 or 9 throws, return success with `warnings: ["semantic_index_lagged"]`. Watcher will reconcile.

### 7.2 Search path

#### Hybrid mode:

```
1. Validate input (Phase 1) + new mode field.
2. Build base filter from {type, project, status, location} (shared).
3. ftsResults  = ftsSearch({...input, limit: 50})       (Promise)
   semResults  = semanticSearch({...input, limit: 50})  (Promise)
   // Promise.all for parallelism
4. merged = rrfMerge(ftsResults, semResults, k=60, limit=input.limit ?? 20)
5. For each merged id, fetch full row metadata (already on the rows — no extra DB call).
6. Audit: {op:"search", agent, session, query, mode, result_count}
7. Return {results, total}
```

`semanticSearch`:
```
a. const qvec = await embedder.embed(input.query)
b. lance.search(qvec, filter, limit: 50) → cosine-ranked rows
c. Map to result shape; assign rank from row order
```

#### `mode: "fts"` and `mode: "semantic"`: skip the other branch entirely.

### 7.3 Promote path (in-place metadata update)

```
1. Existing Phase 1 logic (find inbox file, validate, renameSync to memory/).
2. After successful rename:
     const row = await lance.getById(id)
     if (row) await lance.updateMetadata(id, { location: "memory", path: to })
3. Audit + return (Phase 1).
```

The watcher will also fire on the rename, but the synchronous metadata update means semantic searches reflect the new location immediately.

### 7.4 Watcher reconcile (extended)

```
chokidar add/change:
  1. Parse + validate frontmatter (Phase 1).
  2. FTS upsert (Phase 1).
  3. NEW: embed + Lance upsert (idempotent).

chokidar unlink:
  1. FTS delete by id (Phase 1).
  2. NEW: Lance delete by id.
```

### 7.5 Context path (`memory_context`)

```
1. Validate input.
2. Branch on query presence (per §6.2.1 / §6.2.2).
3. Read full markdown content from disk for each picked id (gray-matter parse).
4. Audit: {op:"context", agent, session, project, max_tokens, query (hashed if set), result_count, total_tokens}
5. Return {items, total_tokens, truncated}.
```

Add a new `AuditContextOp` entry to the typed `AuditEntry` union in `src/audit/index.ts`. Hash `query` (SHA-256 prefix `sha256:`) before logging, mirroring the search path's `query_hash`.

## 8. Storage & concurrency

- **No new lock domain.** Lance writes within a single process are serialized by LanceDB internally. Cross-process writes (theoretically possible if multiple MCP server instances run on the same vault) are not protected — but Phase 1's Obsidian-style "single writer at a time" assumption holds; if violated, file-based reconcile via watcher heals state on next event.
- **No new fsync responsibility.** Lance manages its own durability.
- **WAL semantics:** LanceDB uses an internal write-ahead approach (Apache Arrow + Lance file format) and commits per upsert. Cross-process readers see committed data after the writer's commit returns.

## 9. CLI changes

### 9.1 `reindex` extended

```
vault-mem-mcp reindex [--vault <path>] [--fts-only] [--semantic-only]
```

- Default: drops both indexes, rebuilds from `.md` files.
- `--fts-only`: drops only `_system/index.sqlite{,-wal,-shm}`, rebuilds FTS only.
- `--semantic-only`: drops only `_system/embeddings.lance/`, rebuilds vectors only.

Output: `Indexed N memories: FTS in Xms, embeddings in Yms`.

### 9.2 `doctor` extended

Total checks: **9** (was 7).

8. `embeddings_index` — directory exists, table opens, vector column dim is 384, `embed_model` matches expected.
9. `embeddings_count_match` — Lance row count equals FTS row count. Skipped if either has 0 rows (unpopulated).

Detail strings on failure: e.g., `"embeddings_index has 4 rows, FTS has 5 — run vault-mem-mcp reindex --semantic-only"`.

### 9.3 Other CLI commands

- `init`: unchanged. The Lance directory is gitignored and rebuilt on first server start.
- `tail-audit`: unchanged at the code level — formats whatever JSONL keys exist, so the new `mode` and `context` op fields display naturally.
- `serve`: unchanged behavior; the embedder model loads lazily on first tool invocation.

## 10. Testing strategy

### 10.1 Unit

- `embedder.embed(text)` returns `Float32Array(384)`, L2-normalized.
- `embedder.embedBatch(texts)` matches `Promise.all(texts.map(embed))` shape and content.
- `index/lance.ts`: round-trip upsert → getById; search by vector returns top-N ordered by cosine; delete removes; count matches inserts; rebuild via `Iterable<Row>` works.
- `index/hybrid.ts`: known input lists → known output ordering. Edge cases: empty FTS, empty semantic, perfect agreement, disjoint sets, identical scores.
- `tools/search.ts` mode dispatch: each mode invokes the correct underlying calls (assert via spies/mocks on embedder + index handles).

### 10.2 Integration (against tmpVault)

- `memory_write` synchronously embeds + Lance upserts. Subsequent `memory_search` with `mode: "semantic"` finds the just-written memory.
- `memory_search` semantic: write a memory titled "Use Supabase for auth" with body "Family multi-tenancy via RLS"; query `"authentication choices"` (no shared keywords); semantic finds it; FTS does not.
- `memory_search` hybrid: write a memory mentioning "Supabase"; verify hybrid finds it both for `query: "Supabase"` (FTS-strong) and for `query: "auth backend"` (semantic-strong).
- `memory_context` no query: write 5 decisions and 1 summary for project X; call with `max_tokens: 200`; verify summary leads, decisions follow in recency order, total within budget.
- `memory_context` with query: write 3 decisions about auth + 3 unrelated; call with `query: "authentication"`; verify auth memories rank higher.
- `memory_promote`: promote a memory; immediately call `memory_search` with `mode: "semantic"` and `location: "memory"` filter — finds the promoted memory.

### 10.3 E2E (one new test)

Round-trip a memory through MCP transport, then call `memory_search` with `mode: "hybrid"` via `client.callTool`. Find it.

### 10.4 Cold-start behavior

- First `memory_write` after fresh vault + fresh server completes within a generous timeout (e.g., 10s) to allow for HF cache miss on the model download.
- Second `memory_write` completes in <500ms.

### 10.5 What's deliberately *not* tested

- Snapshot of vector contents — brittle across MiniLM minor version bumps.
- Precise BM25 / RRF score numbers — only ranks matter; ranks are tested.
- Network-flakiness simulation for HF model download — accepted as best-effort.

## 11. Acceptance criteria

This phase is **done** when all of the following hold:

1. `pnpm --filter @vault-mem/mcp build` succeeds.
2. `pnpm --filter @vault-mem/mcp test` passes all unit + integration + e2e tests.
3. `pnpm --filter @vault-mem/mcp typecheck` is clean.
4. `vault-mem-mcp doctor` reports 9/9 PASS on a freshly initialized vault (after a populate cycle).
5. Live test: from a real Claude Code session, write a memory whose title and body share *no* keywords with a planned query (e.g., title `"Use Supabase for auth"`, query `"login mechanism choices"`). `memory_search` with `mode: "semantic"` returns it. `memory_search` with default (hybrid) also returns it.
6. `memory_context` returns a coherent ordered set for an existing project, with summaries leading and content fitting within the requested token budget.
7. `tail-audit` shows new `mode` and `context` op entries.

When 1–7 hold, Phase 2 is shipped and Phase 3 (Python hygiene daemon) planning can begin.

---

## Appendix A — New and changed dependencies

| Package | Reason |
|---|---|
| `@xenova/transformers` (NEW) | ONNX Transformers.js runtime for MiniLM |
| `@lancedb/lancedb` (NEW) | LanceDB Node bindings |
| `gray-matter` (existing) | Parsing memory frontmatter (already used) |
| `pino` (existing) | Logging the embedder warnings |

Pin versions and audit transitive deps at implementation time.

## Appendix B — Schema additivity rule (carried from Phase 1)

The Phase 1 rule still holds: **all schema changes from v0.1 onward are additive only.** Phase 2 adds no required frontmatter fields — `embed_model` lives only in the Lance row metadata, not in `_common.json`. Memory schemas are untouched.

## Appendix C — `embed_model` migration cookbook (forward-looking)

When upgrading to a new embedding model in a future phase:

1. Update `EMBED_MODEL_ID` constant in `src/embedder/index.ts`.
2. Update vector dimension constant if the new model differs (e.g., 384 → 1024 for `mxbai-embed-large`).
3. Increment Lance schema version (manual: change a constant, drop on mismatch).
4. On next server start, the lifecycle check drops the Lance table and `populate` rebuilds with the new model.

No need to migrate row-by-row — vectors are pure derived data from `.md` sources.
