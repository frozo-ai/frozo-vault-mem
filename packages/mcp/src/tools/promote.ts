import { existsSync, readFileSync, renameSync } from "node:fs";
import matter from "gray-matter";
import { ToolError } from "../errors.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import {
  vaultPaths, type MemoryType, MEMORY_TYPES,
} from "../vault/paths.js";

export interface PromoteToolInput {
  id: string;
  reason?: string;
}

export interface PromoteToolOutput {
  id: string;
  from: string;
  to: string;
}

export interface PromoteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createPromoteTool(deps: PromoteToolDeps) {
  const paths = vaultPaths(deps.vault);

  function findInbox(id: string): { path: string; type: MemoryType } | null {
    for (const t of MEMORY_TYPES) {
      const p = paths.memoryFile(t, id, "inbox");
      if (existsSync(p)) return { path: p, type: t };
    }
    return null;
  }

  function findAnywhere(id: string): boolean {
    for (const loc of ["inbox", "memory"] as const) {
      for (const t of MEMORY_TYPES) {
        if (existsSync(paths.memoryFile(t, id, loc))) return true;
      }
    }
    return existsSync(paths.memoryFile("decision", id, "archive"));
  }

  return {
    async handle(input: PromoteToolInput): Promise<PromoteToolOutput> {
      const inboxHit = findInbox(input.id);
      if (!inboxHit) {
        if (findAnywhere(input.id)) {
          throw new ToolError(
            "not_in_inbox",
            `Memory ${input.id} exists but is not in inbox/`,
          );
        }
        throw new ToolError("not_found", `No memory with id ${input.id}`);
      }
      const { path: from, type } = inboxHit;
      const { data } = matter(readFileSync(from, "utf8"));
      const validation = validateFrontmatter(deps.schemas, type, data);
      if (!validation.ok) {
        throw new ToolError(
          "invalid_schema",
          `Cannot promote: frontmatter at ${from} is invalid`,
          validation.errors,
        );
      }
      const to = paths.memoryFile(type, input.id, "memory");
      try {
        renameSync(from, to);
      } catch (err) {
        throw new ToolError(
          "promote_failed",
          `Failed to move ${from} → ${to}: ${(err as Error).message}`,
        );
      }
      const idxRow = deps.index.getById(input.id);
      if (idxRow) deps.index.upsert({ ...idxRow, location: "memory", path: to });

      deps.auditor.write({
        op: "promote",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        id: input.id,
        from,
        to,
        reason: input.reason,
      });
      return { id: input.id, from, to };
    },
  };
}
