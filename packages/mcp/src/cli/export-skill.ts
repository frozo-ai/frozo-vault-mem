import { resolve } from "node:path";
import { exportSkill, isExportTarget, type ExportTarget } from "../exporter/index.js";

export interface ExportSkillCliInput {
  project: string;
  vault: string;
  target: string;
  output?: string;
  includeInbox?: boolean;
  maxBytesPerBucket?: number;
}

export interface ExportSkillCliResult {
  target: ExportTarget;
  output: string;
  filesWritten: string[];
  stats: {
    total: number;
    perBucket: Record<string, number>;
  };
}

export function runExportSkill(input: ExportSkillCliInput): ExportSkillCliResult {
  const target = input.target.toLowerCase();
  if (!isExportTarget(target)) {
    throw new Error(
      `--target must be one of claude|cursor|windsurf|generic (got ${JSON.stringify(input.target)})`
    );
  }
  if (!input.project || input.project.trim().length === 0) {
    throw new Error("project is required");
  }

  const output = resolve(input.output ?? `./${input.project}-skill`);
  const result = exportSkill({
    vault: input.vault,
    project: input.project,
    target,
    output,
    ...(input.includeInbox !== undefined && { includeInbox: input.includeInbox }),
    ...(input.maxBytesPerBucket !== undefined && { maxBytesPerBucket: input.maxBytesPerBucket }),
  });

  return {
    target: result.target,
    output: result.output,
    filesWritten: result.filesWritten,
    stats: {
      total: result.bundle.stats.total,
      perBucket: result.bundle.stats.perBucket,
    },
  };
}
