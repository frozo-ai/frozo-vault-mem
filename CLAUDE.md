# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Phase 0 (vault scaffolding) and Phase 1 (MCP server v0.1) are implemented on `feat/phase-1-mcp` and ready to merge to main. The repo holds:

- `vault-template/` — bundled scaffolding the `init` CLI copies to a working vault
- `packages/mcp/` — the `@vault-mem/mcp` workspace package (Node 20 + TypeScript ESM)
- `docs/origin/personal-use-prd.md` — origin PRD (treat as contract)
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design and implementation history

See "Running and developing" below for build/test/run commands.

## What Vault-Mem is

A **personal-use, local-first** shared memory layer for any MCP-aware agent stack (Claude Code, Cursor, custom agents). Every agent write becomes a typed markdown file in an Obsidian vault with enforced YAML frontmatter, providing:

- Shared memory across agents
- Human-readable audit trail (plain `.md` files, git-tracked)
- Background hygiene (dedupe, link, decay, contradiction detection)
- Telegram-gated approval for destructive ops

The vault itself lives at `~/vault-mem/` (outside this repo). This repo holds the **components that read/write/maintain that vault**.

## Architecture: 4 components

The system is intentionally split into 4 separately-deployable processes. Don't merge them — each has a different language/runtime by design:

1. **`vault-mem-mcp`** — MCP server (TypeScript, official MCP SDK). Local daemon on port 3947, exposes `memory.read/search/write/update/link/contradict/query/recent/context` tools. Localhost-only by default; bearer token if exposed via Tailscale.
2. **`vault-mem-keeper`** — Hygiene daemon (Python + `uv`). Runs every 30 min via launchd/cron. Inbox triage, dedupe, auto-link, contradiction detection, confidence decay, summarization, TTL expiry. Uses Claude Haiku for cheap reasoning, Sonnet for contradiction/summarization.
3. **`vault-mem-gatekeeper`** — Telegram approval gate. Bring your own Telegram bot. Required for: merging memories, marking superseded, archiving recently-touched memories, resolving contradictions.
4. **`vault-mem-index`** — Embedding index (LanceDB, file-based). Embeds with `all-MiniLM-L6-v2` via `sentence-transformers`. Re-indexes on file change via `chokidar`; full reindex weekly.

## Vault structure (the data model is the architecture)

```
~/vault-mem/
├── memory/{decisions,observations,todos,learnings,summaries,entities,questions}/
├── projects/   # human-curated
├── inbox/      # ALL agent writes land here first
├── archive/    # decayed/superseded
└── _system/{schema/, templates/, audit.log, config.yaml}
```

**Key invariants:**
- Agents write to `inbox/` only. The hygiene daemon promotes to canonical folders after triage.
- Every memory has an enforced frontmatter schema (see PRD §4 for the v0.1 fields). The `id`, `type`, `agent`, `created`, `confidence`, `sources`, `contradicts`, `supersedes`, `status` fields are load-bearing for hygiene logic — don't drop them.
- 7 memory types with different decay TTLs: `decision` (permanent), `observation` (90d), `todo` (30d or done), `learning` (180d), `summary` (permanent, regenerated), `entity` (permanent), `question` (until resolved).
- Schemas are versioned. **Never edit historical memories' schemas in place** — write migrations.

## Hard scope rules (from PRD §2 and §11)

The PRD is explicit about non-goals. Before adding anything that smells like the following, push back and confirm with the owner:

- ❌ Multi-user / collaboration features
- ❌ Hosted SaaS or cloud sync
- ❌ Mobile app or pretty UI beyond Obsidian + Telegram
- ❌ Cross-agent consensus, trust scores, federation
- ❌ Time-travel / belief replay queries
- ❌ Memory inbox triage UI (CLI + Telegram is enough)
- ❌ Compartmentalized vaults (single vault for v1.0; filter by `project:` frontmatter)

If tempted, the answer is no — park it in a `vault-mem-v2-ideas.md` doc and leave it there for 90 days.

## Build phases (PRD §8)

Phases must ship in order. Don't skip ahead — each phase has a concrete "done when" gate:

0. Folder structure + JSON schemas + manual memory creation validates
1. MCP server v0.1 — `read/write/search` (FTS only) usable from Claude Code
2. LanceDB embedding index + semantic `search` + `context(project)`
3. Hygiene daemon v0.1 — inbox triage, auto-link, confidence decay
4. Telegram approval gate
5. Sonnet contradiction engine + rollup summaries
6. Polish: Dataview dashboards, optional Obsidian plugin, perf

## Tech stack constraints (PRD §7)

These choices are deliberate — don't substitute without a reason:

- **TypeScript** for the MCP server (native MCP SDK ecosystem)
- **Python + `uv`** for the hygiene daemon (LLM ecosystem)
- **LanceDB** for vectors (file-based, zero server)
- **`all-MiniLM-L6-v2`** embeddings (local, free, fits macOS host CPU)
- **Claude Haiku** for triage/classification, **Claude Sonnet** for contradiction/summary reasoning
- **pm2** for process management if you already use it; alternative to launchd
- **Pino** (TS) / **structlog** (Py) → file-based audit log

## Operating context

- **Primary host:** your Mac/Linux box (macOS host running Tailscale; reuse existing infra, don't add new)
- **Cost ceiling:** API spend should stay low (~$10/month at ~50 agent writes/day with Phase 5 enabled; near-zero without). Anything that could blow this needs a flag.
- **Backup:** daily git commit + push to private GitHub; weekly full backup to external drive.
- **Privacy:** zero cloud dependency by default (DPDP compliance is a stated goal). Don't introduce hosted services without an explicit ask.

## Running and developing

- **Server (default mode):** `node packages/mcp/bin/vault-mem-mcp` — runs MCP over stdio. Vault path resolves from `--vault` flag → `VAULT_MEM_PATH` env → `~/vault-mem/`.
- **Bootstrap a vault:** `node packages/mcp/bin/vault-mem-mcp init [--target PATH] [--git]`
- **Health check:** `node packages/mcp/bin/vault-mem-mcp doctor [--vault PATH]`
- **Rebuild FTS index:** `node packages/mcp/bin/vault-mem-mcp reindex [--vault PATH]`
- **Tail audit log:** `node packages/mcp/bin/vault-mem-mcp tail-audit [--vault PATH] [-n 50] [--follow]`
- **Tests:** `pnpm test` (root) or `pnpm --filter @vault-mem/mcp test`
- **Single test file:** `pnpm --filter @vault-mem/mcp test path/to/file.test.ts`
- **Type check:** `pnpm typecheck`
- **Dev (TS without build):** `pnpm --filter @vault-mem/mcp dev`

## Where things live

- `vault-template/` — the canonical scaffolding `init` copies from. Schemas, templates, and the sample memory live here. Edit only when adding/changing schema artifacts.
- `packages/mcp/src/` — server source, organized by responsibility (`config/`, `schema/`, `vault/`, `id/`, `audit/`, `index/`, `tools/`, `cli/`, `server/`). Tests are co-located (`*.test.ts`) for unit work; integration and e2e tests live under `packages/mcp/test/`.
- `_system/index.sqlite` (inside any materialized vault) — gitignored. Always rebuildable via `reindex`. The `.md` files are the source of truth.

## Keeper (Python daemon, Phase 3)

- **Run a keeper pass:** `cd packages/keeper && uv run python -m vault_mem_keeper run --vault ~/vault-mem`
- **Dry-run:** `… --dry-run`
- **Status (last keeper_run summary):** `… status --vault ~/vault-mem`
- **Health check:** `… doctor --vault ~/vault-mem`
- **Tests:** `cd packages/keeper && uv run pytest`
- **Lint:** `cd packages/keeper && uv run ruff check src tests`
- **Schedule via launchd:** see `packages/keeper/README.md` and `ops/keeper/com.vaultmem.keeper.plist`.
