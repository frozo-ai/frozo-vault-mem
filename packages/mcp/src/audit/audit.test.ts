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
    a.write({ op: "search", agent: "claude-code", session: "01H", query: "kincare auth", result_count: 4, mode: "fts" });
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.query).toBeUndefined();
    expect(line.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(line.result_count).toBe(4);
  });

  it("records search mode in audit entries", () => {
    const a = new Auditor(logPath);
    a.write({
      op: "search",
      agent: "claude-code",
      session: "01H",
      query: "supabase",
      result_count: 1,
      mode: "hybrid",
    });
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.mode).toBe("hybrid");
    expect(line.query).toBeUndefined();          // still hashed, not raw
    expect(line.query_hash).toMatch(/^sha256:/);
  });

  it("hashes context query when present, omits when absent", () => {
    const a = new Auditor(logPath);
    a.write({
      op: "context",
      agent: "claude-code",
      session: "01H",
      project: "kincare",
      max_tokens: 4000,
      query: "auth decisions",
      result_count: 3,
      total_tokens: 480,
    });
    a.write({
      op: "context",
      agent: "claude-code",
      session: "01H",
      project: "kincare",
      max_tokens: 4000,
      result_count: 5,
      total_tokens: 1200,
    });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const withQuery = JSON.parse(lines[0]!);
    const noQuery = JSON.parse(lines[1]!);
    expect(withQuery.query).toBeUndefined();
    expect(withQuery.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(withQuery.project).toBe("kincare");
    expect(noQuery.query).toBeUndefined();
    expect(noQuery.query_hash).toBeUndefined();
    expect(noQuery.total_tokens).toBe(1200);
  });

  it("serializes keeper-shape entries (decay, archive, link_rebuild, keeper_run) without dropping fields", () => {
    const a = new Auditor(logPath);
    a.write({ op: "decay", agent: "keeper", session: "01H", id: "mem_2026-04-27_aaaaaa",
              from_confidence: 1.0, to_confidence: 0.95, delta: -0.05, periods: 1 });
    a.write({ op: "archive", agent: "keeper", session: "01H", id: "mem_2026-04-27_bbbbbb",
              from: "/v/memory/observations/x.md", to: "/v/archive/x.md", reasons: ["ttl_expired"] });
    a.write({ op: "link_rebuild", agent: "keeper", session: "01H",
              count: 12, embed_model: "Xenova/all-MiniLM-L6-v2:int8" });
    a.write({ op: "keeper_run", agent: "keeper", session: "01H",
              duration_ms: 234, summary: { triage: { promoted: 2 } } });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const decay = JSON.parse(lines[0]!);
    expect(decay.op).toBe("decay");
    expect(decay.delta).toBe(-0.05);
    const archive = JSON.parse(lines[1]!);
    expect(archive.reasons).toEqual(["ttl_expired"]);
    const linkRebuild = JSON.parse(lines[2]!);
    expect(linkRebuild.count).toBe(12);
    const keeperRun = JSON.parse(lines[3]!);
    expect(keeperRun.summary.triage.promoted).toBe(2);
  });
});
