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
