import { join } from "node:path";
import { Auditor } from "../audit/index.js";
import { resolveConfigPaths, loadConfig } from "../config/index.js";
import { openIndex } from "../index/sqlite.js";
import { openLance } from "../index/lance.js";
import { vaultPaths } from "../vault/paths.js";
import { createSupersedeTool } from "../tools/supersede.js";

export interface RunSupersedeCliOpts {
  vault: string;
  winner: string;
  loser: string;
  reason?: string;
}

export interface RunSupersedeCliResult {
  alreadyApplied: boolean;
  winnerId: string;
  loserId: string;
  loserFrom: string;
  loserTo: string;
  supersedesCount: number;
}

/**
 * Thin CLI wrapper. Opens the same deps the MCP server does, calls the
 * supersede tool, returns a friendly result. Useful for one-off ops and
 * scripting (bulk supersedes from CSV, etc.).
 *
 * NB: the watcher does NOT run here, so post-op the in-process FTS +
 * Lance handles are updated via the tool's own re-upsert. The next
 * server startup will reconcile from disk anyway.
 */
export async function runSupersedeCli(
  opts: RunSupersedeCliOpts
): Promise<RunSupersedeCliResult> {
  const paths = vaultPaths(opts.vault);
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const auditor = new Auditor(config.resolvedAuditPath);
  const index = openIndex(config.resolvedIndexPath);
  const lance = await openLance(join(paths.systemDir, "embeddings.lance"));

  try {
    const tool = createSupersedeTool({
      vault: opts.vault,
      auditor,
      index,
      lance,
      agent: "cli",
      session: null,
    });
    const out = await tool.handle({
      winner_id: opts.winner,
      loser_id: opts.loser,
      ...(opts.reason !== undefined && { reason: opts.reason }),
    });
    return {
      alreadyApplied: out.already_applied,
      winnerId: out.winner_id,
      loserId: out.loser_id,
      loserFrom: out.loser_from,
      loserTo: out.loser_to,
      supersedesCount: out.supersedes_count,
    };
  } finally {
    index.close();
  }
}
