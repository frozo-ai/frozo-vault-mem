import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createReadTool } from "../../src/tools/read.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.read", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("returns frontmatter, content, path, location for an existing memory", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-read-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();

    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const read = createReadTool({ vault: v.root, schemas, auditor, index: idx });

    const written = await write.handle({
      type: "decision",
      fields: { title: "Read test" },
      content: "body text here",
      agent: "human",
    });

    const result = await read.handle({ id: written.id });
    expect(result.id).toBe(written.id);
    expect(result.type).toBe("decision");
    expect(result.frontmatter.title).toBe("Read test");
    expect(result.content.trim()).toBe("body text here");
    expect(result.location).toBe("inbox");

    await lance.close();
    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("throws not_found for an unknown id", async () => {
    const paths = vaultPaths(v.root);
    const read = createReadTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
    });
    await expect(read.handle({ id: "mem_2026-04-27_zzzzzz" })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns the sample-decision.md from the materialized vault", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    // The sample file on disk is named sample-decision.md (not by ID).
    // Manually index the sample pointing to the actual file path (simulates startup populate).
    const samplePath = paths.memoryDir("decision") + "/sample-decision.md";
    idx.upsert({
      id: "mem_2026-04-27_000001",
      type: "decision",
      title: "Use Supabase for KinCare auth",
      body: "",
      tags: ["kincare", "auth", "architecture"],
      project: "kincare",
      status: "active",
      location: "memory",
      path: samplePath,
      updated: "2026-04-27T14:32:00.000Z",
    });
    const read = createReadTool({
      vault: v.root,
      schemas,
      auditor: new Auditor(paths.auditFile),
      index: idx,
    });
    const result = await read.handle({ id: "mem_2026-04-27_000001" });
    expect(result.frontmatter.title).toBe("Use Supabase for KinCare auth");
    expect(result.location).toBe("memory");
  });
});
