import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createPromoteTool } from "../../src/tools/promote.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

describe("memory.promote", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    // Ensure all memory subfolders exist
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
    return () => v.cleanup();
  });

  it("moves an inbox memory to memory/<type>/", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx });

    const w = await write.handle({ type: "decision", fields: { title: "Promote me" }, content: "body", agent: "human" });
    expect(existsSync(w.path)).toBe(true);

    const p = await promote.handle({ id: w.id });
    expect(p.from).toBe(paths.memoryFile("decision", w.id, "inbox"));
    expect(p.to).toBe(paths.memoryFile("decision", w.id, "memory"));
    expect(existsSync(p.from)).toBe(false);
    expect(existsSync(p.to)).toBe(true);

    // Index reflects new location after promote (we update synchronously; watcher will also fire)
    const row = idx.getById(w.id);
    expect(row?.location).toBe("memory");
  });

  it("rejects promote for a memory not in inbox", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx });

    const w = await write.handle({ type: "decision", fields: { title: "x" }, content: "x", agent: "human" });
    await promote.handle({ id: w.id });
    await expect(promote.handle({ id: w.id })).rejects.toMatchObject({ kind: "not_in_inbox" });
  });

  it("rejects promote for an unknown id", async () => {
    const paths = vaultPaths(v.root);
    const promote = createPromoteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
    });
    await expect(promote.handle({ id: "mem_2026-04-27_zzzzzz" })).rejects.toMatchObject({ kind: "not_found" });
  });
});
