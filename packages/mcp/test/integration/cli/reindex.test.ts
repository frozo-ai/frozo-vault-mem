import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { runInit } from "../../../src/cli/init.js";
import { runReindex } from "../../../src/cli/reindex.js";
import { vaultPaths } from "../../../src/vault/paths.js";

describe("reindex", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-reidx-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds the FTS index from disk", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    mkdirSync(paths.memoryDir("decision"), { recursive: true });
    writeFileSync(
      paths.memoryFile("decision", "mem_2026-04-27_aabbcc", "memory"),
      matter.stringify("body", {
        id: "mem_2026-04-27_aabbcc",
        type: "decision",
        title: "rebuilt",
        agent: "human",
        session: null,
        created: "2026-04-27T14:32:00.000Z",
        updated: "2026-04-27T14:32:00.000Z",
        status: "active",
        schema_version: "0.1",
        confidence: 1, sources: [], contradicts: [], supersedes: [], tags: [],
        project: null, ttl_days: null, human_reviewed: false, human_approved: null,
      }),
    );
    const result = await runReindex({ vault: target });
    expect(result.count).toBeGreaterThanOrEqual(2); // sample + the new one
    // Result now has ftsMs + semanticMs
    expect(typeof result.ftsMs).toBe("number");
    expect(typeof result.semanticMs).toBe("number");
  });

  it("--fts-only does not remove embeddings.lance directory", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    const lanceDir = join(paths.systemDir, "embeddings.lance");

    // First full reindex to create lance dir
    await runReindex({ vault: target });
    expect(existsSync(lanceDir)).toBe(true);

    // FTS-only reindex should leave lance dir intact
    const result = await runReindex({ vault: target, ftsOnly: true });
    expect(existsSync(lanceDir)).toBe(true);
    expect(result.ftsMs).toBeGreaterThanOrEqual(0);
    expect(result.semanticMs).toBe(0);
  });

  it("throws when both --fts-only and --semantic-only are passed", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    await expect(
      runReindex({ vault: target, ftsOnly: true, semanticOnly: true }),
    ).rejects.toThrow("mutually exclusive");
  });
});
