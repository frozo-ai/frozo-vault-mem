import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";
import { openLance } from "../index/lance.js";
import { createTransformersEmbedder } from "../embedder/index.js";
import { vaultPaths } from "../vault/paths.js";

export interface ReindexOpts {
  vault: string;
  ftsOnly?: boolean;
  semanticOnly?: boolean;
}

export interface ReindexResult {
  count: number;
  // Rough split: populateIndex runs FTS + embeddings in a single batch,
  // so we report total under ftsMs and 0 for semanticMs when ftsOnly,
  // total under semanticMs and 0 for ftsMs when semanticOnly,
  // and a heuristic 5/95 split (FTS is fast; embedding dominates) otherwise.
  ftsMs: number;
  semanticMs: number;
}

export async function runReindex(opts: ReindexOpts): Promise<ReindexResult> {
  if (opts.ftsOnly && opts.semanticOnly) {
    throw new Error("--fts-only and --semantic-only are mutually exclusive");
  }

  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const paths = vaultPaths(opts.vault);
  const lanceDir = join(paths.systemDir, "embeddings.lance");

  if (opts.semanticOnly) {
    // Drop only the Lance directory
    if (existsSync(lanceDir)) rmSync(lanceDir, { recursive: true, force: true });
  } else {
    // Drop FTS index files
    if (existsSync(config.resolvedIndexPath)) rmSync(config.resolvedIndexPath);
    if (existsSync(config.resolvedIndexPath + "-wal")) rmSync(config.resolvedIndexPath + "-wal");
    if (existsSync(config.resolvedIndexPath + "-shm")) rmSync(config.resolvedIndexPath + "-shm");
    if (!opts.ftsOnly) {
      // Also drop Lance directory
      if (existsSync(lanceDir)) rmSync(lanceDir, { recursive: true, force: true });
    }
  }

  const schemas = loadSchemas(opts.vault);
  const idx = openIndex(config.resolvedIndexPath);
  const lance = await openLance(lanceDir);
  const embedder = createTransformersEmbedder();
  const t0 = Date.now();
  const { count } = await populateIndex({ vault: opts.vault, index: idx, schemas, embedder, lance });
  const totalMs = Date.now() - t0;
  idx.close();
  await lance.close();

  // Heuristic timing split: FTS is fast (~5%), embeddings dominate (~95%).
  // When a single-mode flag was given, all time goes to that bucket.
  let ftsMs: number;
  let semanticMs: number;
  if (opts.ftsOnly) {
    ftsMs = totalMs;
    semanticMs = 0;
  } else if (opts.semanticOnly) {
    ftsMs = 0;
    semanticMs = totalMs;
  } else {
    ftsMs = Math.round(totalMs * 0.05);
    semanticMs = totalMs - ftsMs;
  }

  return { count, ftsMs, semanticMs };
}
