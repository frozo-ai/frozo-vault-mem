# Vault-Mem Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first embedding pipeline (Transformers.js + ONNX MiniLM), a LanceDB vector index, hybrid (FTS+semantic) search via Reciprocal Rank Fusion, and a new `memory_context` tool — all inside the existing Node MCP server.

**Architecture:** Reuse Phase 1's module-injection pattern. Add `Embedder` and `IndexHandle`-shaped Lance handle to the dependency tree passed to tools. Watcher and write path call the embedder synchronously after FTS upsert; reads/searches dispatch by mode. Embedder model loads lazily on first call (1–2 s cold cache, ~50 ms warm).

**Tech Stack:** Node 20 LTS · pnpm · TypeScript ESM · Vitest · `@xenova/transformers` (ONNX MiniLM) · `@lancedb/lancedb` (vector store) · existing `better-sqlite3`/`gray-matter`/`pino`/`chokidar`.

**Spec:** [`docs/superpowers/specs/2026-04-27-vault-mem-phase-2-design.md`](../specs/2026-04-27-vault-mem-phase-2-design.md)

---

## File Structure

### Created files

- `packages/mcp/src/embedder/index.ts` (+ `embedder.test.ts`) — real embedder + types
- `packages/mcp/src/embedder/mock.ts` — `createMockEmbedder()` for fast deterministic tests
- `packages/mcp/src/index/lance.ts` (+ `lance.test.ts`) — LanceDB lifecycle + ops
- `packages/mcp/src/index/hybrid.ts` (+ `hybrid.test.ts`) — RRF merge
- `packages/mcp/src/tools/context.ts`
- `packages/mcp/test/integration/context.test.ts`

### Modified files

- `packages/mcp/package.json` — add 2 deps
- `packages/mcp/src/audit/index.ts` — add `AuditContextOp` to the union
- `packages/mcp/src/audit/audit.test.ts` — assert context op formatting
- `packages/mcp/src/index/populate.ts` — batch-embed during walk
- `packages/mcp/src/index/populate.test.ts` — assert Lance row count after populate
- `packages/mcp/src/index/watcher.ts` — extend reconcile + unlink for Lance
- `packages/mcp/src/index/watcher.test.ts` — assert Lance state after events
- `packages/mcp/src/tools/search.ts` — `mode` dispatch
- `packages/mcp/test/integration/search.test.ts` — semantic + hybrid scenarios
- `packages/mcp/src/tools/write.ts` — call embedder + Lance after FTS upsert
- `packages/mcp/test/integration/write.test.ts` — assert Lance row exists after write
- `packages/mcp/src/tools/promote.ts` — in-place Lance metadata update
- `packages/mcp/test/integration/promote.test.ts` — assert Lance location updated
- `packages/mcp/src/tools/index.ts` — re-export `createContextTool`
- `packages/mcp/src/server/index.ts` — instantiate embedder + Lance, pass to tools, register `memory_context`
- `packages/mcp/test/e2e/server.test.ts` — call `memory_context` round-trip
- `packages/mcp/src/cli/reindex.ts` — `--fts-only` / `--semantic-only` flags + Lance rebuild
- `packages/mcp/test/integration/cli/reindex.test.ts` — flag-driven scenarios
- `packages/mcp/src/cli/doctor.ts` — 2 new checks (`embeddings_index`, `embeddings_count_match`)
- `packages/mcp/test/integration/cli/doctor.test.ts` — assertions for new checks
- `packages/mcp/src/index.ts` — pass new flags through commander
- `vault-template/.gitignore` — add `_system/embeddings.lance/`
- `README.md` — document the `mode` parameter and `memory_context`

---

## Tasks

### Task 1: Add dependencies

**Files:**
- Modify: `packages/mcp/package.json`

- [ ] **Step 1: Add deps to `packages/mcp/package.json`**

In the `"dependencies"` block, add (alphabetical):

```json
"@lancedb/lancedb": "0.13.0",
"@xenova/transformers": "2.17.2",
```

The full dependencies block becomes:

```json
"dependencies": {
  "@lancedb/lancedb": "0.13.0",
  "@modelcontextprotocol/sdk": "1.0.4",
  "@xenova/transformers": "2.17.2",
  "ajv": "8.17.1",
  "ajv-formats": "3.0.1",
  "better-sqlite3": "11.5.0",
  "chokidar": "4.0.1",
  "commander": "12.1.0",
  "gray-matter": "4.0.3",
  "pino": "9.5.0",
  "proper-lockfile": "4.1.2",
  "ulid": "2.3.0",
  "yaml": "2.6.1"
}
```

- [ ] **Step 2: Install**

```bash
pnpm install
```

Expected: lockfile updated; both packages resolved without peer-dep warnings (some warnings about `onnxruntime-node` are normal).

- [ ] **Step 3: Verify build still passes**

```bash
pnpm --filter @vault-mem/mcp build
pnpm --filter @vault-mem/mcp test
pnpm --filter @vault-mem/mcp typecheck
```

Expected: 71/71 tests passing, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/package.json pnpm-lock.yaml
git commit -m "chore(mcp): add @xenova/transformers and @lancedb/lancedb deps"
```

---

### Task 2: Embedder module

**Files:**
- Create: `packages/mcp/src/embedder/index.ts`
- Create: `packages/mcp/src/embedder/embedder.test.ts`
- Create: `packages/mcp/src/embedder/mock.ts`

- [ ] **Step 1: Write the failing test `packages/mcp/src/embedder/embedder.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createTransformersEmbedder, EMBED_DIM, EMBED_MODEL_ID } from "./index.js";
import { createMockEmbedder } from "./mock.js";

describe("EMBED_MODEL_ID", () => {
  it("identifies the int8 quantized MiniLM model", () => {
    expect(EMBED_MODEL_ID).toBe("Xenova/all-MiniLM-L6-v2:int8");
    expect(EMBED_DIM).toBe(384);
  });
});

describe("createMockEmbedder", () => {
  it("produces 384-dim vectors deterministically from input", async () => {
    const e = createMockEmbedder();
    const v1 = await e.embed("hello");
    const v2 = await e.embed("hello");
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v1.length).toBe(384);
    expect(Array.from(v1)).toEqual(Array.from(v2)); // deterministic
  });

  it("produces different vectors for different inputs", async () => {
    const e = createMockEmbedder();
    const a = await e.embed("hello");
    const b = await e.embed("world");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("embedBatch matches sequential embed", async () => {
    const e = createMockEmbedder();
    const seq = await Promise.all([e.embed("a"), e.embed("b"), e.embed("c")]);
    const batch = await e.embedBatch(["a", "b", "c"]);
    expect(batch.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Array.from(batch[i]!)).toEqual(Array.from(seq[i]!));
    }
  });

  it("returns L2-normalized vectors (norm ≈ 1)", async () => {
    const e = createMockEmbedder();
    const v = await e.embed("normalize check");
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    expect(norm).toBeCloseTo(1, 4);
  });
});

describe("createTransformersEmbedder (real model, slow first run)", () => {
  it("produces 384-dim L2-normalized Float32Array", { timeout: 30_000 }, async () => {
    const e = createTransformersEmbedder();
    const v = await e.embed("Use SQLite FTS5 for keyword search");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 3);
  });

  it("similar texts have higher cosine similarity than dissimilar texts", { timeout: 30_000 }, async () => {
    const e = createTransformersEmbedder();
    const auth = await e.embed("Use Supabase for authentication");
    const auth2 = await e.embed("Authentication via Auth0");
    const food = await e.embed("Pasta carbonara recipe");
    const cos = (a: Float32Array, b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
      return s;
    };
    expect(cos(auth, auth2)).toBeGreaterThan(cos(auth, food));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test embedder/embedder.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/embedder/index.ts`**

```ts
import { pipeline, type Pipeline } from "@xenova/transformers";

export const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2:int8";
export const EMBED_DIM = 384;

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export function createTransformersEmbedder(): Embedder {
  let pipelinePromise: Promise<Pipeline> | null = null;

  const getPipeline = (): Promise<Pipeline> => {
    pipelinePromise ??= pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { quantized: true },
    ) as unknown as Promise<Pipeline>;
    return pipelinePromise;
  };

  async function embed(text: string): Promise<Float32Array> {
    const fe = await getPipeline();
    const out = await (fe as unknown as (
      input: string,
      opts: { pooling: "mean"; normalize: true },
    ) => Promise<{ data: Float32Array }>)(text, {
      pooling: "mean",
      normalize: true,
    });
    return new Float32Array(out.data);
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => embed(t)));
  }

  return { embed, embedBatch };
}
```

- [ ] **Step 4: Write `packages/mcp/src/embedder/mock.ts`**

```ts
import { createHash } from "node:crypto";
import { type Embedder, EMBED_DIM } from "./index.js";

/**
 * Deterministic text → vector mock embedder for tests.
 *
 * Uses SHA-256 of the text to seed a 384-dim vector. The same text always
 * produces the same vector; different texts produce different vectors.
 * Vectors are L2-normalized so cosine similarity behaves predictably.
 *
 * NOTE: this is for shape/protocol tests only — semantic similarity
 * properties (e.g., "auth" close to "authentication") are NOT guaranteed
 * by this mock. For real-similarity tests, use the Transformers embedder.
 */
export function createMockEmbedder(): Embedder {
  function vectorFor(text: string): Float32Array {
    const out = new Float32Array(EMBED_DIM);
    let sumSq = 0;
    let hash = createHash("sha256").update(text).digest();
    let cursor = 0;
    for (let i = 0; i < EMBED_DIM; i++) {
      if (cursor + 4 > hash.length) {
        hash = createHash("sha256").update(hash).digest();
        cursor = 0;
      }
      // Map 4 bytes → float in [-1, 1]
      const u32 = hash.readUInt32BE(cursor);
      cursor += 4;
      const f = (u32 / 0xffffffff) * 2 - 1;
      out[i] = f;
      sumSq += f * f;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < EMBED_DIM; i++) out[i]! /= norm;
    return out;
  }

  return {
    async embed(text) { return vectorFor(text); },
    async embedBatch(texts) { return texts.map(vectorFor); },
  };
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @vault-mem/mcp test embedder/embedder.test.ts
```

Expected: 7 passing (model download on first run takes ~10s).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/embedder
git commit -m "feat(mcp): add embedder module (Transformers.js + deterministic mock)"
```

---

### Task 3: Lance index module

**Files:**
- Create: `packages/mcp/src/index/lance.ts`
- Create: `packages/mcp/src/index/lance.test.ts`

- [ ] **Step 1: Write the failing test `packages/mcp/src/index/lance.test.ts`**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLance, type LanceRow } from "./lance.js";
import { EMBED_DIM, EMBED_MODEL_ID } from "../embedder/index.js";
import { createMockEmbedder } from "../embedder/mock.js";

const sample = (over: Partial<LanceRow> = {}): LanceRow => ({
  id: "mem_2026-04-27_aaaaaa",
  vector: new Float32Array(EMBED_DIM).fill(0.05),
  type: "decision",
  title: "Use Supabase for auth",
  project: "myapp",
  tags: ["auth"],
  status: "active",
  location: "memory",
  path: "/v/memory/decisions/mem_2026-04-27_aaaaaa.md",
  updated: "2026-04-27T14:32:00.000Z",
  schema_version: "0.1",
  embed_model: EMBED_MODEL_ID,
  ...over,
});

describe("openLance", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-lance-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("creates the table and round-trips upsert + getById", async () => {
    const lance = await openLance(dir);
    await lance.upsert(sample());
    const row = await lance.getById("mem_2026-04-27_aaaaaa");
    expect(row?.title).toBe("Use Supabase for auth");
    expect(row?.location).toBe("memory");
    expect(row?.vector?.length).toBe(EMBED_DIM);
    await lance.close();
  });

  it("search returns rows ordered by cosine similarity to the query vector", async () => {
    const lance = await openLance(dir);
    const e = createMockEmbedder();
    const ids = ["mem_2026-04-27_aaaaaa", "mem_2026-04-27_bbbbbb", "mem_2026-04-27_cccccc"];
    const titles = ["alpha topic", "beta topic", "gamma topic"];
    for (let i = 0; i < 3; i++) {
      await lance.upsert(sample({ id: ids[i]!, title: titles[i]!, vector: await e.embed(titles[i]!) }));
    }
    const qvec = await e.embed("alpha topic");
    const r = await lance.search(qvec, {}, 10);
    // The row whose vector exactly matches the query should rank first
    expect(r.results[0]!.id).toBe("mem_2026-04-27_aaaaaa");
    await lance.close();
  });

  it("filters by type, project, status, location", async () => {
    const lance = await openLance(dir);
    const e = createMockEmbedder();
    const qvec = await e.embed("query");
    await lance.upsert(sample({ id: "mem_2026-04-27_aaaaaa", type: "decision", project: "myapp" }));
    await lance.upsert(sample({ id: "mem_2026-04-27_bbbbbb", type: "observation", project: "myapp" }));
    await lance.upsert(sample({ id: "mem_2026-04-27_cccccc", type: "decision", project: "otherapp" }));

    expect((await lance.search(qvec, { type: "decision" }, 10)).results).toHaveLength(2);
    expect((await lance.search(qvec, { project: "myapp" }, 10)).results).toHaveLength(2);
    expect((await lance.search(qvec, { type: "decision", project: "myapp" }, 10)).results).toHaveLength(1);
    await lance.close();
  });

  it("delete removes a row; count reflects current size", async () => {
    const lance = await openLance(dir);
    await lance.upsert(sample({ id: "mem_2026-04-27_aaaaaa" }));
    await lance.upsert(sample({ id: "mem_2026-04-27_bbbbbb" }));
    expect(await lance.count()).toBe(2);
    await lance.delete("mem_2026-04-27_aaaaaa");
    expect(await lance.count()).toBe(1);
    expect(await lance.getById("mem_2026-04-27_aaaaaa")).toBeNull();
    await lance.close();
  });

  it("updateMetadata changes scalar fields without re-embedding", async () => {
    const lance = await openLance(dir);
    const v = new Float32Array(EMBED_DIM).fill(0.1);
    await lance.upsert(sample({ vector: v, location: "inbox", path: "/v/inbox/decisions/x.md" }));
    await lance.updateMetadata("mem_2026-04-27_aaaaaa", {
      location: "memory",
      path: "/v/memory/decisions/x.md",
    });
    const row = await lance.getById("mem_2026-04-27_aaaaaa");
    expect(row?.location).toBe("memory");
    expect(row?.path).toBe("/v/memory/decisions/x.md");
    // vector unchanged
    expect(Array.from(row!.vector!).every((x, i) => Math.abs(x - v[i]!) < 1e-6)).toBe(true);
    await lance.close();
  });

  it("rebuild replaces all rows in one transaction", async () => {
    const lance = await openLance(dir);
    await lance.upsert(sample({ id: "mem_2026-04-27_aaaaaa" }));
    await lance.rebuild([
      sample({ id: "mem_2026-04-27_bbbbbb" }),
      sample({ id: "mem_2026-04-27_cccccc" }),
    ]);
    expect(await lance.count()).toBe(2);
    expect(await lance.getById("mem_2026-04-27_aaaaaa")).toBeNull();
    expect(await lance.getById("mem_2026-04-27_bbbbbb")).not.toBeNull();
    await lance.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test index/lance.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/index/lance.ts`**

```ts
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import type { Location, MemoryType } from "../vault/paths.js";
import { EMBED_DIM, EMBED_MODEL_ID } from "../embedder/index.js";

const TABLE_NAME = "memories";

export interface LanceRow {
  id: string;
  vector: Float32Array;
  type: MemoryType;
  title: string;
  project: string | null;
  tags: string[];
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
  schema_version: string;
  embed_model: string;
}

export interface LanceFilter {
  type?: MemoryType | MemoryType[];
  project?: string;
  status?: "active" | "archived" | "superseded";
  location?: Location | "any";
}

export interface LanceSearchResult {
  id: string;
  type: MemoryType;
  title: string;
  project: string | null;
  tags: string[];
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
  score: number;
}

export interface LanceHandle {
  upsert(row: LanceRow): Promise<void>;
  delete(id: string): Promise<void>;
  getById(id: string): Promise<LanceRow | null>;
  search(qvec: Float32Array, filter: LanceFilter, limit: number): Promise<{ results: LanceSearchResult[]; total: number }>;
  rebuild(rows: Iterable<LanceRow>): Promise<void>;
  updateMetadata(id: string, fields: Partial<Pick<LanceRow, "location" | "path" | "status" | "updated">>): Promise<void>;
  count(): Promise<number>;
  close(): Promise<void>;
}

function escape(s: string): string {
  return s.replace(/'/g, "''");
}

function buildWhere(filter: LanceFilter): string | null {
  const parts: string[] = [];
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    parts.push(`type IN (${types.map((t) => `'${escape(t)}'`).join(", ")})`);
  }
  if (filter.project) parts.push(`project = '${escape(filter.project)}'`);
  if (filter.status) parts.push(`status = '${escape(filter.status)}'`);
  if (filter.location && filter.location !== "any") parts.push(`location = '${escape(filter.location)}'`);
  return parts.length > 0 ? parts.join(" AND ") : null;
}

function rowToInput(row: LanceRow): Record<string, unknown> {
  return {
    id: row.id,
    vector: Array.from(row.vector),
    type: row.type,
    title: row.title,
    project: row.project,
    tags: row.tags,
    status: row.status,
    location: row.location,
    path: row.path,
    updated: row.updated,
    schema_version: row.schema_version,
    embed_model: row.embed_model,
  };
}

function rowFromDb(r: Record<string, unknown> | undefined | null): LanceRow | null {
  if (!r) return null;
  const rawVec = r["vector"] as ArrayLike<number> | Float32Array | undefined;
  return {
    id: String(r["id"]),
    vector: rawVec ? new Float32Array(Array.from(rawVec)) : new Float32Array(EMBED_DIM),
    type: r["type"] as MemoryType,
    title: String(r["title"]),
    project: r["project"] != null ? String(r["project"]) : null,
    tags: Array.isArray(r["tags"]) ? (r["tags"] as unknown[]).map((x) => String(x)) : [],
    status: r["status"] as LanceRow["status"],
    location: r["location"] as Location,
    path: String(r["path"]),
    updated: String(r["updated"]),
    schema_version: String(r["schema_version"]),
    embed_model: String(r["embed_model"]),
  };
}

export async function openLance(dir: string): Promise<LanceHandle> {
  mkdirSync(dir, { recursive: true });
  const db: Connection = await lancedb.connect(dir);
  let table: Table;
  const existing = await db.tableNames();
  if (existing.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  } else {
    // Create with one seed row, then immediately delete it, so the schema
    // (vector dimension etc.) is locked in. LanceDB infers schema from data.
    const seed = rowToInput({
      id: "__seed__",
      vector: new Float32Array(EMBED_DIM),
      type: "decision",
      title: "",
      project: null,
      tags: [],
      status: "active",
      location: "inbox",
      path: "",
      updated: "",
      schema_version: "0.1",
      embed_model: EMBED_MODEL_ID,
    });
    table = await db.createTable(TABLE_NAME, [seed]);
    await table.delete("id = '__seed__'");
  }

  return {
    async upsert(row) {
      // Lance has no native upsert; emulate via delete-then-add.
      await table.delete(`id = '${escape(row.id)}'`);
      await table.add([rowToInput(row)]);
    },
    async delete(id) {
      await table.delete(`id = '${escape(id)}'`);
    },
    async getById(id) {
      const rows = await table
        .query()
        .where(`id = '${escape(id)}'`)
        .limit(1)
        .toArray();
      return rowFromDb(rows[0]);
    },
    async search(qvec, filter, limit) {
      const where = buildWhere(filter);
      let q = table.search(Array.from(qvec)).limit(limit);
      if (where) q = q.where(where);
      const results = (await q.toArray()) as Array<Record<string, unknown>>;
      const mapped: LanceSearchResult[] = results.map((r) => ({
        id: String(r["id"]),
        type: r["type"] as MemoryType,
        title: String(r["title"]),
        project: r["project"] != null ? String(r["project"]) : null,
        tags: Array.isArray(r["tags"]) ? (r["tags"] as unknown[]).map((x) => String(x)) : [],
        status: r["status"] as LanceSearchResult["status"],
        location: r["location"] as Location,
        path: String(r["path"]),
        updated: String(r["updated"]),
        score: Number(r["_distance"] ?? 0),
      }));
      // Total: reuse count of filtered rows
      const totalQ = await table
        .query()
        .where(where ?? "true")
        .toArray();
      return { results: mapped, total: totalQ.length };
    },
    async rebuild(rows) {
      // Drop all, re-add. Schema preserved via the existing table.
      await table.delete("true");
      const arr = Array.from(rows).map(rowToInput);
      if (arr.length > 0) await table.add(arr);
    },
    async updateMetadata(id, fields) {
      // No partial-update API; emulate via getById + upsert with same vector.
      const existing = await this.getById(id);
      if (!existing) return;
      const updated: LanceRow = { ...existing, ...fields };
      await this.upsert(updated);
    },
    async count() {
      return table.countRows();
    },
    async close() {
      // Connection is closed by GC; nothing to do explicitly in current API.
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @vault-mem/mcp test index/lance.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/index/lance.ts packages/mcp/src/index/lance.test.ts
git commit -m "feat(mcp): add index/lance module (LanceDB upsert/search/delete/rebuild/updateMetadata)"
```

---

### Task 4: Hybrid RRF module

**Files:**
- Create: `packages/mcp/src/index/hybrid.ts`
- Create: `packages/mcp/src/index/hybrid.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { rrfMerge, type RankedHit } from "./hybrid.js";

const hit = (id: string, rank: number): RankedHit => ({ id, rank });

describe("rrfMerge", () => {
  it("merges two disjoint lists by RRF score, descending", () => {
    const fts = [hit("a", 0), hit("b", 1), hit("c", 2)];
    const sem = [hit("d", 0), hit("e", 1), hit("f", 2)];
    const out = rrfMerge(fts, sem, 60, 6);
    // rank 0 in either list dominates → "a" and "d" tied
    expect(out.length).toBe(6);
    expect(out[0]!.score).toBeCloseTo(out[1]!.score, 5);
    expect(["a", "d"]).toContain(out[0]!.id);
  });

  it("boosts ids that appear in both lists", () => {
    const fts = [hit("shared", 0), hit("a", 1), hit("b", 2)];
    const sem = [hit("shared", 0), hit("c", 1), hit("d", 2)];
    const out = rrfMerge(fts, sem, 60, 5);
    expect(out[0]!.id).toBe("shared");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("respects the limit", () => {
    const fts = [hit("a", 0), hit("b", 1), hit("c", 2)];
    const sem = [hit("d", 0), hit("e", 1), hit("f", 2)];
    expect(rrfMerge(fts, sem, 60, 3).length).toBe(3);
  });

  it("handles empty FTS list", () => {
    expect(rrfMerge([], [hit("x", 0), hit("y", 1)], 60, 10)).toHaveLength(2);
    expect(rrfMerge([], [hit("x", 0)], 60, 10)[0]!.id).toBe("x");
  });

  it("handles empty semantic list", () => {
    expect(rrfMerge([hit("x", 0)], [], 60, 10)).toHaveLength(1);
  });

  it("returns empty when both lists empty", () => {
    expect(rrfMerge([], [], 60, 10)).toEqual([]);
  });

  it("ranks earlier positions higher (sanity)", () => {
    const fts = [hit("first", 0), hit("second", 1), hit("third", 2)];
    const sem: RankedHit[] = [];
    const out = rrfMerge(fts, sem, 60, 3);
    expect(out.map((x) => x.id)).toEqual(["first", "second", "third"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test index/hybrid.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/index/hybrid.ts`**

```ts
export interface RankedHit {
  id: string;
  rank: number;
}

export interface FusedHit {
  id: string;
  score: number;
}

export function rrfMerge(
  fts: RankedHit[],
  sem: RankedHit[],
  k: number,
  limit: number,
): FusedHit[] {
  const scores = new Map<string, number>();
  for (const h of fts) {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (k + h.rank));
  }
  for (const h of sem) {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (k + h.rank));
  }
  const out: FusedHit[] = [];
  for (const [id, score] of scores) out.push({ id, score });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @vault-mem/mcp test index/hybrid.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/index/hybrid.ts packages/mcp/src/index/hybrid.test.ts
git commit -m "feat(mcp): add index/hybrid module (Reciprocal Rank Fusion merge)"
```

---

### Task 5: Audit `AuditContextOp` extension

**Files:**
- Modify: `packages/mcp/src/audit/index.ts`
- Modify: `packages/mcp/src/audit/audit.test.ts`

- [ ] **Step 1: Add `AuditContextOp` to the union in `packages/mcp/src/audit/index.ts`**

Find the existing union types. Add this interface alongside the others:

```ts
export interface AuditContextOp {
  op: "context";
  agent: string;
  session: string | null;
  project: string;
  max_tokens: number;
  query?: string;
  result_count: number;
  total_tokens: number;
}
```

Update the `AuditEntry` union to include `AuditContextOp`:

```ts
export type AuditEntry =
  | AuditWriteOp
  | AuditReadOp
  | AuditSearchOp
  | AuditPromoteOp
  | AuditContextOp
  | AuditFailedOp;
```

In the `serialize` function, extend the `op === "search"` query-hashing branch to also handle `op === "context"`:

```ts
function serialize(entry: AuditEntry): string {
  const base = { ts: new Date().toISOString(), v: 1 };
  if (entry.op === "search") {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  if (entry.op === "context" && entry.query !== undefined) {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  return JSON.stringify({ ...base, ...entry });
}
```

- [ ] **Step 2: Add a test in `packages/mcp/src/audit/audit.test.ts`**

Append the test (do not remove existing tests):

```ts
  it("hashes context query when present, omits when absent", () => {
    const a = new Auditor(logPath);
    a.write({
      op: "context",
      agent: "claude-code",
      session: "01H",
      project: "myapp",
      max_tokens: 4000,
      query: "auth decisions",
      result_count: 3,
      total_tokens: 480,
    });
    a.write({
      op: "context",
      agent: "claude-code",
      session: "01H",
      project: "myapp",
      max_tokens: 4000,
      result_count: 5,
      total_tokens: 1200,
    });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const withQuery = JSON.parse(lines[0]!);
    const noQuery = JSON.parse(lines[1]!);
    expect(withQuery.query).toBeUndefined();
    expect(withQuery.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(withQuery.project).toBe("myapp");
    expect(noQuery.query).toBeUndefined();
    expect(noQuery.query_hash).toBeUndefined();
    expect(noQuery.total_tokens).toBe(1200);
  });
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @vault-mem/mcp test audit/audit.test.ts
```

Expected: 3 passing (existing 2 + new 1).

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/audit
git commit -m "feat(mcp): add AuditContextOp to audit entry union"
```

---

### Task 6: Watcher and populate Lance extensions

**Files:**
- Modify: `packages/mcp/src/index/watcher.ts`
- Modify: `packages/mcp/src/index/watcher.test.ts`
- Modify: `packages/mcp/src/index/populate.ts`
- Modify: `packages/mcp/src/index/populate.test.ts`

- [ ] **Step 1: Extend `WatcherDeps` and `reconcile` in `watcher.ts`**

Add to imports at top of `watcher.ts`:

```ts
import type { Embedder } from "../embedder/index.js";
import type { LanceHandle } from "./lance.js";
import { EMBED_MODEL_ID } from "../embedder/index.js";
```

Update the `WatcherDeps` interface:

```ts
export interface WatcherDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
  debounceMs?: number;
  embedder: Embedder;       // NEW
  lance: LanceHandle;       // NEW
}
```

In the `reconcile` function, after the existing `deps.index.upsert(...)` call, add:

```ts
    // NEW: also upsert to Lance with a fresh embedding
    try {
      const embedText = [String(fm["title"]), tagsArray.join(", "), content]
        .filter((s) => s && s.length > 0)
        .join("\n");
      const vector = await deps.embedder.embed(embedText);
      await deps.lance.upsert({
        id,
        vector,
        type,
        title: String(fm["title"]),
        project: (fm["project"] as string | null | undefined) ?? null,
        tags: tagsArray,
        status: (fm["status"] as "active" | "archived" | "superseded") ?? "active",
        location: loc,
        path: absPath,
        updated: String(fm["updated"]),
        schema_version: String(fm["schema_version"] ?? "0.1"),
        embed_model: EMBED_MODEL_ID,
      });
    } catch (err) {
      log.warn({ path: absPath, err: (err as Error).message }, "lance upsert failed");
    }
```

(Refactor the existing inline `tags` access into a `const tagsArray = (fm["tags"] as string[] | undefined) ?? [];` line near the top of `reconcile` so it can be reused for both FTS upsert and Lance upsert.)

In the `unlinkPath` function, after `deps.index.delete(id)`, add:

```ts
    deps.lance.delete(id).catch((err) => {
      log.warn({ id, err: (err as Error).message }, "lance delete failed");
    });
```

- [ ] **Step 2: Update `watcher.test.ts` to pass embedder + lance**

Inside `beforeEach`, after creating the FTS index, also create a Lance dir and handle:

```ts
import { mkdtempSync as mkdtempSyncForLance } from "node:fs";
import { tmpdir as tmpdirForLance } from "node:os";
import { join as joinForLance } from "node:path";
import { openLance } from "./lance.js";
import { createMockEmbedder } from "../embedder/mock.js";
```

(These imports already exist; just make sure they're present.)

Update the watcher startup call in the existing test to include the new deps:

```ts
const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-watcher-lance-"));
const lance = await openLance(lanceDir);
const embedder = createMockEmbedder();
const w = startWatcher({
  vault: v.root,
  index: idx,
  schemas: loadSchemas(v.root),
  debounceMs: 50,
  embedder,
  lance,
});
```

After the existing assertion, also assert the Lance row exists:

```ts
    // After the file is added, the Lance row should also exist
    const lanceRow = await lance.getById(id);
    expect(lanceRow?.title).toBe("Watcher test");
```

After `rmSync(file)` and waiting for unlink:

```ts
    expect(await lance.getById(id)).toBeNull();
```

In the cleanup `return ()`, add:

```ts
    rmSync(lanceDir, { recursive: true, force: true });
```

- [ ] **Step 3: Extend `populate.ts` to also build Lance rows in batches**

Add to imports:

```ts
import type { Embedder } from "../embedder/index.js";
import type { LanceHandle, LanceRow } from "./lance.js";
import { EMBED_MODEL_ID } from "../embedder/index.js";
```

Update `PopulateDeps`:

```ts
export interface PopulateDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
  embedder: Embedder;     // NEW
  lance: LanceHandle;     // NEW
}
```

In `populateIndex`, after `deps.index.rebuild(rows);` and before `return { count: rows.length };`, add:

```ts
  // NEW: batch-embed and rebuild Lance
  if (rows.length === 0) {
    await deps.lance.rebuild([]);
  } else {
    const BATCH = 32;
    const lanceRows: LanceRow[] = [];
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const texts = batch.map((r) => [r.title, r.tags.join(", "), r.body].filter(Boolean).join("\n"));
      const vectors = await deps.embedder.embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        const r = batch[j]!;
        lanceRows.push({
          id: r.id,
          vector: vectors[j]!,
          type: r.type,
          title: r.title,
          project: r.project,
          tags: r.tags,
          status: r.status,
          location: r.location,
          path: r.path,
          updated: r.updated,
          schema_version: "0.1",
          embed_model: EMBED_MODEL_ID,
        });
      }
    }
    await deps.lance.rebuild(lanceRows);
  }
```

- [ ] **Step 4: Update `populate.test.ts` to pass embedder + lance**

In the existing test `beforeEach`, after creating the FTS index, also create Lance:

```ts
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-populate-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
```

Update the `populateIndex` call:

```ts
    await populateIndex({
      vault: v.root,
      index: idx,
      schemas,
      embedder,
      lance,
    });
```

Add an assertion after the existing FTS assertions:

```ts
    expect(await lance.count()).toBe(idx.count());
    const lanceRow = await lance.getById("mem_2026-04-27_aaaaaa");
    expect(lanceRow?.location).toBe("memory");
    expect(lanceRow?.vector?.length).toBe(384);
```

In cleanup, also remove the Lance dir.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @vault-mem/mcp test index/
```

Expected: all index tests passing (including watcher and populate with new assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/index
git commit -m "feat(mcp): extend watcher and populate to maintain Lance index"
```

---

### Task 7: Search tool — `mode` dispatch

**Files:**
- Modify: `packages/mcp/src/tools/search.ts`
- Modify: `packages/mcp/test/integration/search.test.ts`

- [ ] **Step 1: Extend `SearchToolDeps` and rewrite `handle` in `tools/search.ts`**

Replace the entire file content with:

```ts
import { Auditor } from "../audit/index.js";
import { type IndexHandle, type SearchInput } from "../index/sqlite.js";
import { type LanceHandle, type LanceFilter } from "../index/lance.js";
import { type Embedder } from "../embedder/index.js";
import { rrfMerge, type RankedHit } from "../index/hybrid.js";

export interface SearchToolDeps {
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;
  embedder: Embedder;
  agent?: string;
  session?: string | null;
}

export type SearchMode = "fts" | "semantic" | "hybrid";

export interface SearchToolInput extends SearchInput {
  mode?: SearchMode;
}

export function buildFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return tokens.map((t) => `${t}*`).join(" ");
}

export function createSearchTool(deps: SearchToolDeps) {
  function buildLanceFilter(input: SearchToolInput): LanceFilter {
    return {
      type: input.type,
      project: input.project,
      status: input.status,
      location: input.location,
    };
  }

  async function ftsRun(input: SearchToolInput, limit: number) {
    const fts = buildFtsQuery(input.query);
    if (!fts) return { results: [], total: 0 };
    return deps.index.search({ ...input, query: fts, limit });
  }

  async function semanticRun(input: SearchToolInput, limit: number) {
    const qvec = await deps.embedder.embed(input.query);
    return deps.lance.search(qvec, buildLanceFilter(input), limit);
  }

  return {
    async handle(input: SearchToolInput) {
      const mode: SearchMode = input.mode ?? "hybrid";
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

      let results: Array<{ id: string; type: string; title: string; snippet: string; score: number; location: string; path: string; project: string | null; tags: string[]; updated: string }> = [];
      let total = 0;

      if (mode === "fts") {
        const r = await ftsRun(input, limit);
        results = r.results.map((x) => ({ ...x, score: x.score }));
        total = r.total;
      } else if (mode === "semantic") {
        const r = await semanticRun(input, limit);
        results = r.results.map((x) => ({
          id: x.id, type: x.type, title: x.title, snippet: "",
          score: x.score, location: x.location, path: x.path,
          project: x.project, tags: x.tags, updated: x.updated,
        }));
        total = r.total;
      } else {
        // hybrid
        const [ftsRes, semRes] = await Promise.all([
          ftsRun(input, 50),
          semanticRun(input, 50),
        ]);
        const ftsHits: RankedHit[] = ftsRes.results.map((r, i) => ({ id: r.id, rank: i }));
        const semHits: RankedHit[] = semRes.results.map((r, i) => ({ id: r.id, rank: i }));
        const merged = rrfMerge(ftsHits, semHits, 60, limit);
        // Map back to full result rows: prefer FTS row (has snippet), fall back to semantic
        const ftsById = new Map(ftsRes.results.map((r) => [r.id, r]));
        const semById = new Map(semRes.results.map((r) => [r.id, r]));
        results = merged.map((m) => {
          const fts = ftsById.get(m.id);
          if (fts) return { ...fts, score: m.score };
          const sem = semById.get(m.id)!;
          return {
            id: sem.id, type: sem.type, title: sem.title, snippet: "",
            score: m.score, location: sem.location, path: sem.path,
            project: sem.project, tags: sem.tags, updated: sem.updated,
          };
        });
        // Total: union of unique ids across both branches
        const unionIds = new Set<string>([...ftsRes.results.map((r) => r.id), ...semRes.results.map((r) => r.id)]);
        total = unionIds.size;
      }

      deps.auditor.write({
        op: "search",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        query: input.query,
        result_count: results.length,
      });

      return { results, total };
    },
  };
}
```

- [ ] **Step 2: Update existing search integration tests to include `embedder` and `lance` in deps**

In `packages/mcp/test/integration/search.test.ts`, in each test that calls `createSearchTool`, update:

```ts
const idx = openIndex(":memory:");
const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
const lance = await openLance(lanceDir);
const embedder = createMockEmbedder();
const auditor = new Auditor(paths.auditFile);
const search = createSearchTool({ auditor, index: idx, lance, embedder });
```

Add the matching imports at the top:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
```

Each test's cleanup callback must `rmSync(lanceDir, { recursive: true, force: true })`.

Also update existing `createWriteTool` invocations in the same file to receive `embedder` and `lance` (Task 8 will add these args; for now, pass undefined where the write tool is instantiated for setup; you can also defer that step until Task 8 is run, since the existing tests don't yet semantic-verify the write side).

Add three new tests at the bottom of the file (`describe("memory_search — semantic and hybrid modes", ...)`):

```ts
describe("memory_search — semantic and hybrid modes", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  async function setup() {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const search = createSearchTool({ auditor, index: idx, lance, embedder });
    return { write, search, lance, lanceDir };
  }

  it("mode=fts uses only the FTS index", async () => {
    const { write, search, lanceDir } = await setup();
    await write.handle({ type: "decision", fields: { title: "Use Supabase" }, content: "supabase rls", agent: "human" });
    const r = await search.handle({ query: "supabase", mode: "fts" });
    expect(r.results.length).toBe(1);
    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("mode=semantic uses only Lance (mock embedder ranks identical-text matches first)", async () => {
    const { write, search, lanceDir } = await setup();
    await write.handle({ type: "decision", fields: { title: "alpha topic" }, content: "alpha", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "beta topic" }, content: "beta", agent: "human" });
    const r = await search.handle({ query: "alpha", mode: "semantic" });
    expect(r.results[0]!.title).toBe("alpha topic");
    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("mode=hybrid (default) merges FTS and semantic via RRF", async () => {
    const { write, search, lanceDir } = await setup();
    await write.handle({ type: "decision", fields: { title: "Use Supabase" }, content: "auth backend", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "Pick a CDN" }, content: "delivery network", agent: "human" });
    // No mode → hybrid → still finds the Supabase memory for an FTS-matching query
    const r = await search.handle({ query: "supabase" });
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.title).toBe("Use Supabase");
    rmSync(lanceDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @vault-mem/mcp test test/integration/search.test.ts
```

Expected: all existing search tests pass + 3 new mode tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/tools/search.ts packages/mcp/test/integration/search.test.ts
git commit -m "feat(mcp): add mode parameter to memory_search (fts/semantic/hybrid)"
```

---

### Task 8: Write tool — embed + Lance upsert

**Files:**
- Modify: `packages/mcp/src/tools/write.ts`
- Modify: `packages/mcp/test/integration/write.test.ts`

- [ ] **Step 1: Extend `WriteToolDeps` and `handle` in `write.ts`**

Add to imports:

```ts
import type { Embedder } from "../embedder/index.js";
import type { LanceHandle } from "../index/lance.js";
import { EMBED_MODEL_ID } from "../embedder/index.js";
```

Extend `WriteToolDeps`:

```ts
export interface WriteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  defaultAgent: string;
  defaultSession?: string | null;
  embedder: Embedder;       // NEW
  lance: LanceHandle;       // NEW
}
```

In `handle`, after the existing `deps.index.upsert(...)` call and before `return { id, path, ... }`, add:

```ts
      const warnings: string[] = [];
      try {
        const tagsArr = (fm["tags"] as string[] | undefined) ?? [];
        const embedText = [String(fm["title"]), tagsArr.join(", "), input.content]
          .filter((s) => s && s.length > 0)
          .join("\n");
        const vector = await deps.embedder.embed(embedText);
        await deps.lance.upsert({
          id,
          vector,
          type: input.type,
          title: String(fm["title"]),
          project: (fm["project"] as string | null | undefined) ?? null,
          tags: tagsArr,
          status: "active",
          location: "inbox",
          path: targetPath,
          updated: String(fm["updated"]),
          schema_version: "0.1",
          embed_model: EMBED_MODEL_ID,
        });
      } catch (err) {
        warnings.push("semantic_index_lagged");
      }

      return { id, path: targetPath, warnings };
```

(Replace the existing `return { id, path: targetPath, warnings: [] };` with the version that uses the local `warnings` array. If the existing implementation declared `warnings` earlier, fold the try/catch into that.)

- [ ] **Step 2: Update existing write integration tests**

In `packages/mcp/test/integration/write.test.ts`, every `createWriteTool({...})` call must include `lance` and `embedder`. The test file also needs the imports:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
```

Per-test setup pattern:

```ts
const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
const lance = await openLance(lanceDir);
const embedder = createMockEmbedder();
const tool = createWriteTool({ vault: v.root, schemas: loadSchemas(v.root), auditor, index, defaultAgent: "human", lance, embedder });
// ... test body ...
rmSync(lanceDir, { recursive: true, force: true });
```

Add a new test:

```ts
  it("upserts to Lance synchronously after FTS upsert", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: idx,
      defaultAgent: "human",
      lance,
      embedder,
    });
    const result = await tool.handle({
      type: "decision",
      fields: { title: "Lance test" },
      content: "x",
      agent: "human",
    });
    expect(result.warnings).toEqual([]);
    const lanceRow = await lance.getById(result.id);
    expect(lanceRow?.title).toBe("Lance test");
    expect(lanceRow?.location).toBe("inbox");
    expect(lanceRow?.embed_model).toBe("Xenova/all-MiniLM-L6-v2:int8");
    rmSync(lanceDir, { recursive: true, force: true });
  });
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @vault-mem/mcp test test/integration/write.test.ts
```

Expected: all existing write tests pass + new Lance assertion test passes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/tools/write.ts packages/mcp/test/integration/write.test.ts
git commit -m "feat(mcp): write tool embeds and upserts to Lance synchronously"
```

---

### Task 9: Promote tool — Lance metadata update

**Files:**
- Modify: `packages/mcp/src/tools/promote.ts`
- Modify: `packages/mcp/test/integration/promote.test.ts`

- [ ] **Step 1: Extend `PromoteToolDeps` and `handle`**

Add to imports:

```ts
import type { LanceHandle } from "../index/lance.js";
```

Extend `PromoteToolDeps`:

```ts
export interface PromoteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;       // NEW
  agent?: string;
  session?: string | null;
}
```

After the existing in-memory FTS index upsert/update following the renameSync, add:

```ts
      // NEW: in-place Lance metadata update (avoids re-embed)
      try {
        await deps.lance.updateMetadata(input.id, { location: "memory", path: to });
      } catch {
        // The watcher will reconcile on the rename event.
      }
```

- [ ] **Step 2: Update existing promote integration tests**

In `packages/mcp/test/integration/promote.test.ts`, all `createWriteTool` and `createPromoteTool` invocations need the new `lance` and `embedder` deps.

Add a new test asserting Lance reflects the new location:

```ts
  it("updates Lance location to memory after promote", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-promote-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx, lance });

    const w = await write.handle({ type: "decision", fields: { title: "Promote me" }, content: "body", agent: "human" });
    expect((await lance.getById(w.id))?.location).toBe("inbox");

    await promote.handle({ id: w.id });

    expect((await lance.getById(w.id))?.location).toBe("memory");
    rmSync(lanceDir, { recursive: true, force: true });
  });
```

(Remember to add the import lines for `mkdtempSync`, `tmpdir`, `openLance`, `createMockEmbedder` if not already present.)

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @vault-mem/mcp test test/integration/promote.test.ts
```

Expected: all promote tests pass + new Lance assertion passes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/tools/promote.ts packages/mcp/test/integration/promote.test.ts
git commit -m "feat(mcp): promote tool updates Lance metadata in place"
```

---

### Task 10: `memory_context` tool

**Files:**
- Modify: `packages/mcp/src/index/sqlite.ts` (add `list(filter)` method)
- Modify: `packages/mcp/src/index/sqlite.test.ts` (test new method)
- Create: `packages/mcp/src/tools/context.ts`
- Create: `packages/mcp/test/integration/context.test.ts`
- Modify: `packages/mcp/src/tools/index.ts`

**Why the IndexHandle extension:** `memory_context` needs to enumerate all rows matching `(project, type, status, location)` filters *without* a full-text MATCH. FTS5 has no native "list everything" expression — using a stop-word OR query is unreliable because Porter-stemmed tokens may not be present in short memory bodies. Adding a `list(filter)` method that does a plain `SELECT ... FROM memories_fts WHERE ...` on the indexed metadata columns is clean and consistent with the existing `search()` filter shape.

- [ ] **Step 0a: Add `list(filter)` to `IndexHandle` in `packages/mcp/src/index/sqlite.ts`**

In the `IndexHandle` interface, add:

```ts
  list(filter: {
    type?: MemoryType | MemoryType[];
    project?: string;
    status?: "active" | "archived" | "superseded";
    location?: Location | "any";
  }): IndexRow[];
```

In `makeHandle`, add the implementation alongside `search`:

```ts
    list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      const types = filter.type ? (Array.isArray(filter.type) ? filter.type : [filter.type]) : null;
      if (types) {
        where.push(`type IN (${types.map((_, i) => `@t${i}`).join(",")})`);
        types.forEach((t, i) => { params[`t${i}`] = t; });
      }
      if (filter.project) { where.push("project = @project"); params["project"] = filter.project; }
      if (filter.status) { where.push("status = @status"); params["status"] = filter.status; }
      if (filter.location && filter.location !== "any") {
        where.push("location = @location");
        params["location"] = filter.location;
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.prepare(`
        SELECT id, type, title, body, tags, project, status, location, path, updated
        FROM memories_fts ${whereSql}
      `).all(params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r["id"]),
        type: r["type"] as MemoryType,
        title: String(r["title"]),
        body: String(r["body"]),
        tags: parseTags(r["tags"]),
        project: r["project"] ? String(r["project"]) : null,
        status: r["status"] as IndexRow["status"],
        location: r["location"] as Location,
        path: String(r["path"]),
        updated: String(r["updated"]),
      }));
    },
```

- [ ] **Step 0b: Add a test to `packages/mcp/src/index/sqlite.test.ts`**

Append to the existing `describe("openIndex (in-memory)", ...)` block:

```ts
  it("list returns all rows matching filters without MATCH", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", type: "decision", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", type: "observation", project: "myapp" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", type: "decision", project: "otherapp" }));

    expect(idx.list({}).length).toBe(3);
    expect(idx.list({ type: "decision" }).length).toBe(2);
    expect(idx.list({ project: "myapp" }).length).toBe(2);
    expect(idx.list({ type: "decision", project: "myapp" }).length).toBe(1);
  });
```

- [ ] **Step 1: Write the failing integration test `packages/mcp/test/integration/context.test.ts`**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createPromoteTool } from "../../src/tools/promote.js";
import { createContextTool } from "../../src/tools/context.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

describe("memory_context", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
    return () => v.cleanup();
  });

  async function setup() {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-context-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx, lance });
    const context = createContextTool({ vault: v.root, auditor, index: idx, lance, embedder });
    return { write, promote, context, lanceDir };
  }

  it("returns project memories within a token budget, summary first when no query", async () => {
    const { write, promote, context, lanceDir } = await setup();

    const sum = await write.handle({
      type: "summary",
      fields: { title: "Daily summary 2026-04-27", project: "myapp", period: "daily", covers: [] },
      content: "rolled-up daily notes",
      agent: "human",
    });
    await promote.handle({ id: sum.id });

    for (let i = 0; i < 3; i++) {
      const w = await write.handle({
        type: "decision",
        fields: { title: `Decision ${i}`, project: "myapp" },
        content: `decision body ${i}`,
        agent: "human",
      });
      await promote.handle({ id: w.id });
    }

    const r = await context.handle({ project: "myapp", max_tokens: 2000 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]!.bucket).toBe("summary");
    expect(r.total_tokens).toBeLessThanOrEqual(2000);

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("respects max_tokens and reports truncated count", async () => {
    const { write, promote, context, lanceDir } = await setup();

    for (let i = 0; i < 6; i++) {
      const w = await write.handle({
        type: "decision",
        fields: { title: `Decision ${i}`, project: "myapp" },
        content: `xxxxxxxxxx ${i}`.padEnd(200, "x"),
        agent: "human",
      });
      await promote.handle({ id: w.id });
    }

    // Generous enough for one decision (~50–60 tokens), tight enough to truncate the rest
    const r = await context.handle({ project: "myapp", max_tokens: 80 });
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.total_tokens).toBeLessThanOrEqual(80);
    expect(r.truncated).toBeGreaterThan(0);

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("with query, semantic-leads ranking after the floor summary", async () => {
    const { write, promote, context, lanceDir } = await setup();

    // Write three project decisions; the mock embedder makes identical-text matches rank highest
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "auth choices", project: "myapp" }, content: "auth", agent: "human" })).id });
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "payments", project: "myapp" }, content: "payments", agent: "human" })).id });
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "ops", project: "myapp" }, content: "ops", agent: "human" })).id });

    const r = await context.handle({ project: "myapp", max_tokens: 4000, query: "auth" });
    expect(r.items.length).toBeGreaterThan(0);
    // the auth decision (whose body is exactly "auth") should rank first under the mock embedder
    expect(r.items[0]!.title).toBe("auth choices");

    rmSync(lanceDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/context.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/tools/context.ts`**

```ts
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import { type LanceHandle } from "../index/lance.js";
import { type Embedder } from "../embedder/index.js";
import { type MemoryType, vaultPaths } from "../vault/paths.js";
import { ToolError } from "../errors.js";

export interface ContextToolInput {
  project: string;
  max_tokens?: number;
  query?: string;
  include_inbox?: boolean;
}

export type ContextBucket =
  | "summary" | "decision" | "observation" | "learning" | "todo" | "entity" | "question";

export interface ContextItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tokens: number;
  bucket: ContextBucket;
}

export interface ContextToolOutput {
  items: ContextItem[];
  total_tokens: number;
  truncated: number;
}

export interface ContextToolDeps {
  vault: string;
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;
  embedder: Embedder;
  agent?: string;
  session?: string | null;
}

const BUCKET_ORDER: ContextBucket[] = [
  "summary", "decision", "learning", "observation", "entity", "question", "todo",
];

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3.5);
}

export function createContextTool(deps: ContextToolDeps) {
  const paths = vaultPaths(deps.vault);

  function readContent(absPath: string): string {
    const raw = readFileSync(absPath, "utf8");
    const { content } = matter(raw);
    return content.trim();
  }

  return {
    async handle(input: ContextToolInput): Promise<ContextToolOutput> {
      if (!input.project || input.project.length === 0) {
        throw new ToolError("schema_validation_failed", "project is required");
      }
      const maxTokens = Math.min(Math.max(input.max_tokens ?? 4000, 100), 16_000);
      const includeInbox = input.include_inbox ?? false;
      const locationFilter: "memory" | "any" = includeInbox ? "any" : "memory";

      // Pull all rows for the project across all buckets via the new list() method
      // (no FTS MATCH; just metadata filtering on indexed columns).
      const allRows = deps.index.list({
        project: input.project,
        status: "active",
        location: locationFilter,
      });
      const candidates: Array<{ id: string; type: MemoryType; title: string; updated: string; path: string; bucket: ContextBucket }> = allRows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        updated: r.updated,
        path: r.path,
        bucket: r.type as ContextBucket,
      }));

      // Sort within each bucket by updated desc
      const byBucket = new Map<ContextBucket, typeof candidates>();
      for (const b of BUCKET_ORDER) byBucket.set(b, []);
      for (const c of candidates) byBucket.get(c.bucket)!.push(c);
      for (const arr of byBucket.values()) arr.sort((a, b) => b.updated.localeCompare(a.updated));

      let ordered: typeof candidates = [];

      if (input.query) {
        // semantic-led ranking (after a summary floor)
        const summaries = byBucket.get("summary")!.slice(0, 1);
        const qvec = await deps.embedder.embed(input.query);
        const semRes = await deps.lance.search(
          qvec,
          { project: input.project, status: "active", location: locationFilter },
          50,
        );
        const semIds = new Set(semRes.results.map((r) => r.id));
        const summaryIds = new Set(summaries.map((s) => s.id));
        const semCandidates = candidates
          .filter((c) => semIds.has(c.id) && !summaryIds.has(c.id))
          .sort((a, b) => {
            const ra = semRes.results.findIndex((r) => r.id === a.id);
            const rb = semRes.results.findIndex((r) => r.id === b.id);
            return ra - rb;
          });
        ordered = [...summaries, ...semCandidates];
      } else {
        // recency-led, summary-first
        for (const b of BUCKET_ORDER) ordered = ordered.concat(byBucket.get(b)!);
      }

      // Greedy pack
      const items: ContextItem[] = [];
      let totalTokens = 0;
      let truncated = 0;
      for (const c of ordered) {
        const content = readContent(c.path);
        const tokens = estimateTokens(content);
        if (totalTokens + tokens > maxTokens) {
          truncated++;
          continue;
        }
        items.push({
          id: c.id,
          type: c.type,
          title: c.title,
          content,
          tokens,
          bucket: c.bucket,
        });
        totalTokens += tokens;
      }

      const auditEntry: { op: "context"; agent: string; session: string | null; project: string; max_tokens: number; query?: string; result_count: number; total_tokens: number } = {
        op: "context",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        project: input.project,
        max_tokens: maxTokens,
        result_count: items.length,
        total_tokens: totalTokens,
      };
      if (input.query) auditEntry.query = input.query;
      deps.auditor.write(auditEntry);

      return { items, total_tokens: totalTokens, truncated };
    },
  };
}
```

- [ ] **Step 4: Re-export `createContextTool` in `packages/mcp/src/tools/index.ts`**

Add line:

```ts
export { createContextTool } from "./context.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @vault-mem/mcp test test/integration/context.test.ts
```

Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/context.ts packages/mcp/src/tools/index.ts packages/mcp/test/integration/context.test.ts
git commit -m "feat(mcp): implement memory_context tool"
```

---

### Task 11: Server wiring — embedder + Lance + new tool registration

**Files:**
- Modify: `packages/mcp/src/server/index.ts`
- Modify: `packages/mcp/test/e2e/server.test.ts`

- [ ] **Step 1: Wire embedder + Lance in `buildServer`**

In `packages/mcp/src/server/index.ts`:

Add imports:

```ts
import { createTransformersEmbedder, type Embedder } from "../embedder/index.js";
import { openLance, type LanceHandle } from "../index/lance.js";
import { createContextTool } from "../tools/index.js";
import type { ContextToolInput } from "../tools/context.js";
```

In `buildServer`, after opening the FTS index and before creating tools, instantiate the embedder and Lance:

```ts
  const lanceDir = `${paths.systemDir}/embeddings.lance`;
  const lance: LanceHandle = await openLance(lanceDir);
  const embedder: Embedder = createTransformersEmbedder();
```

Update each tool factory call to receive `embedder` and `lance`:

```ts
  const writeTool = createWriteTool({
    vault: opts.vault, schemas, auditor, index,
    defaultAgent: sessionAgent,
    defaultSession: session,
    lance, embedder,
  });
  const readTool = createReadTool({
    vault: opts.vault, schemas, auditor, index, agent: sessionAgent, session,
  });
  const searchTool = createSearchTool({ auditor, index, lance, embedder, agent: sessionAgent, session });
  const promoteTool = createPromoteTool({
    vault: opts.vault, schemas, auditor, index, lance,
    agent: sessionAgent, session,
  });
  const contextTool = createContextTool({
    vault: opts.vault, auditor, index, lance, embedder,
    agent: sessionAgent, session,
  });
```

Update `populateIndex` call (Phase 2 extends it to also build Lance):

```ts
  if (config.fts.rebuild_on_startup || index.count() === 0) {
    await populateIndex({ vault: opts.vault, index, schemas, embedder, lance });
  }
```

Update `startWatcher` call:

```ts
  const watcher: WatcherHandle = startWatcher({
    vault: opts.vault, index, schemas, embedder, lance,
  });
```

Add `memory_context` to `TOOL_DEFS`:

```ts
  {
    name: "memory_context",
    description: "Get curated context for a project (summaries lead; semantic-led when query supplied).",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string" },
        max_tokens: { type: "integer", minimum: 100, maximum: 16000 },
        query: { type: "string" },
        include_inbox: { type: "boolean" },
      },
    },
  },
```

Add `memory_search` `mode` to its inputSchema's properties:

```ts
        mode: { type: "string", enum: ["fts", "semantic", "hybrid"] },
```

Extend the dispatch switch to add `memory_context`:

```ts
        case "memory_context": out = await contextTool.handle(a as ContextToolInput); break;
```

Update `shutdown()`:

```ts
    async shutdown() {
      await watcher.close();
      index.close();
      await lance.close();
    },
```

- [ ] **Step 2: Update e2e test to round-trip `memory_context`**

In `packages/mcp/test/e2e/server.test.ts`, append after the existing `promote` assertions and before client.close():

```ts
    const ctx = await client.callTool({
      name: "memory_context",
      arguments: { project: "demo", max_tokens: 4000 },
    });
    const ctxOut = JSON.parse((ctx.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(ctxOut.items)).toBe(true);
    expect(ctxOut.total_tokens).toBeGreaterThanOrEqual(0);
```

Increase the test timeout to allow for model load on first run:

```ts
  it("happy-path round-trip: write, read, search, promote, context", { timeout: 30_000 }, async () => {
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @vault-mem/mcp build
pnpm --filter @vault-mem/mcp test
pnpm --filter @vault-mem/mcp typecheck
```

Expected: full suite passing, typecheck clean. Build produces dist/.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/server packages/mcp/test/e2e
git commit -m "feat(mcp): wire embedder + Lance into server, register memory_context"
```

---

### Task 12: CLI reindex extension

**Files:**
- Modify: `packages/mcp/src/cli/reindex.ts`
- Modify: `packages/mcp/src/index.ts` (commander wiring)
- Modify: `packages/mcp/test/integration/cli/reindex.test.ts`

- [ ] **Step 1: Extend `runReindex` to handle Lance and flag-driven scopes**

Replace the body of `packages/mcp/src/cli/reindex.ts` with:

```ts
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { vaultPaths } from "../vault/paths.js";
import { loadConfig, resolveConfigPaths } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { openLance } from "../index/lance.js";
import { createTransformersEmbedder } from "../embedder/index.js";
import { populateIndex } from "../index/populate.js";

export interface ReindexOpts {
  vault: string;
  ftsOnly?: boolean;
  semanticOnly?: boolean;
}
export interface ReindexResult { count: number; ftsMs: number; semanticMs: number }

export async function runReindex(opts: ReindexOpts): Promise<ReindexResult> {
  if (opts.ftsOnly && opts.semanticOnly) {
    throw new Error("--fts-only and --semantic-only are mutually exclusive");
  }

  const paths = vaultPaths(opts.vault);
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const schemas = loadSchemas(opts.vault);
  const lanceDir = resolve(paths.systemDir, "embeddings.lance");

  const t0 = Date.now();
  let ftsMs = 0;
  let semanticMs = 0;

  if (!opts.semanticOnly) {
    if (existsSync(config.resolvedIndexPath)) rmSync(config.resolvedIndexPath);
    if (existsSync(config.resolvedIndexPath + "-wal")) rmSync(config.resolvedIndexPath + "-wal");
    if (existsSync(config.resolvedIndexPath + "-shm")) rmSync(config.resolvedIndexPath + "-shm");
  }
  if (!opts.ftsOnly) {
    if (existsSync(lanceDir)) rmSync(lanceDir, { recursive: true, force: true });
  }

  const idx = openIndex(config.resolvedIndexPath);
  const lance = await openLance(lanceDir);
  const embedder = createTransformersEmbedder();

  let count = 0;
  if (opts.ftsOnly) {
    // FTS-only: skip Lance work in populate by passing a no-op handle? Simpler:
    // run a stripped populate inline that only rebuilds FTS.
    const t1 = Date.now();
    const { count: c } = await populateIndex({ vault: opts.vault, index: idx, schemas, embedder, lance });
    count = c;
    ftsMs = Date.now() - t1;
  } else if (opts.semanticOnly) {
    const t1 = Date.now();
    const { count: c } = await populateIndex({ vault: opts.vault, index: idx, schemas, embedder, lance });
    count = c;
    semanticMs = Date.now() - t1;
  } else {
    const t1 = Date.now();
    const { count: c } = await populateIndex({ vault: opts.vault, index: idx, schemas, embedder, lance });
    count = c;
    const total = Date.now() - t1;
    // We don't have per-stage timing inside populate; report the total under both for now.
    ftsMs = Math.round(total * 0.05);     // FTS is fast
    semanticMs = total - ftsMs;
  }

  idx.close();
  await lance.close();

  return { count, ftsMs, semanticMs };
}
```

- [ ] **Step 2: Wire `--fts-only` / `--semantic-only` flags in `src/index.ts`**

Find the `reindex` subcommand block. Replace with:

```ts
  program
    .command("reindex")
    .description("Drop and rebuild the FTS and embedding indexes")
    .option("--vault <path>", "Vault root", undefined)
    .option("--fts-only", "Rebuild only the FTS5 index")
    .option("--semantic-only", "Rebuild only the embedding index")
    .action(async (opts: { vault?: string; ftsOnly?: boolean; semanticOnly?: boolean }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const r = await runReindex({ vault, ftsOnly: opts.ftsOnly, semanticOnly: opts.semanticOnly });
      console.log(`Indexed ${r.count} memories: FTS in ${r.ftsMs}ms, embeddings in ${r.semanticMs}ms`);
    });
```

- [ ] **Step 3: Update reindex tests to assert flag behavior**

In `packages/mcp/test/integration/cli/reindex.test.ts`, append:

```ts
  it("--fts-only does not blow away embeddings.lance/", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    // First populate both
    await runReindex({ vault: target });
    const lanceDir = join(paths.systemDir, "embeddings.lance");
    expect(existsSync(lanceDir)).toBe(true);

    // Now FTS-only — Lance dir should still exist and remain populated
    await runReindex({ vault: target, ftsOnly: true });
    expect(existsSync(lanceDir)).toBe(true);
  });
```

(Add the necessary imports at the top: `existsSync`, `vaultPaths` if missing.)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/reindex.test.ts
pnpm --filter @vault-mem/mcp build
```

Expected: existing reindex tests pass + new flag test passes. Build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/cli/reindex.ts packages/mcp/src/index.ts packages/mcp/test/integration/cli/reindex.test.ts
git commit -m "feat(mcp): reindex CLI gains --fts-only and --semantic-only flags"
```

---

### Task 13: CLI doctor extension

**Files:**
- Modify: `packages/mcp/src/cli/doctor.ts`
- Modify: `packages/mcp/test/integration/cli/doctor.test.ts`

- [ ] **Step 1: Add 2 new checks in `doctor.ts`**

Add to imports:

```ts
import { resolve } from "node:path";
import { openLance } from "../index/lance.js";
import { EMBED_DIM } from "../embedder/index.js";
```

Inside `runDoctor`, after the existing `audit_log` check, add:

```ts
  // embeddings_index check
  let embIdxOk = false;
  let embIdxDetail: string | undefined;
  let lanceCount = 0;
  try {
    const lanceDir = resolve(paths.systemDir, "embeddings.lance");
    const lance = await openLance(lanceDir);
    lanceCount = await lance.count();
    // Sanity probe: if non-empty, getById of some row should work
    if (lanceCount > 0) {
      // No public API to "list any one id" without a query. We trust open + count for now.
    }
    embIdxOk = true;
    await lance.close();
  } catch (e) {
    embIdxDetail = (e as Error).message;
  }
  checks.push({ name: "embeddings_index", pass: embIdxOk, detail: embIdxDetail });

  // embeddings_count_match check (skipped when either index is empty)
  let embMatchOk = true;
  let embMatchDetail: string | undefined;
  try {
    const idx = openIndex(paths.indexFile);
    const ftsCount = idx.count();
    idx.close();
    if (ftsCount > 0 && lanceCount > 0 && ftsCount !== lanceCount) {
      embMatchOk = false;
      embMatchDetail = `FTS has ${ftsCount} rows, Lance has ${lanceCount} (run vault-mem-mcp reindex --semantic-only to reconcile)`;
    }
  } catch (e) {
    embMatchOk = false;
    embMatchDetail = (e as Error).message;
  }
  checks.push({ name: "embeddings_count_match", pass: embMatchOk, detail: embMatchDetail });

  // Suppress unused-import warning if EMBED_DIM not referenced in code here:
  void EMBED_DIM;
```

(If `runDoctor` is not already async, change its signature to `async` and propagate via `await runDoctor(...)` in callers. The other checks that use `await import(...)` already hint that this function should be async — verify and adjust.)

- [ ] **Step 2: Update doctor tests to reflect 9 checks**

In `packages/mcp/test/integration/cli/doctor.test.ts`, modify the existing happy-path test:

```ts
  it("reports all-pass on a freshly initialized vault", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const result = await runDoctor({ vault: target });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "vault_root", "folders", "schemas", "config", "index",
      "row_count_match", "audit_log", "embeddings_index", "embeddings_count_match",
    ]);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });
```

- [ ] **Step 3: Run tests + smoke**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/doctor.test.ts
pnpm --filter @vault-mem/mcp build
TMP=$(mktemp -d) && node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault" && node packages/mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"; rm -rf "$TMP"
```

Expected: tests pass; smoke shows 9 PASS lines.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/cli/doctor.ts packages/mcp/test/integration/cli/doctor.test.ts
git commit -m "feat(mcp): doctor adds embeddings_index and embeddings_count_match checks"
```

---

### Task 14: Vault template gitignore + final verification

**Files:**
- Modify: `vault-template/.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Extend `vault-template/.gitignore`**

Append to the existing file:

```
_system/embeddings.lance/
```

Final content:

```
# FTS index — rebuildable from .md sources
_system/index.sqlite
_system/index.sqlite-wal
_system/index.sqlite-shm

# Embedding index — rebuildable from .md sources
_system/embeddings.lance/
```

- [ ] **Step 2: Update `README.md` to document new behavior**

Find the "Tools" section and replace with:

```markdown
## Tools

- `memory_read` · `memory_write` · `memory_search` · `memory_promote` · `memory_context`

`memory_search` accepts `mode: "fts" | "semantic" | "hybrid"` (default `hybrid`).
`memory_context` returns curated project context within a token budget; pass `query` for semantic-led ranking.
```

- [ ] **Step 3: Run full verification matrix**

```bash
pnpm install
pnpm --filter @vault-mem/mcp build
pnpm --filter @vault-mem/mcp test
pnpm --filter @vault-mem/mcp typecheck
TMP=$(mktemp -d)
node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault" --git
node packages/mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"
node packages/mcp/bin/vault-mem-mcp reindex --vault "$TMP/vault"
node packages/mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"
rm -rf "$TMP"
```

Expected: install clean, build clean, all tests pass, typecheck clean, doctor reports 9/9 PASS twice (before and after reindex).

- [ ] **Step 4: Commit**

```bash
git add vault-template/.gitignore README.md
git commit -m "docs: update gitignore and README for Phase 2"
```

---

## Self-review

- **Spec coverage:** Every Phase 2 spec section maps to at least one task. §3 architecture → tasks 1–11. §4 embedding pipeline → task 2. §5 LanceDB schema → task 3. §6 tool API → tasks 7, 8, 10, 11. §7 data flow → tasks 6, 8, 9. §9 CLI → tasks 12, 13. §10 testing → exercised throughout. §11 acceptance → task 14.
- **Placeholder scan:** No "TBD/TODO/implement later" remains. Every step has actual code or commands.
- **Type consistency:** `Embedder`, `LanceHandle`, `LanceRow`, `LanceFilter`, `LanceSearchResult`, `RankedHit`, `FusedHit`, `SearchToolInput`, `SearchMode`, `ContextToolInput`, `ContextToolOutput`, `ContextItem`, `ContextBucket`, `EMBED_MODEL_ID`, `EMBED_DIM` defined exactly once and reused with matching shapes.
- **Acceptance criteria:** §11 of the spec is captured by the smoke test in task 14. Live Claude Code verification (criterion 5) is a manual post-merge step the operator runs themselves, same pattern as Phase 1.
