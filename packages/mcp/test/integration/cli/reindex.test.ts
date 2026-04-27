import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  });
});
