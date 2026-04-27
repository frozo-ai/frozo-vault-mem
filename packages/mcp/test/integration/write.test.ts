import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.write", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("writes a valid decision to inbox/decisions/, audits, and indexes", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
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
  });

  it("rejects missing required fields without writing anything", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
    });

    await expect(
      tool.handle({
        type: "decision",
        fields: {},  // missing title
        content: "x",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });
  });

  it("requires todo_status for type=todo", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
    });

    await expect(
      tool.handle({
        type: "todo",
        fields: { title: "ship phase 1" },
        content: "",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });
  });
});
