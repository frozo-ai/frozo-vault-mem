import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../vault/atomicWrite.js";
import { renderFullProjectBody, renderStatsLine } from "./render.js";
import type { SkillBundle } from "./types.js";

/**
 * Windsurf reads `.windsurfrules` at repo root — a single plain-text or
 * markdown file. We emit:
 *
 *   <output>/.windsurfrules
 *
 * containing the full project memory. Same body as cursor but without
 * frontmatter (Windsurf doesn't have a structured rule format yet).
 */
export function writeWindsurfBundle(
  bundle: SkillBundle,
  outputDir: string
): string[] {
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, ".windsurfrules");
  atomicWrite(path, renderWindsurfRules(bundle));
  return [path];
}

function renderWindsurfRules(bundle: SkillBundle): string {
  const body = renderFullProjectBody(bundle);
  return `# Vault-mem memory for project: ${bundle.project}

This file loads the team's typed memory for \`${bundle.project}\`:
${renderStatsLine(bundle)}. Treat the contents below as authoritative
project context.

${body}

---

Exported from vault-mem at ${bundle.generatedAt}. Re-run
\`vault-mem-mcp export-skill ${bundle.project} --target=windsurf\` to
refresh.
`;
}
