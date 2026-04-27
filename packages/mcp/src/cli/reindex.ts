import { existsSync, rmSync } from "node:fs";
import { loadConfig, resolveConfigPaths } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";

export interface ReindexOpts { vault: string }
export interface ReindexResult { count: number; ms: number }

export async function runReindex(opts: ReindexOpts): Promise<ReindexResult> {
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  if (existsSync(config.resolvedIndexPath)) rmSync(config.resolvedIndexPath);
  if (existsSync(config.resolvedIndexPath + "-wal")) rmSync(config.resolvedIndexPath + "-wal");
  if (existsSync(config.resolvedIndexPath + "-shm")) rmSync(config.resolvedIndexPath + "-shm");

  const schemas = loadSchemas(opts.vault);
  const idx = openIndex(config.resolvedIndexPath);
  const t0 = Date.now();
  const { count } = await populateIndex({ vault: opts.vault, index: idx, schemas });
  idx.close();
  return { count, ms: Date.now() - t0 };
}
