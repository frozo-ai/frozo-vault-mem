import { Auditor } from "../audit/index.js";
import { type IndexHandle, type SearchInput } from "../index/sqlite.js";

export interface SearchToolDeps {
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createSearchTool(deps: SearchToolDeps) {
  return {
    async handle(input: SearchInput) {
      const out = deps.index.search(input);
      deps.auditor.write({
        op: "search",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        query: input.query,
        result_count: out.results.length,
      });
      return out;
    },
  };
}
