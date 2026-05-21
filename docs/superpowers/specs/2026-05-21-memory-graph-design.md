# Vault-Mem Entity-Graph Projection — Design

**Status:** Approved, ready for implementation
**Date:** 2026-05-21
**Owner:** the maintainer
**PRD:** [`vault-mem-PRD.md`](../../../vault-mem-PRD.md) §6 P1 (line 167), §7 tool table (line 364: `memory.graph` → P1)

---

## 1. Context

The PRD calls for a `memory.graph(entity_id)` tool that returns a neighborhood subgraph — useful for the planned Cloud web UI's entity-graph view (D3 / Mermaid) and for agents that want to walk the decision lineage around a topic. v0.1 of the tool ships the smallest defensible projection: edges that are **already encoded in frontmatter**, no inferred links.

## 2. Scope

**In scope:**

- New MCP tool `memory_graph(root_id, depth?, max_nodes?)` returning JSON `{root, nodes, edges, truncated}`
- New CLI subcommand `vault-mem-mcp graph <id> [--depth N] [--max-nodes N] [--vault PATH]`
- Cloud parity: Postgres RPC `public.memory_graph_neighborhood(p_org_id, p_root_id, p_depth, p_max_nodes) → jsonb`
- Schema migration on Cloud: add `contradicts text[] NOT NULL DEFAULT '{}'` to `public.memories` (gap vs OSS)
- Tests: OSS unit + integration; Cloud SQL test with RLS denial check

**Out of scope (v1):**

- Co-tag / subject-mention / same-project edges. These are inferred, noisy, tunable — defer to v2 with explicit weights.
- Body-prose mention edges. Inference problem; out of scope per the precedent set by the DPDP spec §3.4.
- Mermaid / D3 rendering helpers. Client renders; server stays JSON-only.
- Read-from-graph (e.g. `memory_graph_path(a, b)` shortest-path). v1 returns neighborhoods; pathfinding is v2.
- Mutations via graph (no "link these two via the API"). Edges only land via the existing `memory_supersede` / `memory_write {contradicts: [...]}` paths.
- Web UI implementation. v1 ships the RPC contract; the UI consumes it in a follow-up.

## 3. Edge model

Two edge kinds, both from frontmatter arrays:

| Kind | Source field | Direction | Semantics |
|---|---|---|---|
| `supersedes` | `winner.supersedes ∋ loser_id` | `winner → loser` | Winner replaces loser. Already enforced by `memory_supersede` tool. |
| `contradicts` | `mem.contradicts ∋ other_id` | bidirectional (treated as undirected at graph layer) | These two memories disagree; conflict-detection P1 may surface this. |

**Why both:** they're already in the schema (`_common.json` lines 30–31). Zero data-model work to surface them as graph edges; pure projection.

**Why no inferred edges (co-tag, subject-mention, same-project):** they require thresholds and tuning per project. Shipping them in v1 means committing to defaults; punting to v2 keeps the v1 contract clean and the noise level low. v2 can add a `kinds: ["explicit", "co_tag"]` parameter without breaking v1 callers.

## 4. Traversal algorithm

```
buildGraph(root_id, depth, max_nodes):
  1. Read root memory. If missing → error (entity_not_found).
  2. Build reverse-edge index: scan all memory frontmatters, collect
     reverse_supersedes[id] = [ids that have id in their supersedes[]]
     For contradicts, the edge is symmetric (treat A→B and B→A as one edge).
  3. BFS from root:
     visited = {root}
     queue = [(root, 0)]
     edges = []
     while queue not empty and len(visited) < max_nodes:
       (curr, d) = queue.pop()
       if d >= depth: continue
       neighbors = union(
         curr.supersedes,           # outgoing
         reverse_supersedes[curr.id], # incoming
         curr.contradicts,          # symmetric
         reverse_contradicts[curr.id], # also symmetric (just the inverse view)
       )
       for n in neighbors:
         if len(visited) >= max_nodes:
           truncated = True
           break
         if n not in visited:
           visited.add(n)
           queue.push((n, d+1))
         edges.push(edge_record(curr, n, kind))
  4. Load full frontmatter for each visited id → nodes array.
  5. Return {root, nodes, edges, truncated}.
```

**Defaults:** `depth = 1`, `max_nodes = 50`. Hard ceiling: `depth ≤ 3`, `max_nodes ≤ 200`. Out-of-range → 400-equivalent MCP error (`depth_out_of_range`, `max_nodes_out_of_range`).

**Cycle handling:** `visited` set short-circuits cycles. Edges are deduped by `(from, to, kind)` to avoid double-listing symmetric contradicts edges.

**Reverse-index cost:** O(n) per call where n = active memories in vault. For typical vaults (<10k memories) this is sub-50ms. Acceptable for v1; optimize later via a `_system/links.sqlite` projection cached by the keeper.

## 5. Output shape

```json
{
  "root": "mem_2026-05-11_4ecdb6",
  "nodes": [
    {
      "id": "mem_2026-05-11_4ecdb6",
      "type": "entity",
      "title": "FleetML — open-source, chip-neutral edge MLOps platform",
      "project": "fleetml",
      "status": "active",
      "confidence": 0.95,
      "tags": ["product", "live", "edge-ai"]
    },
    {
      "id": "mem_2026-05-10_294135",
      "type": "entity",
      "title": "EdgeGate — Edge GenAI Regression Gates for Snapdragon",
      "project": "edgegate",
      "status": "active",
      "confidence": 0.95,
      "tags": ["product", "live", "edge-ai"]
    }
  ],
  "edges": [
    {
      "from": "mem_2026-05-11_4ecdb6",
      "to": "mem_2026-05-10_294135",
      "kind": "contradicts"
    }
  ],
  "truncated": false,
  "depth": 1,
  "max_nodes": 50
}
```

Nodes carry just enough metadata for the client to render labels and group by project/status without a second round-trip. Body is intentionally omitted — clients call `memory_read(id)` if they need it.

## 6. OSS API

### 6.1 MCP tool

```
memory_graph(
  root_id: string,              // required
  depth?: number,               // 1..3, default 1
  max_nodes?: number,           // 1..200, default 50
)
→ Graph (see §5)
```

Errors:
- `entity_not_found` — root_id doesn't resolve.
- `depth_out_of_range` — depth < 1 or > 3.
- `max_nodes_out_of_range` — max_nodes < 1 or > 200.

The tool description in the MCP server's `tools/list` carries the "USE THIS proactively when the user asks 'what depends on…', 'what reverses…', 'how is X connected to Y' or wants to see the lineage around a decision/entity" hint (matching the proactive-instruction layer from v0.5.0).

### 6.2 CLI

```bash
vault-mem-mcp graph mem_2026-05-11_4ecdb6
vault-mem-mcp graph mem_2026-05-11_4ecdb6 --depth 2 --max-nodes 100
vault-mem-mcp graph mem_2026-05-11_4ecdb6 --vault ~/some-vault --json
```

Default output is human-readable (count summary + node list); `--json` emits the raw tool response.

## 7. Cloud parity

### 7.1 Schema migration

```sql
-- Add contradicts column (missing from public.memories — OSS has it
-- in frontmatter from day one; Cloud schema never carried it across).
ALTER TABLE public.memories
ADD COLUMN IF NOT EXISTS contradicts text[] NOT NULL DEFAULT '{}';

-- Index for reverse lookup (parity with how supersedes is queried).
CREATE INDEX IF NOT EXISTS memories_contradicts_gin
  ON public.memories USING gin (contradicts);
```

### 7.2 RPC

```sql
CREATE OR REPLACE FUNCTION public.memory_graph_neighborhood(
  p_org_id    uuid,
  p_root_id   text,
  p_depth     int DEFAULT 1,
  p_max_nodes int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
…
$$;
```

Behavior:
1. Verify caller is a member of `p_org_id` via `memberships` table.
2. Verify `p_depth ∈ [1,3]`, `p_max_nodes ∈ [1,200]`.
3. Recursive CTE BFS following both `supersedes` and `contradicts` arrays, scoped to memories where `project_id IN (SELECT id FROM projects WHERE org_id = p_org_id)`.
4. Return JSON matching the OSS shape (§5).

RLS: `SECURITY DEFINER` + explicit org-membership check inside the function; the function never crosses orgs because the recursive CTE's seed query filters by org.

No rate limit in v1 (this is read-only and cheap). Add one later if abuse appears.

### 7.3 Web UI

Out of scope for this spec — separate work item. The contract is stable enough that the UI can be implemented in a follow-up without spec amendment.

## 8. Audit log

`memory_graph` is read-only — no audit entry. Matches the precedent of `memory_search`, `memory_read`, `memory_recent`.

If we later add a write-mode (e.g. "create contradicts edge"), that flows through `memory_write` and inherits its existing audit op, not a new one.

## 9. Tests

**OSS:**
- `tools/graph.test.ts` — unit: depth 0/1/2/3, cycle handling, max_nodes truncation, missing root, contradicts symmetry, supersedes both directions.
- `test/integration/graph.test.ts` — write 3 memories with chained supersedes + one contradicts pair; call `memory_graph`; assert nodes & edges.

**Cloud:**
- `supabase/tests/memory_graph_test.sql` — seed org + project + memories; call RPC; assert JSON shape; call as a member of another org and assert empty result; call with bad depth and assert error.

## 10. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Explicit edges only in v1** (no co-tag, no subject-mention, no project, no body-match) | Inferred edges need thresholds + tuning; punting them keeps the v1 contract clean. v2 can add `kinds:` parameter without breaking callers. |
| 2 | **JSON-only output** (no embedded Mermaid string) | MCP convention; client renders; keeps server stateless. Adding render helpers later is non-breaking. |
| 3 | **OSS + Cloud parity in one ship** | User explicitly chose "Both at once". The Cloud half is mostly one migration + one RPC + tests. Worth ~½ day extra to ship demo-ready everywhere. |
| 4 | **Reverse-edge index built in-memory per call** (no precomputed projection cache) | Vault scale (<10k memories) makes O(n) acceptable. Adding a `_system/links.sqlite` cache is a v1.1 if profiling shows latency issues. |
| 5 | **Add `contradicts` column to Cloud schema** (it was never there) | Without it, Cloud can't represent the same graph OSS can. Tiny additive migration; safe. |
| 6 | **No audit-log entry for `memory_graph`** | Read-only tool; matches `memory_search`/`memory_read` precedent. |

---

## 11. Implementation order

1. OSS spec sign-off (this doc).
2. OSS: `tools/graph.ts` + tests.
3. OSS: register tool in `server/index.ts` + tool description with proactive hint.
4. OSS: CLI subcommand.
5. Cloud: migration adding `contradicts` column.
6. Cloud: RPC.
7. Cloud: SQL test.
8. Apply migration to prod Supabase + smoke-test RPC.
9. Update CLAUDE.md + write Cerebro memory.

Total estimate: ~1 day from this spec.

---

*End of design — 2026-05-21*
