import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/init.js";

describe("init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-init-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("materializes a vault from the template", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    expect(existsSync(join(target, "_system/schema/_common.json"))).toBe(true);
    expect(existsSync(join(target, "_system/config.yaml"))).toBe(true);
    expect(existsSync(join(target, "memory/decisions/sample-decision.md"))).toBe(true);
    const cfg = readFileSync(join(target, "_system/config.yaml"), "utf8");
    expect(cfg).toMatch(/vault_id:/);
  });

  it("refuses to overwrite a non-empty target", async () => {
    const target = join(dir, "vault");
    writeFileSync(join(dir, "vault"), "");  // file in the way
    await expect(runInit({ target })).rejects.toThrow();
  });
});
