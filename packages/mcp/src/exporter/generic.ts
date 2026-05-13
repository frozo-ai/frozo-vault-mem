import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../vault/atomicWrite.js";
import { renderBucketSection, renderStatsLine } from "./render.js";
import type { SkillBundle } from "./types.js";

/**
 * Generic bundle: one markdown file per non-empty bucket plus a
 * machine-readable manifest. Useful for non-Claude/Cursor/Windsurf
 * runtimes (OpenAI assistants, custom agents, plain RAG ingestion).
 *
 *   <output>/
 *   ├── README.md      (human-readable summary)
 *   ├── manifest.json  (project, generated_at, memory counts, file list)
 *   ├── decisions.md
 *   ├── observations.md
 *   ├── learnings.md
 *   ├── entities.md
 *   ├── questions.md
 *   ├── todos.md
 *   └── summaries.md
 */
export function writeGenericBundle(
  bundle: SkillBundle,
  outputDir: string
): string[] {
  mkdirSync(outputDir, { recursive: true });
  const filesWritten: string[] = [];

  const sections: Array<[string, ReturnType<typeof renderBucketSection>, string]> = [
    ["decisions.md", renderBucketSection("decisions", bundle.decisions), "decisions"],
    ["observations.md", renderBucketSection("observations", bundle.observations), "observations"],
    ["learnings.md", renderBucketSection("learnings", bundle.learnings), "learnings"],
    ["entities.md", renderBucketSection("entities", bundle.entities), "entities"],
    ["questions.md", renderBucketSection("questions", bundle.questions), "questions"],
    ["todos.md", renderBucketSection("todos", bundle.todos), "todos"],
    ["summaries.md", renderBucketSection("summaries", bundle.summaries), "summaries"],
  ];

  const included: string[] = [];
  for (const [fname, content, label] of sections) {
    if (!content) continue;
    const p = join(outputDir, fname);
    atomicWrite(p, content);
    filesWritten.push(p);
    included.push(label);
  }

  const readmePath = join(outputDir, "README.md");
  atomicWrite(readmePath, renderReadme(bundle, included));
  filesWritten.push(readmePath);

  const manifestPath = join(outputDir, "manifest.json");
  atomicWrite(manifestPath, renderManifest(bundle, included));
  filesWritten.push(manifestPath);

  return filesWritten;
}

function renderReadme(bundle: SkillBundle, included: string[]): string {
  const list = included.length === 0
    ? "_(no memories yet for this project)_"
    : included.map((name) => `- \`${name}.md\``).join("\n");
  return `# Vault-mem memory for \`${bundle.project}\`

Generic skill bundle exported from vault-mem. Provider-agnostic — drop
into any RAG / agent runtime that reads markdown files.

${renderStatsLine(bundle)}.

## Files in this bundle

${list}

See \`manifest.json\` for machine-readable metadata.

---

Exported at ${bundle.generatedAt}.
`;
}

function renderManifest(bundle: SkillBundle, included: string[]): string {
  const manifest = {
    schema: "vault-mem-skill-bundle/1",
    project: bundle.project,
    generated_at: bundle.generatedAt,
    generated_by: "vault-mem-mcp",
    target: "generic",
    files: included.map((name) => `${name}.md`),
    counts: bundle.stats.perBucket,
    total: bundle.stats.total,
    inbox_included: bundle.stats.inboxIncluded,
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}
