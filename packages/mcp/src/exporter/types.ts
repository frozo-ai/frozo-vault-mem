import type { MemoryType } from "../vault/paths.js";

/**
 * Provider-agnostic skill bundle assembled from a vault's memories.
 * Target writers (claude/cursor/windsurf/generic) consume this shape
 * and serialize to their own on-disk layout.
 */
export interface SkillBundle {
  /** Project slug being exported (e.g. "kincare"). */
  project: string;
  /** ISO timestamp; informational, NOT included in content hashes. */
  generatedAt: string;
  /** Bucketed, deterministically-sorted memories. */
  decisions: BundledMemory[];
  observations: BundledMemory[];
  learnings: BundledMemory[];
  todos: BundledMemory[];
  entities: BundledMemory[];
  questions: BundledMemory[];
  summaries: BundledMemory[];
  stats: {
    total: number;
    perBucket: Record<MemoryType, number>;
    inboxIncluded: boolean;
  };
}

export interface BundledMemory {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  tags: string[];
  confidence: number;
  created: string;
  updated: string;
  agent?: string;
}

export type ExportTarget = "claude" | "cursor" | "windsurf" | "generic";

export interface ExportOptions {
  vault: string;
  project: string;
  target: ExportTarget;
  output: string;
  /** Whether to include inbox memories (default false). */
  includeInbox?: boolean;
  /** Hard cap on bundled body bytes per bucket (default 200_000). */
  maxBytesPerBucket?: number;
}

export interface ExportResult {
  target: ExportTarget;
  output: string;
  filesWritten: string[];
  bundle: SkillBundle;
}
