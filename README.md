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

- `memory.read` · `memory.write` · `memory.search` · `memory.promote`

## CLI

- `init` · `doctor` · `reindex` · `tail-audit`

## Development

```bash
pnpm test            # all tests
pnpm typecheck
pnpm --filter @vault-mem/mcp dev    # tsx-run during dev
```
