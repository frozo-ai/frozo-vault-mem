import { Auditor } from "../audit/index.js";
import { type IndexHandle, type SearchInput } from "../index/sqlite.js";

export interface SearchToolDeps {
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
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
  return {
    async handle(input: SearchInput) {
      const ftsQuery = buildFtsQuery(input.query);

      if (!ftsQuery) {
        deps.auditor.write({
          op: "search",
          agent: deps.agent ?? "unknown",
          session: deps.session ?? null,
          query: input.query,
          result_count: 0,
        });
        return { results: [], total: 0 };
      }

      const out = deps.index.search({ ...input, query: ftsQuery });

      deps.auditor.write({
        op: "search",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        query: input.query, // audit the raw user-intent query, not the FTS expression
        result_count: out.results.length,
      });
      return out;
    },
  };
}
