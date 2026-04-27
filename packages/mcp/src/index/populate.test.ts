import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex } from "./sqlite.js";
import { populateIndex } from "./populate.js";
import { loadSchemas } from "../schema/index.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";

const fm = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: "decision", title: "Pop test " + id, agent: "human", session: null,
  created: "2026-04-27T14:32:00.000Z", updated: "2026-04-27T14:32:00.000Z",
  status: "active", schema_version: "0.1", confidence: 1,
  sources: [], contradicts: [], supersedes: [], tags: [],
  project: null, ttl_days: null, human_reviewed: false, human_approved: null,
  ...over,
});

describe("populateIndex", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) {
      mkdirSync(paths.memoryDir(t), { recursive: true });
      mkdirSync(paths.inboxDir(t), { recursive: true });
    }
    return () => v.cleanup();
  });

  it("walks the vault and indexes all .md files", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");

    writeFileSync(paths.memoryFile("decision", "mem_2026-04-27_aaaaaa", "memory"),
      matter.stringify("body a", fm("mem_2026-04-27_aaaaaa")));
    writeFileSync(paths.memoryFile("decision", "mem_2026-04-27_bbbbbb", "inbox"),
      matter.stringify("body b", fm("mem_2026-04-27_bbbbbb")));

    await populateIndex({ vault: v.root, index: idx, schemas });

    expect(idx.getById("mem_2026-04-27_aaaaaa")?.location).toBe("memory");
    expect(idx.getById("mem_2026-04-27_bbbbbb")?.location).toBe("inbox");
    // sample-decision.md should also have been indexed
    expect(idx.getById("mem_2026-04-27_000001")?.title).toBe("Use Supabase for KinCare auth");
  });
});
