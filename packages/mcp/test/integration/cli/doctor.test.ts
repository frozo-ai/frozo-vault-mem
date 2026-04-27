import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/init.js";
import { runDoctor } from "../../../src/cli/doctor.js";

describe("doctor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-doctor-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("reports all-pass on a freshly initialized vault", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const result = await runDoctor({ vault: target });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it("fails when config.yaml is missing", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    rmSync(join(target, "_system/config.yaml"));
    const result = await runDoctor({ vault: target });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "config")?.pass).toBe(false);
  });
});
