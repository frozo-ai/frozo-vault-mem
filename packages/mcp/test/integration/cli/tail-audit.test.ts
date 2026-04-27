import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runInit } from "../../../src/cli/init.js";
import { runTailAudit } from "../../../src/cli/tail-audit.js";
import { vaultPaths } from "../../../src/vault/paths.js";

describe("tail-audit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-tail-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("prints the last N audit lines", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    for (let i = 0; i < 10; i++) {
      appendFileSync(paths.auditFile, JSON.stringify({ ts: "2026-04-27T0:00:0Z", v: 1, op: "write", id: `mem_2026-04-27_aaaa${i}` }) + "\n");
    }
    let captured = "";
    const out = new Writable({
      write(chunk, _enc, cb) { captured += chunk.toString(); cb(); },
    });
    await runTailAudit({ vault: target, n: 3, out });
    const lines = captured.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("mem_2026-04-27_aaaa9");
  });
});
