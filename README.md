# Vault-Mem

Personal-use, local-first shared memory layer for an agent stack (Claude Code, Cursor, Frozo Founder OS). See [`vault-mem-prd.md`](vault-mem-prd.md) for context and [`docs/superpowers/specs/`](docs/superpowers/specs/) for current designs.

## Requirements

- Node 20+
- pnpm 9+
- macOS or Linux

## Quick start

```bash
pnpm install
pnpm --filter @vault-mem/mcp build
node packages/mcp/bin/vault-mem-mcp init                 # creates ~/vault-mem/
node packages/mcp/bin/vault-mem-mcp doctor               # health check
node packages/mcp/bin/vault-mem-mcp                       # run MCP server (stdio)
```

## Register with Claude Code

Add to `~/.config/claude-code/mcp.json`:

```json
{
  "mcpServers": {
    "vault-mem": {
      "command": "node",
      "args": ["/absolute/path/to/frozo-vault-mem/packages/mcp/bin/vault-mem-mcp"],
      "env": { "VAULT_MEM_PATH": "/Users/<you>/vault-mem" }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `memory.write` | Create a new memory in the vault inbox. |
| `memory.read` | Read a memory by id. |
| `memory.search` | Search the vault. Accepts `mode: "fts" \| "semantic" \| "hybrid"` (default `"fts"`). Semantic and hybrid modes use the local MiniLM embedding index. |
| `memory.promote` | Move a memory from inbox to memory/. |
| `memory.context` | Get curated context for a project. Summaries lead; when a `query` is supplied, results are semantic-led. Accepts `max_tokens` (100–16000, default 4000), `query` (optional), and `include_inbox` (default false). |

## CLI

- `init` · `doctor` · `reindex` · `tail-audit`

## Development

```bash
pnpm test            # all tests
pnpm typecheck
pnpm --filter @vault-mem/mcp dev    # tsx-run during dev
```
