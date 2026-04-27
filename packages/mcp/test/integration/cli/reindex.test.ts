import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { runInit } from "../../../src/cli/init.js";
import { runReindex } from "../../../src/cli/reindex.js";
import { vaultPaths } from "../../../src/vault/paths.js";
import { openLance } from "../../../src/index/lance.js";

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

  it("--fts-only does not re-embed (Lance row vectors stay byte-identical)", async () => {
    const target = join(dir, "vault");
    await runInit({ target });

    // Initial full reindex (embeds all rows including the sample decision)
    await runReindex({ vault: target });
    const paths = vaultPaths(target);
    const lanceDir = join(paths.systemDir, "embeddings.lance");

    // Capture Lance state via a direct openLance probe
    const probe1 = await openLance(lanceDir);
    const before = await probe1.getById("mem_2026-04-27_000001");
    await probe1.close();
    expect(before).not.toBeNull();
    const beforeVec = Array.from(before!.vector);

    // Now run --fts-only and assert Lance vector is byte-identical (not re-embedded)
    await runReindex({ vault: target, ftsOnly: true });
    const probe2 = await openLance(lanceDir);
    const after = await probe2.getById("mem_2026-04-27_000001");
    await probe2.close();
    expect(after).not.toBeNull();
    const afterVec = Array.from(after!.vector);

    expect(afterVec).toEqual(beforeVec);
  });
});
