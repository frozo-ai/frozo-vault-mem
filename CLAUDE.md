# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo currently contains **only `vault-mem-prd.md`** — there is no code, no build system, no tests yet. Phase 0 (folder scaffolding + JSON schemas) has not started. Treat the PRD as the contract: read it before proposing any structural decisions.

When code lands, this file should be updated with the actual build/test/run commands for each component.

## What Vault-Mem is

A **personal-use, local-first** shared memory layer for the owner's agent stack (Claude Code, Cursor, Frozo Founder OS). Every agent write becomes a typed markdown file in an Obsidian vault with enforced YAML frontmatter, providing:

- Shared memory across agents
- Human-readable audit trail (plain `.md` files, git-tracked)
- Background hygiene (dedupe, link, decay, contradiction detection)
- Telegram-gated approval for destructive ops

The vault itself lives at `~/vault-mem/` (outside this repo). This repo holds the **components that read/write/maintain that vault**.

## Architecture: 4 components

The system is intentionally split into 4 separately-deployable processes. Don't merge them — each has a different language/runtime by design:

1. **`vault-mem-mcp`** — MCP server (TypeScript, official MCP SDK). Local daemon on port 3947, exposes `memory.read/search/write/update/link/contradict/query/recent/context` tools. Localhost-only by default; bearer token if exposed via Tailscale.
2. **`vault-mem-keeper`** — Hygiene daemon (Python + `uv`). Runs every 30 min via launchd/cron. Inbox triage, dedupe, auto-link, contradiction detection, confidence decay, summarization, TTL expiry. Uses Claude Haiku for cheap reasoning, Sonnet for contradiction/summarization.
3. **`vault-mem-gatekeeper`** — Telegram approval gate. Reuses the existing Frozo Founder OS Telegram bot. Required for: merging memories, marking superseded, archiving recently-touched memories, resolving contradictions.
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
- **`all-MiniLM-L6-v2`** embeddings (local, free, fits Mac Mini CPU)
- **Claude Haiku** for triage/classification, **Claude Sonnet** for contradiction/summary reasoning
- **pm2** for process management (already running on the Mac Mini)
- **Pino** (TS) / **structlog** (Py) → file-based audit log

## Operating context

- **Primary host:** owner's Mac Mini (already running pm2, Tailscale, Frozo Founder OS Telegram bot — reuse, don't reinstall)
- **Cost ceiling:** API spend should stay ~₹500–1,000/month at ~50 agent writes/day. Anything that could blow this needs a flag.
- **Backup:** daily git commit + push to private GitHub; weekly full backup to external drive.
- **Privacy:** zero cloud dependency by default (DPDP compliance is a stated goal). Don't introduce hosted services without an explicit ask.

## Things to do early when code lands

When the first phase of code is added, this file should grow sections for:

- How to run the MCP server locally and point Claude Code at it
- How to run the hygiene daemon manually for one-shot testing (vs. the launchd loop)
- Schema validation command (single source of truth for "is this memory file well-formed?")
- How to rebuild the LanceDB index from scratch
