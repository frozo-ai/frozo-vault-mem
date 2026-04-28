# vault-mem

> A local-first, file-based shared memory layer for your AI agents. One Obsidian-friendly markdown vault, multiple agents, zero cloud dependency.

[![CI](https://github.com/frozo-ai/frozo-vault-mem/actions/workflows/ci.yml/badge.svg)](https://github.com/frozo-ai/frozo-vault-mem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-blue)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.12-blue)](https://www.python.org)

## Why

You work across multiple AI agents — Claude Code, Claude Desktop, Cursor, custom MCP clients. Each one has its own memory and forgets the others. Today your "memory" is scattered across:

- Conversation histories you can't search
- Project context copy-pasted into every new session
- Notion docs you forgot to update

**vault-mem** fixes this with one shared markdown vault that all your agents read from and write to, plus a Python daemon that quietly maintains coherence in the background.

## What you get

- **5 MCP tools** (`memory_write`, `memory_read`, `memory_search`, `memory_promote`, `memory_context`) usable from Claude Code, Claude Desktop, or any MCP-aware client.
- **Hybrid keyword + semantic search** out of the box — SQLite FTS5 BM25 plus local ONNX MiniLM embeddings, fused via Reciprocal Rank Fusion. No API keys, no cloud.
- **A second brain you fully own.** Every memory is a `.md` file at `~/vault-mem/`. Open it in Obsidian. Commit it to git. If every AI company shut down tomorrow, your knowledge survives.
- **Coherence without effort.** A 30-min Python daemon (`packages/keeper`) auto-promotes inbox writes, decays stale observations, archives expired memories, and links semantically-related notes.
- **Audit trail.** Every write/read/search recorded in JSONL (`_system/audit.log`) with SHA-256-hashed query content (no raw queries persisted).

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/frozo-ai/frozo-vault-mem.git
cd frozo-vault-mem
pnpm install
pnpm --filter @vault-mem/mcp build

# 2. Materialize a vault
node packages/mcp/bin/vault-mem-mcp init           # creates ~/vault-mem/
node packages/mcp/bin/vault-mem-mcp doctor         # 9/9 PASS

# 3. Register with Claude Code
claude mcp add --scope user vault-mem \
  -e VAULT_MEM_PATH=$HOME/vault-mem \
  -- node $(pwd)/packages/mcp/bin/vault-mem-mcp

# 4. (Optional) Schedule the keeper daemon (macOS launchd)
cp ops/keeper/com.vaultmem.keeper.plist ~/Library/LaunchAgents/
# edit the file's REPLACE_USER and path placeholders, then:
launchctl load -w ~/Library/LaunchAgents/com.vaultmem.keeper.plist
```

Full guide: [docs/INSTALL.md](docs/INSTALL.md). Configuring Claude Desktop and other MCP clients is covered there.

## Architecture in 30 seconds

```
            ~/vault-mem/  (markdown files; the source of truth)
                  │
   ┌──────────────┼──────────────┐
   │              │              │
  You          AI agents      The keeper
(Obsidian)  (Claude Code/    (Python, every
             Desktop/Cursor   30 min via launchd)
             via MCP)
```

Three actors share one folder. Indexes (FTS5 + LanceDB) are derived; the `.md` files are authoritative. Full architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## MCP tools at a glance

| Tool | What it does |
|---|---|
| `memory_write` | Record a decision, observation, learning, todo, entity, or question. Use proactively. |
| `memory_read` | Fetch one memory by id. |
| `memory_search` | Search the vault (`mode: "fts" \| "semantic" \| "hybrid"`, default `hybrid`). |
| `memory_promote` | Manually graduate a memory from inbox to canonical (the daemon does this automatically after 24h). |
| `memory_context` | Load curated project context within a token budget; pass `query` for semantic-led ranking. |

## CLI

| Command | Use |
|---|---|
| `vault-mem-mcp init` | Materialize a fresh vault from the bundled template. |
| `vault-mem-mcp doctor` | Health check (9 invariants). |
| `vault-mem-mcp reindex [--fts-only \| --semantic-only]` | Drop + rebuild indexes from `.md` files. |
| `vault-mem-mcp tail-audit [-n N] [--follow]` | Tail the audit log. |
| `vault-mem-mcp serve` (default) | Run the MCP server over stdio. |
| `python -m vault_mem_keeper run [--dry-run]` | Run a keeper pass (also via launchd). |
| `python -m vault_mem_keeper {status,doctor}` | Inspect keeper state. |

## Memory types

`decision` · `observation` · `learning` · `todo` · `entity` · `question` · `summary`

Each has typed frontmatter (validated against JSON Schema), markdown body, and decay policy (configurable in `_system/config.yaml`). Reference: [docs/CONFIG.md](docs/CONFIG.md).

## Status

**0.1.0** — first public release. 106 TypeScript tests + 46 Python tests, all passing. macOS-tested. Linux should work for the MCP server and the keeper script (the launchd plist is macOS-only — Linux/systemd unit files welcome as PRs). Windows untested.

**What's next:** Phase 4 (Telegram approval gate for destructive ops) and Phase 5 (Sonnet-powered contradiction detection + summarization) are on the PRD roadmap. See [docs/origin/personal-use-prd.md](docs/origin/personal-use-prd.md) §8.

## Contributing

Bug reports, PRs, and feature requests welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — © 2026 Frozo AI.

## Origin

This project began as a one-person weekend build to solve a concrete personal problem. It shipped as a personal tool, was used solo for the weeks before this release, and is now public for anyone who wants the same thing. The original PRD (with all its personal scope and "this isn't a product" framing) is preserved in [docs/origin/](docs/origin/) for context. The release-prep history (specs and TDD plans for Phases 0–3) lives under [docs/superpowers/](docs/superpowers/) for anyone curious about how it was built.
