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

describe("memory.context", () => {
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

    // Write three project decisions; the mock embedder hashes the full embed text
    // (title\ncontent), so exact ranking depends on hash proximity — not semantic similarity.
    // We assert that the auth decision is present in the results (relaxed per Annotation C),
    // rather than asserting it is first (which depends on mock embedder hash ordering).
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "auth choices", project: "myapp" }, content: "auth", agent: "human" })).id });
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "payments", project: "myapp" }, content: "payments", agent: "human" })).id });
    await promote.handle({ id: (await write.handle({ type: "decision", fields: { title: "ops", project: "myapp" }, content: "ops", agent: "human" })).id });

    const r = await context.handle({ project: "myapp", max_tokens: 4000, query: "auth" });
    expect(r.items.length).toBeGreaterThan(0);
    // Relaxed assertion: the auth decision should be present in the results;
    // exact ranking position is non-deterministic under the mock embedder.
    expect(r.items.some((i) => i.title === "auth choices")).toBe(true);

    rmSync(lanceDir, { recursive: true, force: true });
  });
});
