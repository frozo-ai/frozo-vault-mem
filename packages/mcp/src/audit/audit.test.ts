import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "./index.js";

describe("Auditor", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-audit-"));
    mkdirSync(join(dir, "_system"));
    logPath = join(dir, "_system/audit.log");
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per call", () => {
    const a = new Auditor(logPath);
    a.write({ op: "write", agent: "claude-code", session: "01H", id: "mem_2026-04-27_aaaaaa", type: "decision", path: "x.md", schema_version: "0.1" });
    a.write({ op: "read", agent: "cursor", session: "02H", id: "mem_2026-04-27_aaaaaa" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.op).toBe("write");
    expect(first.v).toBe(1);
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("hashes search queries instead of storing them raw", () => {
    const a = new Auditor(logPath);
    a.write({ op: "search", agent: "claude-code", session: "01H", query: "kincare auth", result_count: 4 });
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.query).toBeUndefined();
    expect(line.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(line.result_count).toBe(4);
  });
});
