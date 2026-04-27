import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as ulidModule from "ulid";
const { ulid } = ulidModule as unknown as { ulid: () => string };
import { loadSchemas } from "../schema/index.js";
import { loadConfig } from "../config/index.js";
import { Auditor } from "../audit/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";
import { startWatcher, type WatcherHandle } from "../index/watcher.js";
import { vaultPaths } from "../vault/paths.js";
import {
  createReadTool,
  createWriteTool,
  createSearchTool,
  createPromoteTool,
} from "../tools/index.js";
import { ToolError } from "../errors.js";
import { createLogger } from "../log.js";

export interface BuildServerOpts {
  vault: string;
}

export interface BuiltServer {
  server: Server;
  shutdown: () => Promise<void>;
}

const TOOL_DEFS = [
  {
    name: "memory.write",
    description: "Create a new memory in the vault inbox.",
    inputSchema: {
      type: "object",
      required: ["type", "fields", "content"],
      properties: {
        type: {
          type: "string",
          enum: [
            "decision",
            "observation",
            "todo",
            "learning",
            "summary",
            "entity",
            "question",
          ],
        },
        fields: { type: "object" },
        content: { type: "string" },
        agent: { type: "string" },
      },
    },
  },
  {
    name: "memory.read",
    description: "Read a memory by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "memory.search",
    description: "Full-text search the vault.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        project: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "archived", "superseded"],
        },
        location: {
          type: "string",
          enum: ["inbox", "memory", "archive", "any"],
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "memory.promote",
    description: "Move a memory from inbox/ to memory/.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, reason: { type: "string" } },
    },
  },
] as const;

export async function buildServer(opts: BuildServerOpts): Promise<BuiltServer> {
  const log = createLogger().child({ module: "server" });
  const paths = vaultPaths(opts.vault);
  const config = loadConfig(opts.vault);
  const schemas = loadSchemas(opts.vault);
  const auditor = new Auditor(paths.auditFile);
  const index = openIndex(paths.indexFile);

  if (config.fts.rebuild_on_startup || index.count() === 0) {
    await populateIndex({ vault: opts.vault, index, schemas });
  }

  const watcher: WatcherHandle = startWatcher({
    vault: opts.vault,
    index,
    schemas,
  });
  const session = ulid();
  const sessionAgent = config.default_agent;

  const writeTool = createWriteTool({
    vault: opts.vault,
    schemas,
    auditor,
    index,
    defaultAgent: sessionAgent,
  });
  const readTool = createReadTool({
    vault: opts.vault,
    schemas,
    auditor,
    index,
    agent: sessionAgent,
    session,
  });
  const searchTool = createSearchTool({
    auditor,
    index,
    agent: sessionAgent,
    session,
  });
  const promoteTool = createPromoteTool({
    vault: opts.vault,
    schemas,
    auditor,
    index,
    agent: sessionAgent,
    session,
  });

  const server = new Server(
    { name: "vault-mem-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOL_DEFS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let out: unknown;
      const a = (args ?? {}) as Record<string, unknown>;
      switch (name) {
        case "memory.write":
          out = await writeTool.handle(a as never);
          break;
        case "memory.read":
          out = await readTool.handle(a as never);
          break;
        case "memory.search":
          out = await searchTool.handle(a as never);
          break;
        case "memory.promote":
          out = await promoteTool.handle(a as never);
          break;
        default:
          throw new ToolError("internal_error", `Unknown tool: ${name}`);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    } catch (err) {
      const corr = ulid();
      if (err instanceof ToolError) {
        log.debug({ corr, kind: err.kind, message: err.message }, "tool error");
        return {
          isError: true,
          content: [
            { type: "text" as const, text: JSON.stringify(err.toPayload()) },
          ],
        };
      }
      log.error({ corr, err }, "uncaught tool error");
      auditor.write({
        op: `${name.replace("memory.", "")}:failed` as never,
        agent: sessionAgent,
        session,
        correlation_id: corr,
        message: (err as Error).message,
      });
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ kind: "internal_error", correlation_id: corr }),
          },
        ],
      };
    }
  });

  return {
    server,
    async shutdown() {
      await watcher.close();
      index.close();
    },
  };
}
