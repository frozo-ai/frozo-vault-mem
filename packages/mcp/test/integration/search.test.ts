import { describe, expect, it, beforeEach } from "vitest";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createSearchTool } from "../../src/tools/search.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.search", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("finds memories matching the query and respects filters", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const search = createSearchTool({ auditor, index: idx });

    await write.handle({ type: "decision", fields: { title: "Use Supabase", project: "kincare" }, content: "supabase has rls", agent: "human" });
    await write.handle({ type: "observation", fields: { title: "Pricing", project: "kincare" }, content: "supabase free tier", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "Other choice", project: "frozo" }, content: "unrelated content", agent: "human" });

    const r1 = await search.handle({ query: "supabase" });
    expect(r1.results.length).toBe(2);

    const r2 = await search.handle({ query: "supabase", type: "decision" });
    expect(r2.results.length).toBe(1);
    expect(r2.results[0]!.title).toBe("Use Supabase");

    const r3 = await search.handle({ query: "supabase", project: "kincare" });
    expect(r3.results.length).toBe(2);
  });

  it("returns empty results, total 0, on no match", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const search = createSearchTool({ auditor, index: idx });
    const r = await search.handle({ query: "nothing-matches" });
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);
  });
});
