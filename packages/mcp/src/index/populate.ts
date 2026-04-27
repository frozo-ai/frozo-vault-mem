import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import {
  vaultPaths, MEMORY_TYPES, PLURAL_TO_TYPE, type MemoryType, type Location,
} from "../vault/paths.js";
import { type IndexHandle, type IndexRow } from "./sqlite.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";

export interface PopulateDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
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

  deps.index.rebuild(rows);
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
