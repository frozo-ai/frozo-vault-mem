import { writeClaudeBundle } from "./claude.js";
import { writeCursorBundle } from "./cursor.js";
import { writeWindsurfBundle } from "./windsurf.js";
import { writeGenericBundle } from "./generic.js";
import { buildSkillBundle } from "./bundle.js";
import type { ExportOptions, ExportResult, ExportTarget, SkillBundle } from "./types.js";

export { buildSkillBundle } from "./bundle.js";
export * from "./types.js";

const EXPORT_TARGETS: ReadonlyArray<ExportTarget> = ["claude", "cursor", "windsurf", "generic"];

export function isExportTarget(s: string): s is ExportTarget {
  return (EXPORT_TARGETS as ReadonlyArray<string>).includes(s);
}

export function exportSkill(opts: ExportOptions): ExportResult {
  if (!isExportTarget(opts.target)) {
    throw new Error(
      `invalid target ${JSON.stringify(opts.target)} — must be one of: ${EXPORT_TARGETS.join(", ")}`
    );
  }
  const bundle: SkillBundle = buildSkillBundle({
    vault: opts.vault,
    project: opts.project,
    ...(opts.includeInbox !== undefined && { includeInbox: opts.includeInbox }),
    ...(opts.maxBytesPerBucket !== undefined && { maxBytesPerBucket: opts.maxBytesPerBucket }),
  });
  const filesWritten = writeForTarget(opts.target, bundle, opts.output);
  return { target: opts.target, output: opts.output, filesWritten, bundle };
}

function writeForTarget(
  target: ExportTarget,
  bundle: SkillBundle,
  outputDir: string
): string[] {
  switch (target) {
    case "claude":
      return writeClaudeBundle(bundle, outputDir);
    case "cursor":
      return writeCursorBundle(bundle, outputDir);
    case "windsurf":
      return writeWindsurfBundle(bundle, outputDir);
    case "generic":
      return writeGenericBundle(bundle, outputDir);
  }
}
