import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { ToolError } from "../errors.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import {
  vaultPaths, type MemoryType, type Location, MEMORY_TYPES, LOCATIONS,
} from "../vault/paths.js";

export interface ReadToolInput { id: string }

export interface ReadToolOutput {
  id: string;
  type: MemoryType;
  frontmatter: Record<string, unknown>;
  content: string;
  path: string;
  location: Location;
}

export interface ReadToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createReadTool(deps: ReadToolDeps) {
  const paths = vaultPaths(deps.vault);

  function findOnDisk(id: string): { path: string; location: Location; type: MemoryType } | null {
    for (const loc of LOCATIONS) {
      if (loc === "archive") {
        const p = paths.memoryFile("decision", id, "archive");
        if (existsSync(p)) {
          // We don't know the type from the path; parse the file to learn
          const { data } = matter(readFileSync(p, "utf8"));
          return { path: p, location: "archive", type: data.type as MemoryType };
        }
        continue;
      }
      for (const t of MEMORY_TYPES) {
        const p = paths.memoryFile(t, id, loc);
        if (existsSync(p)) return { path: p, location: loc, type: t };
      }
    }
    return null;
  }

  return {
    async handle(input: ReadToolInput): Promise<ReadToolOutput> {
      const indexed = deps.index.getById(input.id);
      let path: string, location: Location, type: MemoryType;

      if (indexed) {
        path = indexed.path;
        location = indexed.location;
        type = indexed.type;
      } else {
        const found = findOnDisk(input.id);
        if (!found) {
          throw new ToolError("not_found", `No memory with id ${input.id}`);
        }
        path = found.path;
        location = found.location;
        type = found.type;
      }

      const raw = readFileSync(path, "utf8");
      const { data, content } = matter(raw);
      const validation = validateFrontmatter(deps.schemas, type, data);
      if (!validation.ok) {
        throw new ToolError(
          "invalid_schema",
          `Frontmatter at ${path} failed schema validation`,
          validation.errors,
        );
      }

      deps.auditor.write({
        op: "read",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        id: input.id,
      });

      return { id: input.id, type, frontmatter: data, content, path, location };
    },
  };
}
