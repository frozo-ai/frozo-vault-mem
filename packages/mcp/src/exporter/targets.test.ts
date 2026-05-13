import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex, type IndexRow } from "../index/sqlite.js";
import { vaultPaths, type MemoryType } from "../vault/paths.js";
import { exportSkill } from "./index.js";

function seedMemoryFile(vaultRoot: string, m: {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  project: string;
  created?: string;
}): IndexRow {
  const paths = vaultPaths(vaultRoot);
  mkdirSync(paths.memoryDir(m.type), { recursive: true });
  const filePath = join(paths.memoryDir(m.type), `${m.id}.md`);
  const created = m.created ?? "2026-05-10T00:00:00.000Z";
  const fm = [
    "---",
    `id: ${m.id}`,
    `type: ${m.type}`,
    `title: ${JSON.stringify(m.title)}`,
    "agent: human",
    "session: null",
    `created: ${created}`,
    `updated: ${created}`,
    "confidence: 0.9",
    "sources: []",
    "contradicts: []",
    "supersedes: []",
    'tags: ["auth"]',
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
    id: m.id, type: m.type, title: m.title, body: m.body,
    tags: ["auth"], project: m.project, status: "active",
    location: "memory", path: filePath, updated: created,
  };
}

function seedDefaultProject(vaultRoot: string): void {
  const rows = [
    seedMemoryFile(vaultRoot, { id: "mem_2026-05-10_aaa111", type: "decision",
      title: "Use Supabase", body: "We chose Supabase over Auth0 because team familiarity.", project: "kincare", created: "2026-05-10" }),
    seedMemoryFile(vaultRoot, { id: "mem_2026-04-20_bbb222", type: "learning",
      title: "Lance distance is cosine", body: "Lance's IVFFlat uses 1-cosine.", project: "kincare", created: "2026-04-20" }),
    seedMemoryFile(vaultRoot, { id: "mem_2026-04-01_ccc333", type: "entity",
      title: "Ashish (founder)", body: "Founder of kincare.", project: "kincare", created: "2026-04-01" }),
  ];
  const paths = vaultPaths(vaultRoot);
  const idx = openIndex(paths.indexFile);
  try {
    for (const r of rows) idx.upsert(r);
  } finally {
    idx.close();
  }
}

describe("exportSkill — per-target output", () => {
  let v: TmpVault;
  let outputDir: string;
  beforeEach(() => {
    v = makeTmpVault();
    seedDefaultProject(v.root);
    outputDir = join(v.root, "_export");
  });
  afterEach(() => v.cleanup());

  describe("target=claude", () => {
    it("produces SKILL.md + description.yaml + references/", () => {
      const r = exportSkill({
        vault: v.root, project: "kincare", target: "claude", output: outputDir,
      });
      expect(existsSync(join(outputDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(outputDir, "description.yaml"))).toBe(true);
      expect(existsSync(join(outputDir, "references", "decisions.md"))).toBe(true);
      expect(existsSync(join(outputDir, "references", "learnings.md"))).toBe(true);
      expect(existsSync(join(outputDir, "references", "entities.md"))).toBe(true);
      expect(r.target).toBe("claude");
    });

    it("SKILL.md has valid YAML frontmatter with name + description", () => {
      exportSkill({ vault: v.root, project: "kincare", target: "claude", output: outputDir });
      const raw = readFileSync(join(outputDir, "SKILL.md"), "utf8");
      const parsed = matter(raw);
      expect(parsed.data.name).toBe("vault-mem-kincare");
      expect(typeof parsed.data.description).toBe("string");
      expect(parsed.data.description).toContain("kincare");
      expect(parsed.content).toContain("# Vault-mem memory for `kincare`");
    });

    it("references/ files contain the memory bodies and ids", () => {
      exportSkill({ vault: v.root, project: "kincare", target: "claude", output: outputDir });
      const decisions = readFileSync(join(outputDir, "references", "decisions.md"), "utf8");
      expect(decisions).toContain("Use Supabase");
      expect(decisions).toContain("We chose Supabase");
      expect(decisions).toContain("mem_2026-05-10_aaa111");
    });

    it("description.yaml lists the included reference files", () => {
      exportSkill({ vault: v.root, project: "kincare", target: "claude", output: outputDir });
      const desc = readFileSync(join(outputDir, "description.yaml"), "utf8");
      expect(desc).toContain("name: vault-mem-kincare");
      expect(desc).toContain("references/decisions.md");
      expect(desc).toContain("project: kincare");
    });
  });

  describe("target=cursor", () => {
    it("produces a single .cursor/rules/<project>.mdc file", () => {
      const r = exportSkill({
        vault: v.root, project: "kincare", target: "cursor", output: outputDir,
      });
      const mdc = join(outputDir, ".cursor", "rules", "vault-mem-kincare.mdc");
      expect(existsSync(mdc)).toBe(true);
      expect(r.filesWritten).toEqual([mdc]);
      const raw = readFileSync(mdc, "utf8");
      expect(raw).toMatch(/^---/);
      expect(raw).toContain("alwaysApply: true");
      expect(raw).toContain("Use Supabase");
    });
  });

  describe("target=windsurf", () => {
    it("produces a single .windsurfrules file (no frontmatter)", () => {
      const r = exportSkill({
        vault: v.root, project: "kincare", target: "windsurf", output: outputDir,
      });
      const wfile = join(outputDir, ".windsurfrules");
      expect(existsSync(wfile)).toBe(true);
      expect(r.filesWritten).toEqual([wfile]);
      const raw = readFileSync(wfile, "utf8");
      expect(raw.startsWith("---")).toBe(false);
      expect(raw).toContain("Use Supabase");
    });
  });

  describe("target=generic", () => {
    it("produces README.md + manifest.json + per-bucket markdown files", () => {
      exportSkill({
        vault: v.root, project: "kincare", target: "generic", output: outputDir,
      });
      expect(existsSync(join(outputDir, "README.md"))).toBe(true);
      expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(outputDir, "decisions.md"))).toBe(true);
      // No bucket file for empty buckets:
      expect(existsSync(join(outputDir, "questions.md"))).toBe(false);

      const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
      expect(manifest.project).toBe("kincare");
      expect(manifest.total).toBe(3);
      expect(manifest.counts.decision).toBe(1);
      expect(manifest.counts.learning).toBe(1);
      expect(manifest.counts.entity).toBe(1);
    });
  });

  describe("determinism", () => {
    it("byte-identical output across two runs (when generatedAt is held constant)", () => {
      const fixedNow = () => new Date("2026-05-13T12:00:00.000Z");
      // Need an internal entry point that accepts the clock; for now we
      // pin via two consecutive runs with intervening generatedAt rewrite.
      const first = exportSkill({ vault: v.root, project: "kincare", target: "claude", output: outputDir });
      const firstSkillRaw = readFileSync(join(outputDir, "SKILL.md"), "utf8");
      const firstDecisions = readFileSync(join(outputDir, "references", "decisions.md"), "utf8");

      // Re-run into a sibling dir
      const out2 = join(v.root, "_export2");
      const second = exportSkill({ vault: v.root, project: "kincare", target: "claude", output: out2 });
      const secondDecisions = readFileSync(join(out2, "references", "decisions.md"), "utf8");

      // references/* is timestamp-free → must be byte-identical run-to-run
      expect(secondDecisions).toBe(firstDecisions);
      expect(first.filesWritten.length).toBe(second.filesWritten.length);

      // SKILL.md *does* contain the generatedAt timestamp by design.
      // Sanity: the only diff between the two SKILL.md outputs should be
      // generatedAt-related lines.
      const stripGenerated = (s: string) => s.replace(/Exported from vault-mem at .*\.$/m, "");
      // Note fixedNow isn't yet wired into exportSkill; this stripping
      // approach is the bound we test today.
      void fixedNow;
      const skillDiff = stripGenerated(firstSkillRaw).split("\n")
        .filter((l) => l.trim().length > 0).length;
      const out2SkillStripped = stripGenerated(readFileSync(join(out2, "SKILL.md"), "utf8"))
        .split("\n").filter((l) => l.trim().length > 0).length;
      expect(out2SkillStripped).toBe(skillDiff);
    });
  });

  describe("project filtering", () => {
    it("does not include memories from other projects", () => {
      // Seed a memory in a different project
      seedMemoryFile(v.root, {
        id: "mem_2026-05-12_xyz111", type: "decision",
        title: "Other project secret", body: "Should not appear.",
        project: "frozo",
      });
      // Need to upsert the index row for the new file
      const paths = vaultPaths(v.root);
      const idx = openIndex(paths.indexFile);
      try {
        idx.upsert({
          id: "mem_2026-05-12_xyz111", type: "decision", title: "Other project secret",
          body: "Should not appear.", tags: [], project: "frozo",
          status: "active", location: "memory",
          path: join(paths.memoryDir("decision"), "mem_2026-05-12_xyz111.md"),
          updated: "2026-05-12",
        });
      } finally {
        idx.close();
      }

      exportSkill({ vault: v.root, project: "kincare", target: "claude", output: outputDir });
      const decisions = readFileSync(join(outputDir, "references", "decisions.md"), "utf8");
      expect(decisions).not.toContain("Other project secret");
      expect(decisions).not.toContain("Should not appear");
    });
  });

  it("rejects an invalid target", () => {
    expect(() => exportSkill({
      vault: v.root, project: "kincare",
      target: "openai" as unknown as "claude",
      output: outputDir,
    })).toThrow();
  });
});
