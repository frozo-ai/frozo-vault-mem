import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { ToolError } from "../errors.js";
import { type IndexHandle } from "../index/sqlite.js";
import {
  vaultPaths, type MemoryType, type Location, MEMORY_TYPES, LOCATIONS,
} from "../vault/paths.js";

export type GraphEdgeKind = "supersedes" | "contradicts";

export interface GraphNode {
  id: string;
  type: MemoryType;
  title: string;
  project: string | null;
  status: "active" | "archived" | "superseded" | "erased";
  confidence: number | null;
  tags: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface GraphOutput {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  depth: number;
  max_nodes: number;
}

export interface GraphToolInput {
  root_id: string;
  depth?: number;
  max_nodes?: number;
}

export interface GraphToolDeps {
  vault: string;
  index: IndexHandle;
}

const DEFAULT_DEPTH = 1;
const DEFAULT_MAX_NODES = 50;
const MAX_DEPTH = 3;
const MAX_NODES_HARD = 200;

interface FrontmatterSlice {
  id: string;
  type: MemoryType;
  title: string;
  project: string | null;
  status: GraphNode["status"];
  confidence: number | null;
  tags: string[];
  supersedes: string[];
  contradicts: string[];
}

export function createGraphTool(deps: GraphToolDeps) {
  const paths = vaultPaths(deps.vault);

  function findOnDisk(id: string): { path: string; type: MemoryType } | null {
    for (const loc of LOCATIONS) {
      if (loc === "archive") {
        const p = paths.memoryFile("decision", id, "archive");
        if (existsSync(p)) {
          const { data } = matter(readFileSync(p, "utf8"));
          return { path: p, type: data.type as MemoryType };
        }
        continue;
      }
      for (const t of MEMORY_TYPES) {
        const p = paths.memoryFile(t, id, loc);
        if (existsSync(p)) return { path: p, type: t };
      }
    }
    return null;
  }

  function readSlice(id: string): FrontmatterSlice | null {
    const indexed = deps.index.getById(id);
    const pathHint = indexed?.path ?? findOnDisk(id)?.path;
    if (!pathHint || !existsSync(pathHint)) return null;
    const { data } = matter(readFileSync(pathHint, "utf8"));
    const fm = data as Record<string, unknown>;
    return {
      id,
      type: (fm.type as MemoryType) ?? indexed?.type ?? "observation",
      title: typeof fm.title === "string" ? fm.title : id,
      project: typeof fm.project === "string" ? fm.project : null,
      status: (fm.status as GraphNode["status"]) ?? "active",
      confidence: typeof fm.confidence === "number" ? fm.confidence : null,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      supersedes: Array.isArray(fm.supersedes) ? (fm.supersedes as string[]) : [],
      contradicts: Array.isArray(fm.contradicts) ? (fm.contradicts as string[]) : [],
    };
  }

  // Reverse-edge index built per call. O(n) reads of frontmatters — for
  // typical vaults (<10k) this is sub-200ms. Optimization for v1.1:
  // cache supersedes/contradicts columns in the FTS index so this can
  // run as a single sqlite query.
  function buildReverseIndex(): { rsupersedes: Map<string, string[]>; rcontradicts: Map<string, string[]> } {
    const rsupersedes = new Map<string, string[]>();
    const rcontradicts = new Map<string, string[]>();
    for (const row of deps.index.list({})) {
      const slice = readSlice(row.id);
      if (!slice) continue;
      for (const target of slice.supersedes) {
        const arr = rsupersedes.get(target) ?? [];
        arr.push(slice.id);
        rsupersedes.set(target, arr);
      }
      for (const target of slice.contradicts) {
        const arr = rcontradicts.get(target) ?? [];
        arr.push(slice.id);
        rcontradicts.set(target, arr);
      }
    }
    return { rsupersedes, rcontradicts };
  }

  return {
    async handle(input: GraphToolInput): Promise<GraphOutput> {
      const depth = input.depth ?? DEFAULT_DEPTH;
      const maxNodes = input.max_nodes ?? DEFAULT_MAX_NODES;
      if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
        throw new ToolError("depth_out_of_range", `depth must be an integer in [1, ${MAX_DEPTH}]`);
      }
      if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_NODES_HARD) {
        throw new ToolError("max_nodes_out_of_range", `max_nodes must be an integer in [1, ${MAX_NODES_HARD}]`);
      }

      const rootSlice = readSlice(input.root_id);
      if (!rootSlice) {
        throw new ToolError("entity_not_found", `No memory with id ${input.root_id}`);
      }

      const { rsupersedes, rcontradicts } = buildReverseIndex();

      const slices = new Map<string, FrontmatterSlice>();
      slices.set(rootSlice.id, rootSlice);
      const queue: Array<{ id: string; d: number }> = [{ id: rootSlice.id, d: 0 }];
      const edgeKey = new Set<string>();
      const edges: GraphEdge[] = [];
      let truncated = false;

      function addEdge(from: string, to: string, kind: GraphEdgeKind): void {
        const k = kind === "contradicts" && from > to
          ? `contradicts|${to}|${from}`
          : `${kind}|${from}|${to}`;
        if (edgeKey.has(k)) return;
        edgeKey.add(k);
        edges.push({ from, to, kind });
      }

      while (queue.length > 0) {
        const { id: curr, d } = queue.shift()!;
        if (d >= depth) continue;
        const currSlice = slices.get(curr) ?? readSlice(curr);
        if (!currSlice) continue;

        const fanout: Array<{ neighbor: string; kind: GraphEdgeKind; from: string; to: string }> = [];
        for (const target of currSlice.supersedes) {
          fanout.push({ neighbor: target, kind: "supersedes", from: curr, to: target });
        }
        for (const source of rsupersedes.get(curr) ?? []) {
          fanout.push({ neighbor: source, kind: "supersedes", from: source, to: curr });
        }
        for (const target of currSlice.contradicts) {
          fanout.push({ neighbor: target, kind: "contradicts", from: curr, to: target });
        }
        for (const source of rcontradicts.get(curr) ?? []) {
          fanout.push({ neighbor: source, kind: "contradicts", from: source, to: curr });
        }

        for (const { neighbor, kind, from, to } of fanout) {
          if (slices.size >= maxNodes && !slices.has(neighbor)) {
            truncated = true;
            continue;
          }
          if (!slices.has(neighbor)) {
            const slice = readSlice(neighbor);
            if (!slice) continue;
            slices.set(neighbor, slice);
            queue.push({ id: neighbor, d: d + 1 });
          }
          addEdge(from, to, kind);
        }
      }

      const nodes: GraphNode[] = Array.from(slices.values()).map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        project: s.project,
        status: s.status,
        confidence: s.confidence,
        tags: s.tags,
      }));

      return {
        root: rootSlice.id,
        nodes,
        edges,
        truncated,
        depth,
        max_nodes: maxNodes,
      };
    },
  };
}
