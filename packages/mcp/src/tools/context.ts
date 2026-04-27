import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import { type LanceHandle } from "../index/lance.js";
import { type Embedder } from "../embedder/index.js";
import { type MemoryType, vaultPaths } from "../vault/paths.js";
import { ToolError } from "../errors.js";

export interface ContextToolInput {
  project: string;
  max_tokens?: number;
  query?: string;
  include_inbox?: boolean;
}

export type ContextBucket =
  | "summary" | "decision" | "observation" | "learning" | "todo" | "entity" | "question";

export interface ContextItem {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tokens: number;
  bucket: ContextBucket;
}

export interface ContextToolOutput {
  items: ContextItem[];
  total_tokens: number;
  truncated: number;
}

export interface ContextToolDeps {
  vault: string;
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;
  embedder: Embedder;
  agent?: string;
  session?: string | null;
}

// Bucket order: summary leads, then decisions, learnings, observations, entities, questions, todos.
const BUCKET_ORDER: ContextBucket[] = [
  "summary", "decision", "learning", "observation", "entity", "question", "todo",
];

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3.5);
}

export function createContextTool(deps: ContextToolDeps) {
  const paths = vaultPaths(deps.vault);

  function readContent(absPath: string): string {
    const raw = readFileSync(absPath, "utf8");
    const { content } = matter(raw);
    return content.trim();
  }

  return {
    async handle(input: ContextToolInput): Promise<ContextToolOutput> {
      if (!input.project || input.project.length === 0) {
        throw new ToolError("schema_validation_failed", "project is required");
      }
      const maxTokens = Math.min(Math.max(input.max_tokens ?? 4000, 100), 16_000);
      const includeInbox = input.include_inbox ?? false;
      const locationFilter: "memory" | "any" = includeInbox ? "any" : "memory";

      // Pull all rows for the project across all buckets via list() —
      // no FTS MATCH; plain metadata filtering on indexed columns.
      const allRows = deps.index.list({
        project: input.project,
        status: "active",
        location: locationFilter,
      });

      type Candidate = { id: string; type: MemoryType; title: string; updated: string; path: string; bucket: ContextBucket };
      const candidates: Candidate[] = allRows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        updated: r.updated,
        path: r.path,
        bucket: r.type as ContextBucket,
      }));

      // Group by bucket, sorted by updated descending within each bucket.
      const byBucket = new Map<ContextBucket, Candidate[]>();
      for (const b of BUCKET_ORDER) byBucket.set(b, []);
      for (const c of candidates) {
        const arr = byBucket.get(c.bucket);
        if (arr) arr.push(c);
      }
      for (const arr of byBucket.values()) arr.sort((a, b) => b.updated.localeCompare(a.updated));

      // NOTE: todo_status (todo/doing/done) lives in markdown frontmatter, not the index.
      // v0.1 includes all active todos regardless of todo_status — omit frontmatter filter for now.

      let ordered: Candidate[];

      if (input.query) {
        // Semantic-led ranking: always include at most 1 latest summary as a non-negotiable floor,
        // then rank the rest by vector similarity.
        const summaries = byBucket.get("summary")!.slice(0, 1);
        const summaryIds = new Set(summaries.map((s) => s.id));

        const qvec = await deps.embedder.embed(input.query);
        const semRes = await deps.lance.search(
          qvec,
          { project: input.project, status: "active", location: locationFilter },
          50,
        );
        const semIds = new Set(semRes.results.map((r) => r.id));

        // Preserve semantic rank order among candidates that appeared in Lance results.
        const semCandidates = candidates
          .filter((c) => semIds.has(c.id) && !summaryIds.has(c.id))
          .sort((a, b) => {
            const ra = semRes.results.findIndex((r) => r.id === a.id);
            const rb = semRes.results.findIndex((r) => r.id === b.id);
            return ra - rb;
          });

        ordered = [...summaries, ...semCandidates];
      } else {
        // Recency-led, summary-first: iterate bucket order, concat each bucket's rows.
        ordered = [];
        for (const b of BUCKET_ORDER) ordered = ordered.concat(byBucket.get(b)!);
      }

      // Greedy pack: read content, estimate tokens, skip items that would exceed max_tokens.
      const items: ContextItem[] = [];
      let totalTokens = 0;
      let truncated = 0;
      for (const c of ordered) {
        const content = readContent(c.path);
        const tokens = estimateTokens(content);
        if (totalTokens + tokens > maxTokens) {
          truncated++;
          continue;
        }
        items.push({
          id: c.id,
          type: c.type,
          title: c.title,
          content,
          tokens,
          bucket: c.bucket,
        });
        totalTokens += tokens;
      }

      // Audit: include query only when provided (auditor hashes it).
      const auditEntry: {
        op: "context";
        agent: string;
        session: string | null;
        project: string;
        max_tokens: number;
        query?: string;
        result_count: number;
        total_tokens: number;
      } = {
        op: "context",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        project: input.project,
        max_tokens: maxTokens,
        result_count: items.length,
        total_tokens: totalTokens,
      };
      if (input.query !== undefined) auditEntry.query = input.query;
      deps.auditor.write(auditEntry);

      return { items, total_tokens: totalTokens, truncated };
    },
  };
}
