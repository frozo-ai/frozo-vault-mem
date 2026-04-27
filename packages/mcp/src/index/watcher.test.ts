import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex } from "./sqlite.js";
import { startWatcher } from "./watcher.js";
import { loadSchemas } from "../schema/index.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import { openLance } from "./lance.js";
import { createMockEmbedder } from "../embedder/mock.js";
import matter from "gray-matter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sampleFm = (id: string) => ({
  id,
  type: "decision",
  title: "Watcher test",
  agent: "human",
  session: null,
  created: "2026-04-27T14:32:00.000Z",
  updated: "2026-04-27T14:32:00.000Z",
  status: "active",
  schema_version: "0.1",
  confidence: 1,
  sources: [], contradicts: [], supersedes: [], tags: [],
  project: null, ttl_days: null, human_reviewed: false, human_approved: null,
});

describe("startWatcher", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
    return () => v.cleanup();
  });

  it("upserts on file add and removes on unlink", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
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
    await sleep(150);

    const id = "mem_2026-04-27_aaaaaa";
    const file = paths.memoryFile("decision", id, "memory");
    writeFileSync(file, matter.stringify("body", sampleFm(id)));
    await sleep(300);
    expect(idx.getById(id)?.title).toBe("Watcher test");

    // After the file is added, the Lance row should also exist
    const lanceRow = await lance.getById(id);
    expect(lanceRow?.title).toBe("Watcher test");

    rmSync(file);
    await sleep(300);
    expect(idx.getById(id)).toBeNull();
    expect(await lance.getById(id)).toBeNull();

    await w.close();
    await lance.close();
    rmSync(lanceDir, { recursive: true, force: true });
  });
});
