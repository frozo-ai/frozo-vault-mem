# @vault-mem/mcp

The TypeScript MCP server for [vault-mem](../../README.md). Exposes 5 tools (`memory_write`, `memory_read`, `memory_search`, `memory_promote`, `memory_context`) and 4 CLI subcommands (`init`, `doctor`, `reindex`, `tail-audit`) over stdio.

This package is a workspace member of the vault-mem monorepo. For full project context (architecture, install across all clients, configuration reference), see the [top-level README](../../README.md).

## Install

From the repo root:

```bash
pnpm install
pnpm --filter @vault-mem/mcp build
```

The compiled binary is at `packages/mcp/bin/vault-mem-mcp`.

## Configure

### Vault path resolution (in priority order)

1. `--vault <path>` CLI flag
2. `VAULT_MEM_PATH` environment variable
3. Default: `~/vault-mem/`

### Logging

Pino, JSON to stderr (stdout reserved for MCP protocol). Set `VAULT_MEM_LOG_LEVEL` to `debug` / `info` / `warn` / `error`.

### Vault config

Per-vault knobs live in `<vault>/_system/config.yaml`. Reference: [docs/CONFIG.md](../../docs/CONFIG.md).

## MCP tools

### `memory_write`

Record a memory in the vault inbox.

**Input:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"decision" \| "observation" \| "todo" \| "learning" \| "summary" \| "entity" \| "question"` | yes | Memory type |
| `fields` | object | yes | Frontmatter — must include `title: string`. Recommended: `tags: string[]`, `project: string`, `confidence: 0..1` |
| `content` | string | yes | Markdown body |
| `agent` | string | no | Override the resolved agent name |

**Returns:** `{ id, path, warnings }`. `warnings` may include `"semantic_index_lagged"` if the synchronous embedding step failed (the chokidar watcher will reconcile).

### `memory_read`

Fetch one memory by id.

**Input:** `{ id: string }`

**Returns:** `{ id, type, frontmatter, content, path, location }` where `location` is `"inbox" | "memory" | "archive"`.

### `memory_search`

Search the vault.

**Input:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Free-text query (sanitized for FTS5; semantic mode embeds it) |
| `mode` | `"fts" \| "semantic" \| "hybrid"` | no | Default `"hybrid"` (Reciprocal Rank Fusion of FTS5 BM25 + cosine) |
| `type` | string or string[] | no | Filter by memory type |
| `project` | string | no | Filter by project key |
| `status` | `"active" \| "archived" \| "superseded"` | no | Default returns all |
| `location` | `"inbox" \| "memory" \| "archive" \| "any"` | no | Default `"any"` |
| `limit` | integer (1–100) | no | Default 20 |

**Returns:** `{ results: [...], total: int }` — each result has `id, type, title, snippet, score, location, path, project, tags, updated`.

### `memory_promote`

Manually graduate a memory from `inbox/<type>/` to `memory/<type>/`. The keeper auto-promotes after 24h; this is for cases where you want it canonical immediately.

**Input:** `{ id: string, reason?: string }`

**Returns:** `{ id, from, to }`.

### `memory_context`

Load curated project context within a token budget.

**Input:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `project` | string | yes | Project key |
| `max_tokens` | integer (100–16000) | no | Default 4000 |
| `query` | string | no | If supplied, semantic-led ranking; otherwise summary-led recency walk |
| `include_inbox` | boolean | no | Default `false` (canonical-only) |

**Returns:** `{ items: [...], total_tokens, truncated }` — each item has `id, type, title, content, tokens, bucket`.

## CLI

### `init`

Materialize a fresh vault from the bundled `vault-template/`.

```bash
vault-mem-mcp init [--target <path>] [--git]
```

- `--target` defaults to `$HOME/vault-mem`.
- `--git` runs `git init` + initial commit in the new vault.

### `doctor`

Health check. Verifies 9 invariants: `vault_root`, `folders`, `schemas`, `config`, `index`, `row_count_match`, `audit_log`, `embeddings_index`, `embeddings_count_match`.

```bash
vault-mem-mcp doctor [--vault <path>]
```

Exit code 0 if all PASS, 1 otherwise.

### `reindex`

Drop and rebuild the FTS5 and embedding indexes from the `.md` files.

```bash
vault-mem-mcp reindex [--vault <path>] [--fts-only | --semantic-only]
```

- `--fts-only` rebuilds only the SQLite index; Lance is untouched.
- `--semantic-only` rebuilds only the Lance vector index; FTS is untouched.
- Default: rebuild both.

### `tail-audit`

Pretty-print the JSONL audit log.

```bash
vault-mem-mcp tail-audit [--vault <path>] [-n N] [--follow]
```

- `-n` defaults to 50.
- `--follow` watches for new lines (like `tail -f`).

### `serve` (default)

Run the MCP server over stdio. Invoked by MCP clients automatically; you typically don't run this manually.

## Register with MCP clients

### Claude Code

```bash
claude mcp add --scope user vault-mem \
  -e VAULT_MEM_PATH=$HOME/vault-mem \
  -- node /absolute/path/to/frozo-vault-mem/packages/mcp/bin/vault-mem-mcp
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault-mem": {
      "command": "node",
      "args": ["/absolute/path/to/frozo-vault-mem/packages/mcp/bin/vault-mem-mcp"],
      "env": {
        "VAULT_MEM_PATH": "/Users/<you>/vault-mem"
      }
    }
  }
}
```

Restart Claude Desktop after editing (⌘Q + reopen).

### Other MCP clients

Stdio transport, no special headers. Server name: `vault-mem-mcp`. Protocol version: as supported by `@modelcontextprotocol/sdk` 1.0.x.

## Development

```bash
pnpm --filter @vault-mem/mcp test          # all tests
pnpm --filter @vault-mem/mcp test --watch  # watch mode
pnpm --filter @vault-mem/mcp typecheck
pnpm --filter @vault-mem/mcp build
pnpm --filter @vault-mem/mcp dev           # tsx-run with hot reload
```

Tests are co-located (`src/foo/foo.test.ts`) for unit work; integration and e2e under `test/`.

## Module layout

```
src/
├── server/         # MCP SDK wiring (stdio transport, tool registration)
├── tools/          # 5 tool handlers
├── cli/            # 4 CLI subcommand implementations
├── index/          # SQLite FTS5 + LanceDB + chokidar watcher
├── embedder/       # Transformers.js ONNX MiniLM (lazy-loaded)
├── schema/         # JSON Schema loading + validation
├── audit/          # JSONL audit writer
├── vault/          # File I/O (atomic write, paths, advisory locks)
├── config/         # YAML config loading
├── id/             # Memory ID generator (mem_YYYY-MM-DD_<6 hex>)
├── log.ts          # Pino logger to stderr
└── errors.ts       # Typed error kinds
```

## Tech stack

Node 20+ · TypeScript ESM (NodeNext, strict) · `@modelcontextprotocol/sdk` 1.0.x · `better-sqlite3` (FTS5) · `@lancedb/lancedb` · `@xenova/transformers` (ONNX MiniLM, int8) · `gray-matter` · `chokidar` · `proper-lockfile` · `ajv` (JSON Schema draft-07) · `pino` · `commander` · Vitest for tests.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md) at the repo root.
