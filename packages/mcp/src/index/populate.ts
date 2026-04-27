import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import {
  vaultPaths, MEMORY_TYPES, PLURAL_TO_TYPE, type MemoryType, type Location,
} from "../vault/paths.js";
import { type IndexHandle, type IndexRow } from "./sqlite.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import type { Embedder } from "../embedder/index.js";
import { EMBED_MODEL_ID } from "../embedder/index.js";
import type { LanceHandle, LanceRow } from "./lance.js";

export interface PopulateDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
  embedder: Embedder;
  lance: LanceHandle;
  skipLance?: boolean;  // when true, populate FTS only and leave Lance untouched
  skipFts?: boolean;    // when true, skip FTS rebuild (Lance still rebuilt)
}

export async function populateIndex(deps: PopulateDeps): Promise<{ count: number }> {
  const paths = vaultPaths(deps.vault);
  const rows: IndexRow[] = [];

  for (const loc of ["memory", "inbox"] as const) {
    for (const t of MEMORY_TYPES) {
      const dir = loc === "memory" ? paths.memoryDir(t) : paths.inboxDir(t);
      collectFromDir(dir, t, loc, rows, deps.schemas);
    }
  }
  collectArchive(paths.archiveDir, rows, deps.schemas);

  if (!deps.skipFts) {
    deps.index.rebuild(rows);
  }

  // Batch-embed and rebuild Lance
  if (!deps.skipLance) {
    if (rows.length === 0) {
      await deps.lance.rebuild([]);
    } else {
      const BATCH = 32;
      const lanceRows: LanceRow[] = [];
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const texts = batch.map((r) => [r.title, r.tags.join(", "), r.body].filter(Boolean).join("\n"));
        const vectors = await deps.embedder.embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          const r = batch[j]!;
          lanceRows.push({
            id: r.id,
            vector: vectors[j]!,
            type: r.type,
            title: r.title,
            project: r.project,
            tags: r.tags,
            status: r.status,
            location: r.location,
            path: r.path,
            updated: r.updated,
            schema_version: "0.1",
            embed_model: EMBED_MODEL_ID,
          });
        }
      }
      await deps.lance.rebuild(lanceRows);
    }
  }

  return { count: rows.length };
}

function collectFromDir(
  dir: string,
  type: MemoryType,
  loc: Location,
  rows: IndexRow[],
  schemas: CompiledSchemas,
): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const { data, content } = matter(readFileSync(path, "utf8"));
    const v = validateFrontmatter(schemas, type, data);
    if (!v.ok) continue;
    const fm = data as Record<string, unknown>;
    rows.push({
      id: String(fm.id),
      type,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as IndexRow["status"]) ?? "active",
      location: loc,
      path,
      updated: String(fm.updated),
    });
  }
}

function collectArchive(dir: string, rows: IndexRow[], schemas: CompiledSchemas): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const { data, content } = matter(readFileSync(path, "utf8"));
    const t = data.type as MemoryType | undefined;
    if (!t || !(MEMORY_TYPES as readonly string[]).includes(t)) continue;
    const v = validateFrontmatter(schemas, t, data);
    if (!v.ok) continue;
    const fm = data as Record<string, unknown>;
    rows.push({
      id: String(fm.id),
      type: t,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as IndexRow["status"]) ?? "archived",
      location: "archive",
      path,
      updated: String(fm.updated),
    });
  }
}
