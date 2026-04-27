import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createSearchTool, buildFtsQuery } from "../../src/tools/search.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
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
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const search = createSearchTool({ auditor, index: idx, lance, embedder });

    await write.handle({ type: "decision", fields: { title: "Use Supabase", project: "kincare" }, content: "supabase has rls", agent: "human" });
    await write.handle({ type: "observation", fields: { title: "Pricing", project: "kincare" }, content: "supabase free tier", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "Other choice", project: "frozo" }, content: "unrelated content", agent: "human" });

    // After writes, Lance should have rows for the written memories
    expect(await lance.count()).toBeGreaterThanOrEqual(1);

    const r1 = await search.handle({ query: "supabase", mode: "fts" });
    expect(r1.results.length).toBe(2);

    const r2 = await search.handle({ query: "supabase", type: "decision", mode: "fts" });
    expect(r2.results.length).toBe(1);
    expect(r2.results[0]!.title).toBe("Use Supabase");

    const r3 = await search.handle({ query: "supabase", project: "kincare", mode: "fts" });
    expect(r3.results.length).toBe(2);

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("returns empty results, total 0, on no match", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const search = createSearchTool({ auditor, index: idx, lance, embedder });
    const r = await search.handle({ query: "nothing-matches", mode: "fts" });
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);

    rmSync(lanceDir, { recursive: true, force: true });
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
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const search = createSearchTool({ auditor, index: idx, lance, embedder });

    await write.handle({
      type: "decision",
      fields: { title: "Test the freshly-shipped vault-mem MCP", project: "vault-mem", tags: ["meta"] },
      content: "live round-trip verification",
      agent: "human",
    });

    // The exact failing query from the live test
    const r = await search.handle({ query: "freshly-shipped vault-mem MCP", mode: "fts" });
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.title).toBe("Test the freshly-shipped vault-mem MCP");

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("returns empty results (not an error) for a punctuation-only query", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const search = createSearchTool({ auditor, index: idx, lance, embedder });
    const r = await search.handle({ query: "---", mode: "fts" });
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("partial-word search hits via prefix matching", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-search-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human", lance, embedder });
    const search = createSearchTool({ auditor, index: idx, lance, embedder });

    await write.handle({
      type: "decision",
      fields: { title: "Authentication strategy" },
      content: "we use Supabase for auth",
      agent: "human",
    });
    // "auth" should hit "Authentication" and "auth" via prefix
    const r = await search.handle({ query: "auth", mode: "fts" });
    expect(r.results.length).toBe(1);

    rmSync(lanceDir, { recursive: true, force: true });
  });
});

describe("memory.search — semantic and hybrid modes", () => {
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
    return { write, search, lance, embedder, lanceDir, paths };
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
    // Use empty content so embedText == title only, letting query "alpha topic" match exactly
    await write.handle({ type: "decision", fields: { title: "alpha topic" }, content: "", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "beta topic" }, content: "", agent: "human" });
    const r = await search.handle({ query: "alpha topic", mode: "semantic" });
    expect(r.results[0]!.title).toBe("alpha topic");
    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("mode=hybrid (default) merges FTS and semantic via RRF", async () => {
    const { write, search, lanceDir } = await setup();
    await write.handle({ type: "decision", fields: { title: "Use Supabase" }, content: "auth backend", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "Pick a CDN" }, content: "delivery network", agent: "human" });
    // No mode → hybrid → FTS finds only "Use Supabase"; semantic returns both since query
    // "supabase" does not perfectly match any embed; RRF merges and result[0] is Supabase.
    const r = await search.handle({ query: "supabase" });
    expect(r.results[0]!.title).toBe("Use Supabase");
    rmSync(lanceDir, { recursive: true, force: true });
  });
});
