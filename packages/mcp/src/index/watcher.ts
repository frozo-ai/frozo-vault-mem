import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import matter from "gray-matter";
import {
  vaultPaths, type MemoryType, type Location, MEMORY_TYPES, PLURAL_TO_TYPE,
} from "../vault/paths.js";
import { type IndexHandle } from "./sqlite.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { createLogger } from "../log.js";

export interface WatcherDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
  debounceMs?: number;
}

export interface WatcherHandle {
  close(): Promise<void>;
}

export function startWatcher(deps: WatcherDeps): WatcherHandle {
  const log = createLogger().child({ module: "watcher" });
  const paths = vaultPaths(deps.vault);
  const watcher: FSWatcher = watch(
    [paths.archiveDir, ...MEMORY_TYPES.flatMap((t) => [paths.memoryDir(t), paths.inboxDir(t)])],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: deps.debounceMs ?? 200, pollInterval: 50 } },
  );

  function locationFor(absPath: string): Location | null {
    const rel = relative(paths.root, absPath);
    const top = rel.split(/[\\/]/)[0];
    if (top === "inbox") return "inbox";
    if (top === "memory") return "memory";
    if (top === "archive") return "archive";
    return null;
  }

  function typeFor(absPath: string, fmType?: string): MemoryType | null {
    const parent = basename(dirname(absPath));
    const t = PLURAL_TO_TYPE[parent];
    if (t) return t;
    if (fmType && (MEMORY_TYPES as readonly string[]).includes(fmType)) {
      return fmType as MemoryType;
    }
    return null;
  }

  async function reconcile(absPath: string): Promise<void> {
    if (!absPath.endsWith(".md")) return;
    const loc = locationFor(absPath);
    if (!loc) return;
    let raw: string;
    try { raw = readFileSync(absPath, "utf8"); }
    catch { return; }
    const { data, content } = matter(raw);
    const type = typeFor(absPath, data.type as string | undefined);
    if (!type) return;
    const validation = validateFrontmatter(deps.schemas, type, data);
    if (!validation.ok) {
      log.warn({ path: absPath, errors: validation.errors }, "skipping invalid frontmatter");
      return;
    }
    const fm = data as Record<string, unknown>;
    const id = String(fm.id);
    deps.index.upsert({
      id,
      type,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as "active" | "archived" | "superseded") ?? "active",
      location: loc,
      path: absPath,
      updated: String(fm.updated),
    });
  }

  function unlinkPath(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const id = basename(absPath, ".md");
    deps.index.delete(id);
  }

  watcher.on("add", reconcile).on("change", reconcile).on("unlink", unlinkPath);

  return { async close() { await watcher.close(); } };
}
