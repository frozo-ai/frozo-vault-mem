import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as ulidModule from "ulid";
const { ulid } = ulidModule as unknown as { ulid: () => string };
import { join } from "node:path";
import { loadSchemas } from "../schema/index.js";
import { loadConfig, resolveConfigPaths } from "../config/index.js";
import { Auditor } from "../audit/index.js";
import { openIndex } from "../index/sqlite.js";
import type { SearchInput } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";
import { startWatcher, type WatcherHandle } from "../index/watcher.js";
import { openLance, type LanceHandle } from "../index/lance.js";
import { createTransformersEmbedder, type Embedder } from "../embedder/index.js";
import { vaultPaths } from "../vault/paths.js";
import {
  createReadTool,
  createWriteTool,
  createSearchTool,
  createPromoteTool,
  createContextTool,
} from "../tools/index.js";
import type { WriteToolInput } from "../tools/write.js";
import type { ReadToolInput } from "../tools/read.js";
import type { PromoteToolInput } from "../tools/promote.js";
import type { ContextToolInput } from "../tools/context.js";
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
    name: "memory_write",
    description:
      "Record a decision, observation, learning, todo, entity, or question into the user's persistent vault. " +
      "USE THIS PROACTIVELY whenever the user: makes a choice ('we'll go with X'), shares a learning or insight, " +
      "describes a person/project/tool worth remembering, agrees on a strategy, or hits a decision point. " +
      "Don't wait for explicit instruction — write the memory in the same turn the moment is observed. " +
      "`fields` MUST include `title: string`; `tags: string[]`, `project: string`, `confidence: 0..1` are recommended. " +
      "`content` is the markdown body (rationale, context, alternatives considered). " +
      "Memory lands in inbox/ and is auto-promoted by the keeper daemon after 24h.",
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
    name: "memory_read",
    description:
      "Fetch one memory by exact id. Use after `memory_search` returns the row you want, " +
      "or when the user references an id directly. Returns frontmatter, full markdown body, " +
      "current location (inbox/memory/archive), and absolute path.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "memory_search",
    description:
      "Search the vault for memories. USE THIS BEFORE answering any question about the user's projects, " +
      "decisions, people, or tools — the user has a persistent memory layer; consult it before relying on " +
      "conversation context alone or guessing. Default mode is `hybrid` (combines keyword + semantic search " +
      "via Reciprocal Rank Fusion) — use it for natural-language queries. Use `mode: 'fts'` for exact-token " +
      "queries (ids, brand names) or `mode: 'semantic'` when you want only meaning-based matches. " +
      "Filter by `type`, `project`, `status`, or `location` to narrow results. " +
      "Returns ranked list with id, title, snippet, score, and metadata.",
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
        mode: { type: "string", enum: ["fts", "semantic", "hybrid"] },
      },
    },
  },
  {
    name: "memory_promote",
    description:
      "Manually graduate a memory from inbox/ to canonical memory/ before the keeper's 24h auto-promote tick. " +
      "Use only when the user explicitly asks to confirm or promote a memory. The keeper daemon promotes most " +
      "memories automatically; manual promote is for cases where the user wants something canonical immediately.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, reason: { type: "string" } },
    },
  },
  {
    name: "memory_context",
    description:
      "Load a curated bundle of memories for a project, packed within a token budget. " +
      "USE THIS AT THE START of any multi-turn project conversation to ground yourself in the user's " +
      "prior decisions, learnings, and notes. Pass `query` for semantic-led ranking around a specific " +
      "topic (e.g., 'authentication choices'); omit `query` to get a recency-led, summary-first dump " +
      "of the project. Returns ordered list of memory cards with bucket type, content, and token estimate. " +
      "Treat the result as authoritative project context the user expects you to know.",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string" },
        max_tokens: { type: "integer", minimum: 100, maximum: 16000 },
        query: { type: "string" },
        include_inbox: { type: "boolean" },
      },
    },
  },
] as const;

export async function buildServer(opts: BuildServerOpts): Promise<BuiltServer> {
  const log = createLogger().child({ module: "server" });
  const paths = vaultPaths(opts.vault);
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const schemas = loadSchemas(opts.vault);
  const auditor = new Auditor(config.resolvedAuditPath);
  const index = openIndex(config.resolvedIndexPath);
  const lanceDir = join(paths.systemDir, "embeddings.lance");
  const lance: LanceHandle = await openLance(lanceDir);
  const embedder: Embedder = createTransformersEmbedder();

  if (config.fts.rebuild_on_startup || index.count() === 0) {
    await populateIndex({ vault: opts.vault, index, schemas, embedder, lance });
  }

  const watcher: WatcherHandle = startWatcher({
    vault: opts.vault,
    index,
    schemas,
    embedder,
    lance,
  });
  const session = ulid();
  const sessionAgent = config.default_agent;

  const writeTool = createWriteTool({
    vault: opts.vault,
    schemas,
    auditor,
    index,
    defaultAgent: sessionAgent,
    defaultSession: session,
    embedder,
    lance,
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
    lance,
    embedder,
  });
  const promoteTool = createPromoteTool({
    vault: opts.vault,
    schemas,
    auditor,
    index,
    agent: sessionAgent,
    session,
    lance,
  });
  const contextTool = createContextTool({
    vault: opts.vault,
    auditor,
    index,
    lance,
    embedder,
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
        case "memory_write":
          out = await writeTool.handle(a as unknown as WriteToolInput);
          break;
        case "memory_read":
          out = await readTool.handle(a as unknown as ReadToolInput);
          break;
        case "memory_search":
          out = await searchTool.handle(a as unknown as SearchInput);
          break;
        case "memory_promote":
          out = await promoteTool.handle(a as unknown as PromoteToolInput);
          break;
        case "memory_context":
          out = await contextTool.handle(a as unknown as ContextToolInput);
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
        op: `${name.replace(/^memory[_.]/, "")}:failed` as never,
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
      await lance.close();
    },
  };
}
