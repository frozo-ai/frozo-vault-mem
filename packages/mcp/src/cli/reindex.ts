import { existsSync, rmSync } from "node:fs";
import { vaultPaths } from "../vault/paths.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";

export interface ReindexOpts { vault: string }
export interface ReindexResult { count: number; ms: number }

export async function runReindex(opts: ReindexOpts): Promise<ReindexResult> {
  const paths = vaultPaths(opts.vault);
  if (existsSync(paths.indexFile)) rmSync(paths.indexFile);
  if (existsSync(paths.indexFile + "-wal")) rmSync(paths.indexFile + "-wal");
  if (existsSync(paths.indexFile + "-shm")) rmSync(paths.indexFile + "-shm");

  const schemas = loadSchemas(opts.vault);
  const idx = openIndex(paths.indexFile);
  const t0 = Date.now();
  const { count } = await populateIndex({ vault: opts.vault, index: idx, schemas });
  idx.close();
  return { count, ms: Date.now() - t0 };
}
