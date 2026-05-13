import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../vault/atomicWrite.js";
import { renderFullProjectBody, renderStatsLine } from "./render.js";
import type { SkillBundle } from "./types.js";

/**
 * Cursor uses .cursor/rules/*.mdc — markdown-with-frontmatter rule
 * files. We emit one file per project at:
 *
 *   <output>/.cursor/rules/vault-mem-<project>.mdc
 *
 * with `alwaysApply: true` so Cursor pins the rule whenever the user is
 * working inside this repo. The body is the full concatenated project
 * memory.
 */
export function writeCursorBundle(
  bundle: SkillBundle,
  outputDir: string
): string[] {
  const rulesDir = join(outputDir, ".cursor", "rules");
  mkdirSync(rulesDir, { recursive: true });

  const filename = `vault-mem-${bundle.project}.mdc`;
  const path = join(rulesDir, filename);
  atomicWrite(path, renderCursorRule(bundle));
  return [path];
}

function renderCursorRule(bundle: SkillBundle): string {
  const body = renderFullProjectBody(bundle);
  return `---
description: Vault-mem memory for project "${bundle.project}" (${renderStatsLine(bundle)})
globs:
alwaysApply: true
---

# Vault-mem memory for \`${bundle.project}\`

This rule loads the team's typed memory for \`${bundle.project}\`:
${renderStatsLine(bundle)}. Use these as authoritative project context
when answering questions or making changes related to
\`${bundle.project}\`.

${body}

---

_Exported from vault-mem at ${bundle.generatedAt}. Re-run
\`vault-mem-mcp export-skill ${bundle.project} --target=cursor\` to
refresh._
`;
}
