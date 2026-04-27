import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { openLance } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.write", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("writes a valid decision to inbox/decisions/, audits, and indexes", async () => {
    const paths = vaultPaths(v.root);
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
      lance,
      embedder,
    });

    const result = await tool.handle({
      type: "decision",
      fields: { title: "Test decision", project: "demo", tags: ["x"] },
      content: "## Rationale\n\nbecause",
      agent: "claude-code",
      session: "01HX",
    });

    expect(result.id).toMatch(/^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/);
    const expectedPath = paths.memoryFile("decision", result.id, "inbox");
    expect(result.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const { data, content } = matter(readFileSync(expectedPath, "utf8"));
    expect(data.id).toBe(result.id);
    expect(data.type).toBe("decision");
    expect(data.title).toBe("Test decision");
    expect(data.agent).toBe("claude-code");
    expect(data.status).toBe("active");
    expect(data.schema_version).toBe("0.1");
    expect(content.trim()).toBe("## Rationale\n\nbecause");

    const audit = readFileSync(paths.auditFile, "utf8").trim().split("\n").pop()!;
    const auditEntry = JSON.parse(audit);
    expect(auditEntry.op).toBe("write");
    expect(auditEntry.id).toBe(result.id);

    await lance.close();
    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("rejects missing required fields without writing anything", async () => {
    const paths = vaultPaths(v.root);
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
      lance,
      embedder,
    });

    await expect(
      tool.handle({
        type: "decision",
        fields: {},  // missing title
        content: "x",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("requires todo_status for type=todo", async () => {
    const paths = vaultPaths(v.root);
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
      lance,
      embedder,
    });

    await expect(
      tool.handle({
        type: "todo",
        fields: { title: "ship phase 1" },
        content: "",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });

    rmSync(lanceDir, { recursive: true, force: true });
  });

  it("uses defaultSession from deps when no session is in input", async () => {
    const paths = vaultPaths(v.root);
    const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-write-lance-"));
    const lance = await openLance(lanceDir);
    const embedder = createMockEmbedder();
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
      defaultSession: "01HXSESSION0000000000000",
      lance,
      embedder,
    });
    const result = await tool.handle({
      type: "decision",
      fields: { title: "Session test" },
      content: "x",
    });
    const matterMod = (await import("gray-matter")).default;
    const { readFileSync: rfs } = await import("node:fs");
    const { data } = matterMod(rfs(result.path, "utf8"));
    expect(data.session).toBe("01HXSESSION0000000000000");

    rmSync(lanceDir, { recursive: true, force: true });
  });

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
});
