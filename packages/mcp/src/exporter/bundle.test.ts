import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex, type IndexRow } from "../index/sqlite.js";
import { vaultPaths, type MemoryType } from "../vault/paths.js";
import { buildSkillBundle } from "./bundle.js";

interface SeedMemoryInput {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  project: string;
  created?: string;
  updated?: string;
  tags?: string[];
  confidence?: number;
  agent?: string;
  location?: "memory" | "inbox";
}

function seedMemory(vaultRoot: string, m: SeedMemoryInput): IndexRow {
  const paths = vaultPaths(vaultRoot);
  const loc = m.location ?? "memory";
  const fileDir = loc === "memory"
    ? paths.memoryDir(m.type)
    : paths.inboxDir(m.type);
  mkdirSync(fileDir, { recursive: true });
  const filePath = join(fileDir, `${m.id}.md`);
  const created = m.created ?? "2026-05-10T00:00:00.000Z";
  const updated = m.updated ?? created;
  const tags = m.tags ?? [];
  const fm = [
    "---",
    `id: ${m.id}`,
    `type: ${m.type}`,
    `title: ${JSON.stringify(m.title)}`,
    `agent: ${m.agent ?? "human"}`,
    "session: null",
    `created: ${created}`,
    `updated: ${updated}`,
    `confidence: ${m.confidence ?? 0.9}`,
    "sources: []",
    "contradicts: []",
    "supersedes: []",
    `tags: ${JSON.stringify(tags)}`,
    `project: ${m.project}`,
    "ttl_days: null",
    "status: active",
    "human_reviewed: false",
    "human_approved: null",
    'schema_version: "0.1"',
    ...(m.type === "summary" ? ['period: daily', 'covers: []'] : []),
    "---",
    "",
    m.body,
    "",
  ].join("\n");
  writeFileSync(filePath, fm);

  return {
    id: m.id,
    type: m.type,
    title: m.title,
    body: m.body,
    tags,
    project: m.project,
    status: "active",
    location: loc,
    path: filePath,
    updated,
  };
}

function seedIndex(vaultRoot: string, rows: IndexRow[]): void {
  const paths = vaultPaths(vaultRoot);
  const idx = openIndex(paths.indexFile);
  try {
    for (const r of rows) idx.upsert(r);
  } finally {
    idx.close();
  }
}

describe("buildSkillBundle", () => {
  let v: TmpVault;
  beforeEach(() => { v = makeTmpVault(); });
  afterEach(() => v.cleanup());

  it("groups memories by bucket and sorts newest-first within bucket", () => {
    const rows = [
      seedMemory(v.root, { id: "mem_2026-04-15_aaa111", type: "decision",
        title: "Old decision", body: "old", project: "p",
        created: "2026-04-15T10:00:00.000Z" }),
      seedMemory(v.root, { id: "mem_2026-05-10_bbb222", type: "decision",
        title: "New decision", body: "new", project: "p",
        created: "2026-05-10T10:00:00.000Z" }),
      seedMemory(v.root, { id: "mem_2026-05-01_ccc333", type: "learning",
        title: "A learning", body: "y", project: "p",
        created: "2026-05-01T10:00:00.000Z" }),
    ];
    seedIndex(v.root, rows);

    const bundle = buildSkillBundle({ vault: v.root, project: "p" });
    expect(bundle.decisions.map((d) => d.id)).toEqual([
      "mem_2026-05-10_bbb222",
      "mem_2026-04-15_aaa111",
    ]);
    expect(bundle.learnings.map((l) => l.id)).toEqual(["mem_2026-05-01_ccc333"]);
    expect(bundle.stats.total).toBe(3);
    expect(bundle.stats.perBucket.decision).toBe(2);
    expect(bundle.stats.perBucket.learning).toBe(1);
  });

  it("filters by project — does not leak rows from another project", () => {
    seedIndex(v.root, [
      seedMemory(v.root, { id: "mem_2026-05-01_aaa111", type: "decision",
        title: "A's secret", body: "A only", project: "alpha" }),
      seedMemory(v.root, { id: "mem_2026-05-01_bbb222", type: "decision",
        title: "B's secret", body: "B only", project: "beta" }),
    ]);
    const bundle = buildSkillBundle({ vault: v.root, project: "alpha" });
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.decisions[0]!.title).toBe("A's secret");
    expect(JSON.stringify(bundle)).not.toContain("B's secret");
    expect(JSON.stringify(bundle)).not.toContain("B only");
  });

  it("excludes inbox memories by default; includes them with includeInbox=true", () => {
    seedIndex(v.root, [
      seedMemory(v.root, { id: "mem_2026-05-01_aaa111", type: "decision",
        title: "Canonical", body: "canon", project: "p" }),
      seedMemory(v.root, { id: "mem_2026-05-02_bbb222", type: "decision",
        title: "Inbox-only", body: "inbox", project: "p", location: "inbox" }),
    ]);

    const canonOnly = buildSkillBundle({ vault: v.root, project: "p" });
    expect(canonOnly.decisions.map((d) => d.title)).toEqual(["Canonical"]);
    expect(canonOnly.stats.inboxIncluded).toBe(false);

    const withInbox = buildSkillBundle({
      vault: v.root,
      project: "p",
      includeInbox: true,
    });
    expect(withInbox.decisions.map((d) => d.title).sort())
      .toEqual(["Canonical", "Inbox-only"]);
    expect(withInbox.stats.inboxIncluded).toBe(true);
  });

  it("breaks created-ties by id ascending (stable sort)", () => {
    const sameTs = "2026-05-13T12:00:00.000Z";
    seedIndex(v.root, [
      seedMemory(v.root, { id: "mem_2026-05-13_zzzzzz", type: "decision",
        title: "Z", body: "z", project: "p", created: sameTs }),
      seedMemory(v.root, { id: "mem_2026-05-13_aaaaaa", type: "decision",
        title: "A", body: "a", project: "p", created: sameTs }),
    ]);
    const bundle = buildSkillBundle({ vault: v.root, project: "p" });
    // Same created → id ascending → mem_..._aaaaaa first
    expect(bundle.decisions.map((d) => d.id)).toEqual([
      "mem_2026-05-13_aaaaaa",
      "mem_2026-05-13_zzzzzz",
    ]);
  });

  it("preserves frontmatter fields (tags, confidence, agent) on hydrated memories", () => {
    seedIndex(v.root, [
      seedMemory(v.root, {
        id: "mem_2026-05-01_aaa111", type: "decision",
        title: "Tagged", body: "x", project: "p",
        tags: ["auth", "infra"],
        confidence: 0.42,
        agent: "claude-code",
      }),
    ]);
    const bundle = buildSkillBundle({ vault: v.root, project: "p" });
    expect(bundle.decisions[0]).toMatchObject({
      tags: ["auth", "infra"],
      confidence: 0.42,
      agent: "claude-code",
    });
  });

  it("caps bytes per bucket and drops items beyond the cap", () => {
    const big = "x".repeat(50_000);
    seedIndex(v.root, [
      seedMemory(v.root, { id: "mem_2026-05-01_aaa111", type: "decision",
        title: "T1", body: big, project: "p", created: "2026-05-01" }),
      seedMemory(v.root, { id: "mem_2026-05-02_bbb222", type: "decision",
        title: "T2", body: big, project: "p", created: "2026-05-02" }),
      seedMemory(v.root, { id: "mem_2026-05-03_ccc333", type: "decision",
        title: "T3", body: big, project: "p", created: "2026-05-03" }),
    ]);
    // Cap to ~75kB → only 1 item fits
    const bundle = buildSkillBundle({
      vault: v.root,
      project: "p",
      maxBytesPerBucket: 75_000,
    });
    expect(bundle.decisions).toHaveLength(1);
    // Newest is kept (created DESC)
    expect(bundle.decisions[0]!.id).toBe("mem_2026-05-03_ccc333");
  });
});
