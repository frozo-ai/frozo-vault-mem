import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { openIndex, type IndexHandle, type IndexRow } from "../index/sqlite.js";
import type { MemoryType } from "../vault/paths.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import type { BundledMemory, SkillBundle } from "./types.js";

interface BuildOptions {
  vault: string;
  project: string;
  includeInbox?: boolean;
  maxBytesPerBucket?: number;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
  /** Inject an index handle for testability; otherwise opened from disk. */
  index?: IndexHandle;
}

const DEFAULT_BYTES_PER_BUCKET = 200_000;

/**
 * Read every memory for `project` from the FTS index, hydrate body+tags
 * from the markdown source, sort each bucket deterministically, and
 * return a target-agnostic SkillBundle.
 *
 * Sort key: created DESC, id ASC. This is the byte-stable ordering the
 * tests rely on for determinism guarantees.
 */
export function buildSkillBundle(opts: BuildOptions): SkillBundle {
  const paths = vaultPaths(opts.vault);
  const ownIndex = !opts.index;
  const index = opts.index ?? openIndex(paths.indexFile);
  const maxBytes = opts.maxBytesPerBucket ?? DEFAULT_BYTES_PER_BUCKET;
  const now = opts.now ?? (() => new Date());

  try {
    const rows: IndexRow[] = index.list({
      project: opts.project,
      status: "active",
      location: opts.includeInbox ? "any" : "memory",
    });

    const grouped: Record<MemoryType, BundledMemory[]> = {
      decision: [],
      observation: [],
      todo: [],
      learning: [],
      summary: [],
      entity: [],
      question: [],
    };

    for (const row of rows) {
      const hydrated = hydrate(row);
      if (!hydrated) continue;
      grouped[row.type].push(hydrated);
    }

    // Sort each bucket: created DESC, id ASC (stable tiebreaker).
    for (const t of MEMORY_TYPES) {
      grouped[t].sort((a, b) => {
        const byCreated = b.created.localeCompare(a.created);
        return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
      });
    }

    // Cap bytes-per-bucket to keep wildly-large vaults from producing
    // gigabyte skill bundles. Items beyond the cap are dropped from the
    // bundle entirely (not truncated mid-content) so what remains is
    // self-consistent.
    for (const t of MEMORY_TYPES) {
      const arr = grouped[t];
      let usedBytes = 0;
      const kept: BundledMemory[] = [];
      for (const m of arr) {
        const size = byteSize(m.body) + byteSize(m.title);
        if (usedBytes + size > maxBytes) break;
        kept.push(m);
        usedBytes += size;
      }
      grouped[t] = kept;
    }

    const stats = {
      total: MEMORY_TYPES.reduce((n, t) => n + grouped[t].length, 0),
      perBucket: {
        decision: grouped.decision.length,
        observation: grouped.observation.length,
        todo: grouped.todo.length,
        learning: grouped.learning.length,
        summary: grouped.summary.length,
        entity: grouped.entity.length,
        question: grouped.question.length,
      },
      inboxIncluded: Boolean(opts.includeInbox),
    };

    return {
      project: opts.project,
      generatedAt: now().toISOString(),
      decisions: grouped.decision,
      observations: grouped.observation,
      learnings: grouped.learning,
      todos: grouped.todo,
      entities: grouped.entity,
      questions: grouped.question,
      summaries: grouped.summary,
      stats,
    };
  } finally {
    if (ownIndex) index.close();
  }
}

function hydrate(row: IndexRow): BundledMemory | null {
  let raw: string;
  try {
    raw = readFileSync(row.path, "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const created = pickString(fm["created"]) ?? row.updated;
  const updated = pickString(fm["updated"]) ?? row.updated;
  const confidence = typeof fm["confidence"] === "number" ? fm["confidence"] : 1.0;
  const tags = Array.isArray(fm["tags"]) ? (fm["tags"] as unknown[]).filter((t): t is string => typeof t === "string") : row.tags;
  const agent = pickString(fm["agent"]);
  const result: BundledMemory = {
    id: row.id,
    type: row.type,
    title: row.title,
    body,
    tags,
    confidence,
    created,
    updated,
  };
  if (agent !== undefined) result.agent = agent;
  return result;
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function byteSize(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
