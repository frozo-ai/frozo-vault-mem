import { resolveConfigPaths, loadConfig } from "../config/index.js";
import { openIndex } from "../index/sqlite.js";
import { createGraphTool, type GraphOutput } from "../tools/graph.js";

export interface RunGraphCliOpts {
  vault: string;
  rootId: string;
  depth?: number;
  maxNodes?: number;
}

export async function runGraphCli(opts: RunGraphCliOpts): Promise<GraphOutput> {
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const index = openIndex(config.resolvedIndexPath);
  try {
    const tool = createGraphTool({ vault: opts.vault, index });
    return await tool.handle({
      root_id: opts.rootId,
      ...(opts.depth !== undefined && { depth: opts.depth }),
      ...(opts.maxNodes !== undefined && { max_nodes: opts.maxNodes }),
    });
  } finally {
    index.close();
  }
}
