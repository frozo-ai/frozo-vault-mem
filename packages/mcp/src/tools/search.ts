import { Auditor } from "../audit/index.js";
import { type IndexHandle, type SearchInput } from "../index/sqlite.js";
import { type LanceHandle, type LanceFilter } from "../index/lance.js";
import { type Embedder } from "../embedder/index.js";
import { rrfMerge, type RankedHit } from "../index/hybrid.js";

export interface SearchToolDeps {
  auditor: Auditor;
  index: IndexHandle;
  lance: LanceHandle;
  embedder: Embedder;
  agent?: string;
  session?: string | null;
}

export type SearchMode = "fts" | "semantic" | "hybrid";

export interface SearchToolInput extends SearchInput {
  mode?: SearchMode;
}

/**
 * Convert a user-friendly query string into an FTS5 MATCH expression.
 *
 * The search tool accepts plain natural-language queries from agents and
 * humans. SQLite FTS5 has its own query language where hyphens are the NOT
 * operator, quotes mean phrase-adjacency, and unbalanced punctuation throws
 * "fts5: syntax error". Passing user input straight through breaks for any
 * query containing hyphens, slashes, quotes, or other ASCII punctuation —
 * which includes most real-world memory titles like "Use Supabase auth" vs
 * "vault-mem MCP".
 *
 * This function:
 *   - Lowercases (FTS5 is case-insensitive but explicit is clearer in audit)
 *   - Splits on any non-letter, non-digit character (Unicode-aware via \p{L}\p{N})
 *   - Drops empty tokens
 *   - Appends `*` to each token so prefix-matches hit ("auth" finds "authentication")
 *   - Joins with space (FTS5 implicit AND)
 *
 * Examples:
 *   "freshly-shipped vault-mem MCP" → "freshly* shipped* vault* mem* mcp*"
 *   "kincare auth"                  → "kincare* auth*"
 *   "DPDP" / 'CamelCase'            → "dpdp*" / "camelcase*"
 *   ""  /  "   --   "               → "" (caller short-circuits to empty results)
 *
 * Trade-off: power users who want to construct raw FTS5 expressions
 * (NEAR/N, OR, etc.) cannot. Acceptable for Phase 1 — agents and humans
 * type plain queries; raw FTS5 syntax is a rare power-user need that can
 * be added later via an opt-in flag.
 */
export function buildFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return tokens.map((t) => `${t}*`).join(" ");
}

export function createSearchTool(deps: SearchToolDeps) {
  function buildLanceFilter(input: SearchToolInput): LanceFilter {
    return {
      type: input.type,
      project: input.project,
      status: input.status,
      location: input.location,
    };
  }

  async function ftsRun(input: SearchToolInput, limit: number) {
    const fts = buildFtsQuery(input.query);
    if (!fts) return { results: [], total: 0 };
    return deps.index.search({ ...input, query: fts, limit });
  }

  async function semanticRun(input: SearchToolInput, limit: number) {
    const qvec = await deps.embedder.embed(input.query);
    return deps.lance.search(qvec, buildLanceFilter(input), limit);
  }

  return {
    async handle(input: SearchToolInput) {
      const mode: SearchMode = input.mode ?? "hybrid";
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

      let results: Array<{ id: string; type: string; title: string; snippet: string; score: number; location: string; path: string; project: string | null; tags: string[]; updated: string }> = [];
      let total = 0;

      if (mode === "fts") {
        const r = await ftsRun(input, limit);
        results = r.results.map((x) => ({ ...x, score: x.score }));
        total = r.total;
      } else if (mode === "semantic") {
        const r = await semanticRun(input, limit);
        results = r.results.map((x) => ({
          id: x.id, type: x.type, title: x.title, snippet: "",
          score: x.score, location: x.location, path: x.path,
          project: x.project, tags: x.tags, updated: x.updated,
        }));
        total = r.total;
      } else {
        // hybrid
        const [ftsRes, semRes] = await Promise.all([
          ftsRun(input, 50),
          semanticRun(input, 50),
        ]);
        const ftsHits: RankedHit[] = ftsRes.results.map((r, i) => ({ id: r.id, rank: i }));
        const semHits: RankedHit[] = semRes.results.map((r, i) => ({ id: r.id, rank: i }));
        const merged = rrfMerge(ftsHits, semHits, 60, limit);
        // Map back to full result rows: prefer FTS row (has snippet), fall back to semantic
        const ftsById = new Map(ftsRes.results.map((r) => [r.id, r]));
        const semById = new Map(semRes.results.map((r) => [r.id, r]));
        results = merged.map((m) => {
          const fts = ftsById.get(m.id);
          if (fts) return { ...fts, score: m.score };
          const sem = semById.get(m.id)!;
          return {
            id: sem.id, type: sem.type, title: sem.title, snippet: "",
            score: m.score, location: sem.location, path: sem.path,
            project: sem.project, tags: sem.tags, updated: sem.updated,
          };
        });
        // Total: union of unique ids across both branches
        const unionIds = new Set<string>([...ftsRes.results.map((r) => r.id), ...semRes.results.map((r) => r.id)]);
        total = unionIds.size;
      }

      deps.auditor.write({
        op: "search",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        query: input.query,
        result_count: results.length,
        mode,
      });

      return { results, total };
    },
  };
}
