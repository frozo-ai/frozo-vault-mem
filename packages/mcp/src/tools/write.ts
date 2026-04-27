import { mkdirSync } from "node:fs";
import matter from "gray-matter";
import { generateId } from "../id/index.js";
import { atomicWrite } from "../vault/atomicWrite.js";
import { withLock } from "../vault/lock.js";
import { vaultPaths, type MemoryType } from "../vault/paths.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import { ToolError } from "../errors.js";
import type { Embedder } from "../embedder/index.js";
import { EMBED_MODEL_ID } from "../embedder/index.js";
import type { LanceHandle } from "../index/lance.js";

export interface WriteToolInput {
  type: MemoryType;
  fields: Record<string, unknown>;
  content: string;
  agent?: string;
  session?: string | null;
}

export interface WriteToolOutput {
  id: string;
  path: string;
  warnings: string[];
}

export interface WriteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  defaultAgent: string;
  defaultSession?: string | null;
  embedder: Embedder;
  lance: LanceHandle;
}

const DEFAULT_TTL: Record<MemoryType, number | null> = {
  decision: null,
  observation: 90,
  todo: 30,
  learning: 180,
  summary: null,
  entity: null,
  question: null,
};

export function createWriteTool(deps: WriteToolDeps) {
  const paths = vaultPaths(deps.vault);

  return {
    async handle(input: WriteToolInput): Promise<WriteToolOutput> {
      const id = generateId();
      const now = new Date().toISOString();
      const agent = input.agent ?? deps.defaultAgent;
      const session = input.session ?? deps.defaultSession ?? null;

      const fm: Record<string, unknown> = {
        ...input.fields,
        id,
        type: input.type,
        agent,
        session,
        created: now,
        updated: now,
        status: "active",
        schema_version: "0.1",
      };
      if (fm.ttl_days === undefined) fm.ttl_days = DEFAULT_TTL[input.type];
      if (fm.confidence === undefined) {
        fm.confidence = agent === "human" ? 1.0 : 0.7;
      }
      for (const k of ["sources", "contradicts", "supersedes", "tags"]) {
        if (fm[k] === undefined) fm[k] = [];
      }
      if (fm.project === undefined) fm.project = null;

      const validation = validateFrontmatter(deps.schemas, input.type, fm);
      if (!validation.ok) {
        throw new ToolError(
          "schema_validation_failed",
          "Frontmatter failed schema validation",
          validation.errors,
        );
      }

      const targetPath = paths.memoryFile(input.type, id, "inbox");
      mkdirSync(paths.inboxDir(input.type), { recursive: true });
      const serialized = matter.stringify(input.content, fm);

      await withLock(paths.inboxDir(input.type), async () => {
        atomicWrite(targetPath, serialized);
      });

      deps.auditor.write({
        op: "write",
        agent,
        session,
        id,
        type: input.type,
        path: targetPath,
        schema_version: "0.1",
      });

      deps.index.upsert({
        id,
        type: input.type,
        title: String(fm.title),
        body: input.content,
        tags: (fm.tags as string[]) ?? [],
        project: (fm.project as string | null) ?? null,
        status: "active",
        location: "inbox",
        path: targetPath,
        updated: now,
      });

      const warnings: string[] = [];
      try {
        const tagsArr = (fm["tags"] as string[] | undefined) ?? [];
        const embedText = [String(fm["title"]), tagsArr.join(", "), input.content]
          .filter((s) => s && s.length > 0)
          .join("\n");
        const vector = await deps.embedder.embed(embedText);
        await deps.lance.upsert({
          id,
          vector,
          type: input.type,
          title: String(fm["title"]),
          project: (fm["project"] as string | null | undefined) ?? null,
          tags: tagsArr,
          status: "active",
          location: "inbox",
          path: targetPath,
          updated: String(fm["updated"]),
          schema_version: "0.1",
          embed_model: EMBED_MODEL_ID,
        });
      } catch (_err) {
        warnings.push("semantic_index_lagged");
      }

      return { id, path: targetPath, warnings };
    },
  };
}
