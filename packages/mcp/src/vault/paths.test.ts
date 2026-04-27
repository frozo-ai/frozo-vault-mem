import { describe, expect, it } from "vitest";
import { resolveVaultPath, MEMORY_TYPES, type MemoryType, type Location, vaultPaths } from "./paths.js";

describe("resolveVaultPath", () => {
  it("prefers --vault flag over env over default", () => {
    expect(resolveVaultPath({ flag: "/a", env: "/b", home: "/h" })).toBe("/a");
    expect(resolveVaultPath({ flag: undefined, env: "/b", home: "/h" })).toBe("/b");
    expect(resolveVaultPath({ flag: undefined, env: undefined, home: "/h" })).toBe("/h/vault-mem");
  });
});

describe("MEMORY_TYPES", () => {
  it("includes the 7 documented types", () => {
    expect(MEMORY_TYPES).toEqual([
      "decision", "observation", "todo",
      "learning", "summary", "entity", "question",
    ]);
  });
});

describe("vaultPaths", () => {
  it("constructs canonical absolute paths for a given vault", () => {
    const p = vaultPaths("/vault");
    expect(p.root).toBe("/vault");
    expect(p.systemDir).toBe("/vault/_system");
    expect(p.schemaDir).toBe("/vault/_system/schema");
    expect(p.configFile).toBe("/vault/_system/config.yaml");
    expect(p.auditFile).toBe("/vault/_system/audit.log");
    expect(p.indexFile).toBe("/vault/_system/index.sqlite");
    expect(p.memoryDir("decision" as MemoryType)).toBe("/vault/memory/decisions");
    expect(p.inboxDir("decision" as MemoryType)).toBe("/vault/inbox/decisions");
    expect(p.archiveDir).toBe("/vault/archive");
  });

  it("memoryFile returns the right path for a given location", () => {
    const p = vaultPaths("/vault");
    const id = "mem_2026-04-27_a8f3c0";
    expect(p.memoryFile("decision" as MemoryType, id, "inbox" as Location)).toBe(
      "/vault/inbox/decisions/mem_2026-04-27_a8f3c0.md",
    );
    expect(p.memoryFile("decision" as MemoryType, id, "memory" as Location)).toBe(
      "/vault/memory/decisions/mem_2026-04-27_a8f3c0.md",
    );
    expect(p.memoryFile("decision" as MemoryType, id, "archive" as Location)).toBe(
      "/vault/archive/mem_2026-04-27_a8f3c0.md",
    );
  });
});
