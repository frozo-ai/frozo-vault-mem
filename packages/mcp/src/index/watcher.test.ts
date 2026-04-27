import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex } from "./sqlite.js";
import { startWatcher } from "./watcher.js";
import { loadSchemas } from "../schema/index.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
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
    const w = startWatcher({ vault: v.root, index: idx, schemas: loadSchemas(v.root), debounceMs: 50 });
    await sleep(150);

    const id = "mem_2026-04-27_aaaaaa";
    const file = paths.memoryFile("decision", id, "memory");
    writeFileSync(file, matter.stringify("body", sampleFm(id)));
    await sleep(300);
    expect(idx.getById(id)?.title).toBe("Watcher test");

    rmSync(file);
    await sleep(300);
    expect(idx.getById(id)).toBeNull();

    await w.close();
  });
});
