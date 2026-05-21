import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createPromoteTool } from "../../src/tools/promote.js";
import { createGraphTool } from "../../src/tools/graph.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex, type IndexHandle } from "../../src/index/sqlite.js";
import { openLance, type LanceHandle } from "../../src/index/lance.js";
import { createMockEmbedder } from "../../src/embedder/mock.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";
import { ToolError } from "../../src/errors.js";

interface Harness {
  v: TmpVault;
  idx: IndexHandle;
  lance: LanceHandle;
  writeT: ReturnType<typeof createWriteTool>;
  promoteT: ReturnType<typeof createPromoteTool>;
  graphT: ReturnType<typeof createGraphTool>;
}

async function setup(v: TmpVault): Promise<Harness> {
  const paths = vaultPaths(v.root);
  for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  const schemas = loadSchemas(v.root);
  const idx = openIndex(":memory:");
  const auditor = new Auditor(paths.auditFile);
  const lanceDir = mkdtempSync(join(tmpdir(), "vault-mem-graph-lance-"));
  const lance = await openLance(lanceDir);
  const embedder = createMockEmbedder();
  const writeT = createWriteTool({
    vault: v.root, schemas, auditor, index: idx,
    defaultAgent: "human", lance, embedder,
  });
  const promoteT = createPromoteTool({ vault: v.root, schemas, auditor, index: idx, lance });
  const graphT = createGraphTool({ vault: v.root, index: idx });
  return { v, idx, lance, writeT, promoteT, graphT };
}

async function write(
  h: Harness,
  type: "decision" | "entity" | "observation",
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const baseFields: Record<string, unknown> = { title, ...extra };
  if (type === "entity" && baseFields.entity_kind === undefined) {
    baseFields.entity_kind = "project";
  }
  const w = await h.writeT.handle({
    type, fields: baseFields, content: "body", agent: "human",
  });
  await h.promoteT.handle({ id: w.id });
  return w.id;
}

describe("memory_graph", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("returns root only when there are no edges", async () => {
    const h = await setup(v);
    const id = await write(h, "entity", "FleetML");
    const out = await h.graphT.handle({ root_id: id });
    expect(out.root).toBe(id);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]!.id).toBe(id);
    expect(out.edges).toHaveLength(0);
    expect(out.truncated).toBe(false);
    expect(out.depth).toBe(1);
    expect(out.max_nodes).toBe(50);
  });

  it("walks outgoing supersedes (winner→loser)", async () => {
    const h = await setup(v);
    const loser = await write(h, "decision", "Use Auth0");
    const winner = await write(h, "decision", "Use Supabase", { supersedes: [loser] });
    const out = await h.graphT.handle({ root_id: winner });
    expect(out.nodes.map((n) => n.id).sort()).toEqual([loser, winner].sort());
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toEqual({ from: winner, to: loser, kind: "supersedes" });
  });

  it("walks incoming supersedes (loser → winner via reverse index)", async () => {
    const h = await setup(v);
    const loser = await write(h, "decision", "Use Auth0");
    const winner = await write(h, "decision", "Use Supabase", { supersedes: [loser] });
    const out = await h.graphT.handle({ root_id: loser });
    expect(out.nodes.map((n) => n.id).sort()).toEqual([loser, winner].sort());
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toEqual({ from: winner, to: loser, kind: "supersedes" });
  });

  it("treats contradicts as symmetric (one edge regardless of direction)", async () => {
    const h = await setup(v);
    const a = await write(h, "decision", "Ship Monday");
    const b = await write(h, "decision", "Ship Friday", { contradicts: [a] });
    // Both directions exist, but only one edge should be emitted.
    const fromA = await h.graphT.handle({ root_id: a });
    expect(fromA.edges.filter((e) => e.kind === "contradicts")).toHaveLength(1);
    const fromB = await h.graphT.handle({ root_id: b });
    expect(fromB.edges.filter((e) => e.kind === "contradicts")).toHaveLength(1);
  });

  it("respects depth: depth=1 stops at one hop, depth=2 keeps walking", async () => {
    const h = await setup(v);
    // Chain: a ← b ← c   (c.supersedes ∋ b, b.supersedes ∋ a)
    const a = await write(h, "decision", "v1");
    const b = await write(h, "decision", "v2", { supersedes: [a] });
    const c = await write(h, "decision", "v3", { supersedes: [b] });

    const d1 = await h.graphT.handle({ root_id: a, depth: 1 });
    expect(d1.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());

    const d2 = await h.graphT.handle({ root_id: a, depth: 2 });
    expect(d2.nodes.map((n) => n.id).sort()).toEqual([a, b, c].sort());
  });

  it("handles cycles without infinite loop", async () => {
    const h = await setup(v);
    // Both memories list each other in `contradicts` — symmetric cycle.
    const a = await write(h, "decision", "A");
    const b = await write(h, "decision", "B", { contradicts: [a] });
    // Now manually add `contradicts: [b]` to A by re-writing? Write
    // tool always creates new files. Easier: rely on the reverse index —
    // when we hit B from A, the reverse-contradicts will surface A
    // again, which `visited` correctly de-dupes.
    const out = await h.graphT.handle({ root_id: a, depth: 3 });
    expect(out.nodes.map((n) => n.id).sort()).toEqual([a, b].sort());
    // Edge deduped: only one contradicts edge between A and B.
    expect(out.edges.filter((e) => e.kind === "contradicts")).toHaveLength(1);
  });

  it("truncates when max_nodes is reached", async () => {
    const h = await setup(v);
    const root = await write(h, "entity", "Hub");
    // 5 memories all superseding the root — root is referenced by them.
    for (let i = 0; i < 5; i++) {
      await write(h, "decision", `Replacement ${i}`, { supersedes: [root] });
    }
    const out = await h.graphT.handle({ root_id: root, max_nodes: 3 });
    expect(out.nodes.length).toBe(3); // root + 2 of the 5
    expect(out.truncated).toBe(true);
  });

  it("throws entity_not_found for an unknown id", async () => {
    const h = await setup(v);
    await expect(h.graphT.handle({ root_id: "mem_2099-01-01_deadbe" })).rejects.toBeInstanceOf(ToolError);
  });

  it("rejects depth out of range", async () => {
    const h = await setup(v);
    const id = await write(h, "entity", "Solo");
    await expect(h.graphT.handle({ root_id: id, depth: 0 })).rejects.toMatchObject({ kind: "depth_out_of_range" });
    await expect(h.graphT.handle({ root_id: id, depth: 4 })).rejects.toMatchObject({ kind: "depth_out_of_range" });
  });

  it("rejects max_nodes out of range", async () => {
    const h = await setup(v);
    const id = await write(h, "entity", "Solo");
    await expect(h.graphT.handle({ root_id: id, max_nodes: 0 })).rejects.toMatchObject({ kind: "max_nodes_out_of_range" });
    await expect(h.graphT.handle({ root_id: id, max_nodes: 201 })).rejects.toMatchObject({ kind: "max_nodes_out_of_range" });
  });

  it("includes node metadata (title, type, project, status, tags, confidence)", async () => {
    const h = await setup(v);
    const id = await write(h, "entity", "FleetML", {
      project: "fleetml", tags: ["edge-ai", "live"], confidence: 0.95,
    });
    const out = await h.graphT.handle({ root_id: id });
    const node = out.nodes[0]!;
    expect(node.title).toBe("FleetML");
    expect(node.type).toBe("entity");
    expect(node.project).toBe("fleetml");
    expect(node.tags).toEqual(["edge-ai", "live"]);
    expect(node.confidence).toBe(0.95);
    expect(node.status).toBe("active");
  });
});
