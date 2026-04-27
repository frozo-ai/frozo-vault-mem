import { describe, expect, it, beforeEach } from "vitest";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createSearchTool, buildFtsQuery } from "../../src/tools/search.js";
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

describe("buildFtsQuery", () => {
  it("converts hyphenated multi-word queries into prefix-match AND tokens", () => {
    expect(buildFtsQuery("freshly-shipped vault-mem MCP")).toBe(
      "freshly* shipped* vault* mem* mcp*",
    );
  });

  it("lowercases tokens", () => {
    expect(buildFtsQuery("DPDP CamelCase")).toBe("dpdp* camelcase*");
  });

  it("returns empty string for whitespace-only or punctuation-only input", () => {
    expect(buildFtsQuery("")).toBe("");
    expect(buildFtsQuery("   ")).toBe("");
    expect(buildFtsQuery("--__??")).toBe("");
  });

  it("handles unicode letters", () => {
    expect(buildFtsQuery("café résumé")).toBe("café* résumé*");
  });

  it("treats slashes, quotes, parens as separators", () => {
    expect(buildFtsQuery('use "Supabase/Auth0" (rejected)')).toBe(
      "use* supabase* auth0* rejected*",
    );
  });
});

describe("memory.search — query sanitization regression", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("finds a memory whose title contains hyphenated terms via a hyphenated query", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const search = createSearchTool({ auditor, index: idx });

    await write.handle({
      type: "decision",
      fields: { title: "Test the freshly-shipped vault-mem MCP", project: "vault-mem", tags: ["meta"] },
      content: "live round-trip verification",
      agent: "human",
    });

    // The exact failing query from the live test
    const r = await search.handle({ query: "freshly-shipped vault-mem MCP" });
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.title).toBe("Test the freshly-shipped vault-mem MCP");
  });

  it("returns empty results (not an error) for a punctuation-only query", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const search = createSearchTool({ auditor, index: idx });
    const r = await search.handle({ query: "---" });
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("partial-word search hits via prefix matching", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const search = createSearchTool({ auditor, index: idx });

    await write.handle({
      type: "decision",
      fields: { title: "Authentication strategy" },
      content: "we use Supabase for auth",
      agent: "human",
    });
    // "auth" should hit "Authentication" and "auth" via prefix
    const r = await search.handle({ query: "auth" });
    expect(r.results.length).toBe(1);
  });
});
