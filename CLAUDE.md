# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Plan of record

The **`vault-mem-PRD.md`** at the repo root (v1.0, dated 2026-05-13) is the contract. It supersedes the personal-use PRD at `docs/origin/personal-use-prd.md`, which is retained for historical context only.

Vault-mem is now a **two-product play**:

- **Vault-mem (OSS, MIT)** — this repo. Local-first markdown memory layer + MCP server + keeper + skills-file exporter.
- **Vault Cloud (proprietary)** — separate private repo (`vault-cloud`, to be created). Multi-tenant Postgres, connectors (Slack/GitHub/Linear/Notion/meetings), web UI, audit log, SSO.

**This repo will be renamed and pushed public to `github.com/ashishdhiman/vault-mem` in PRD week 3 (target ~2026-06-03).** Until then it stays private. Cloud-specific code never lands here — it goes in `vault-cloud`.

**Vault-mem is the lead bet** (Risk #7, decided 2026-05-13). Frozo and kincare drop to maintenance until YC S26 application submits (deadline 2026-09-30). If you're asked to add scope here that pulls effort away from PRD §11 milestones, flag it.

## Repository state

- **Current branch:** `feat/phase-5-llm` (Phase 5 LLM keeper — contradict + summarize).
- **Immediate path:** Finish Phase 5 → merge to `main` → start PRD work in week order.
- **OSS roadmap from this repo** (PRD §11):
  - Week 3 — go public, MIT, landing page
  - Week 5 — skills-file exporter (`vault-mem export-skill`) as headline demo asset
  - Week 8 — eval harness CLI + gold-set scaffolding
  - Week 11 — `memory.supersede` flow + conflict-detection primitives (UI lives in vault-cloud)
- **Cloud work happens in `vault-cloud` (separate repo).** Not in scope for this repo: multi-tenant Postgres, Supabase auth, connectors, Next.js UI.

The repo holds:

- `vault-mem-PRD.md` — plan of record. Read before any substantive work.
- `vault-template/` — bundled scaffolding the `init` CLI copies to a working vault
- `packages/mcp/` — the `@vault-mem/mcp` workspace package (Node 20 + TypeScript ESM)
- `packages/keeper/` — the Python `uv`-managed hygiene daemon (Phase 3+)
- `docs/origin/personal-use-prd.md` — origin PRD, historical only
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design and implementation history

See "Running and developing" below for build/test/run commands.

## What Vault-Mem is (OSS core)

A **local-first** shared memory layer for any MCP-aware agent stack (Claude Code, Cursor, custom agents). Every agent write becomes a typed markdown file in a user-owned vault with enforced YAML frontmatter, providing:

- Shared memory across agents, addressable by `project` slug
- Human-readable audit trail (plain `.md` files, git-able)
- Background hygiene (dedupe, link, decay, contradiction detection, summarization)
- Telegram-gated approval for destructive ops (self-host)
- **Skills-file export**: `vault-mem export-skill <project>` → Claude/Cursor/Windsurf skill bundle (P0 from PRD §6.2 — the demo asset)

The vault itself lives at `~/vault-mem/` (outside this repo). This repo holds the **components that read/write/maintain that vault**. Cloud multi-tenancy reads/writes a Postgres-backed vault and lives in `vault-cloud`.

**Self-host parity is non-negotiable** (PRD §9 pricing principle): "OSS never gets crippled. Self-hosters get *all* core features. Cloud sells convenience, integrations, and team scale."

## Architecture: 4 components (OSS)

The system is intentionally split into 4 separately-deployable processes. Don't merge them — each has a different language/runtime by design:

1. **`vault-mem-mcp`** — MCP server (TypeScript, official MCP SDK). Local daemon, exposes `memory_read/search/write/update/link/contradict/query/recent/context` tools, plus new P0 tools `memory_supersede` and `memory_export_skill`. Localhost-only by default; bearer token if exposed via Tailscale.
2. **`vault-mem-keeper`** — Hygiene daemon (Python + `uv`). Runs every 30 min via launchd/cron in self-host. Inbox triage, dedupe, auto-link, contradiction detection, confidence decay, summarization, TTL expiry. Uses Claude Haiku for cheap reasoning, Sonnet for contradiction/summarization.
3. **`vault-mem-gatekeeper`** — Telegram approval gate. Bring your own Telegram bot. Required for: merging memories, marking superseded, archiving recently-touched memories, resolving contradictions.
4. **`vault-mem-index`** — Embedding index. Self-host: LanceDB + `all-MiniLM-L6-v2` (local, free). Cloud: pgvector + Voyage `voyage-3` by default, configurable per-org (Enterprise can override). Re-indexes on file change via `chokidar`; full reindex weekly.

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
- Every memory has an enforced frontmatter schema (see PRD §6.1 for v1 fields: `id`, `type`, `title`, `project`, `tags`, `confidence`, `created`, `updated`, `status`, `supersedes`). The `id`, `type`, `agent`, `created`, `confidence`, `sources`, `contradicts`, `supersedes`, `status` fields are load-bearing for hygiene logic — don't drop them.
- 7 memory types (buckets) with different decay TTLs: `decision` (permanent), `observation` (90d), `todo` (30d or done), `learning` (180d), `summary` (permanent, regenerated), `entity` (permanent), `question` (until resolved).
- Schemas are versioned. **Never edit historical memories' schemas in place** — write migrations.
- **CQRS guarantees** (PRD §6.1): write-latency ≤ 50ms (file write); read-your-writes via in-memory pending queue; eventual consistency to index ≤ 2s p99.

## Scope rules (inverted from the old personal-use rules)

The PRD §6 is the menu. Anything listed P0/P1 is green-lit — execute proactively without asking permission each time. Anything **not** in the PRD is what now requires push-back.

**Green-lit (P0/P1 from PRD §6):**
- Multi-tenancy primitives, SSO, audit log (but the *implementation* lives in `vault-cloud`, not here)
- Ingestion connectors (in `vault-cloud`)
- Web UI (in `vault-cloud`)
- Eval harness (this repo, OSS)
- Skills-file exporter (this repo, OSS, P0 demo asset)
- Conflict detection, supersede, confidence decay (this repo)
- Entity-graph projection (P1, this repo)

**Still ❌ — push back and park in `vault-mem-v3-ideas.md`:**
- Mobile app (PRD §3)
- General-purpose enterprise search (Glean-equivalent) (PRD §3)
- Meeting transcription/recording product (PRD §3)
- Chat as the primary product surface (PRD §3)
- Code-search / code-memory (PRD §3)
- Multi-modal (image/audio/video) memory in v1 (PRD §3 — flagged P2)
- Real-time collaborative editing on memories (PRD §3)
- Workflow / automation engine (PRD §3)
- Cross-agent consensus, trust scores, federation
- Time-travel / belief replay queries
- Cross-org anonymized learnings (PRD §5 #15 — P2, requires consent flow)

When tempted by something on the ❌ list, the answer is no — park it. The old `vault-mem-v2-ideas.md` parking lot is retired (most of v2 is now the PRD).

## Build phases (PRD §11 timeline)

Phases must ship in order. The week numbers below are relative to PRD approval (2026-05-13).

**Done / in progress:**
- Phase 0 — vault scaffolding (done)
- Phase 1 — MCP server v0.1 read/write/search (done)
- Phase 2 — LanceDB embedding + semantic search (done)
- Phase 3 — Hygiene daemon v0.1 (done, running in production since 2026-04-28)
- Phase 4 — Telegram gatekeeper (done)
- **Phase 5 — Sonnet contradiction + rollup summaries (IN PROGRESS, `feat/phase-5-llm`)**

**Next in this repo:**
- Phase 5 finish + merge to main
- Week 3 — repo public, landing page, MIT license
- Week 5 — skills-file exporter
- Week 8 — eval harness + 3 design-partner gold sets
- Week 11 — supersede flow + conflict detection primitives

**Cost ceiling note:** old CLAUDE.md said ~$10/month for Phase 5. With the eval harness and design-partner brains, expect $30–50/month for this repo's LLM spend during the run-up to YC. Flag anything that could blow past $100/month.

## Tech stack constraints (PRD §7.2)

These choices are deliberate — don't substitute without a reason:

- **TypeScript** for the MCP server and skills-file exporter (native MCP SDK ecosystem)
- **Python + `uv`** for the hygiene daemon (LLM ecosystem)
- **LanceDB** for vectors in self-host (file-based, zero server)
- **`all-MiniLM-L6-v2`** for embeddings in self-host (local, free, runs on macOS host CPU)
- **Voyage `voyage-3`** as Cloud default, **OpenAI `text-embedding-3-small`** as Cloud fallback, **per-org configurable** (Enterprise can override)
- **Claude Haiku 4.5** for triage/classification and Slack-to-decision classifier (PRD §6.3, P0)
- **Claude Sonnet** for contradiction/summary reasoning
- **Pino** (TS) / **structlog** (Py) → file-based audit log

## Operating context

- **Primary host (dogfooding):** macOS box. Reuse existing Tailscale infra; don't add new.
- **Production user (today):** Ashish, generating ~5–15 memories/day across `kincare`, `vault-mem`, `frozo` projects since 2026-04-28. This dogfooding is the YC demo — don't break the running keeper.
- **Cost ceiling:** ~$30–50/month for this repo (Phase 5 + eval harness). Flag anything that could exceed $100/month.
- **Backup:** daily git commit + push to private GitHub (until week 3, then public); weekly full backup to external drive.
- **Privacy:** zero hard cloud dependency for self-host (DPDP compliance is a stated goal). The Cloud product has its own privacy posture and lives in `vault-cloud`.
- **Telemetry:** **opt-in only** for the OSS (PRD §10 Open Q #8, decided 2026-05-13). Ship with zero telemetry by default. Document the opt-in flag in README on day 1 of public launch.
- **DPDP/GDPR per-subject erasure** (Risk #6, High severity): design the erasure pipeline as part of Phase 5 / week-1 work, not week 12. Erasure must cascade through embeddings, FTS index, and any caches.

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

- `vault-mem-PRD.md` — root of repo. Plan of record.
- `vault-template/` — the canonical scaffolding `init` copies from. Schemas, templates, and the sample memory live here. Edit only when adding/changing schema artifacts.
- `packages/mcp/src/` — server source, organized by responsibility (`config/`, `schema/`, `vault/`, `id/`, `audit/`, `index/`, `tools/`, `cli/`, `server/`). Tests are co-located (`*.test.ts`) for unit work; integration and e2e tests live under `packages/mcp/test/`.
- `packages/keeper/src/` — Python keeper source. Phase 5 LLM modules in `llm/`.
- `_system/index.sqlite` (inside any materialized vault) — gitignored. Always rebuildable via `reindex`. The `.md` files are the source of truth.
- **Future (this repo):** `packages/skill-exporter/` for the skills-file exporter (week 5), `evals/` directory for gold-set Q&A pairs (week 8).
- **Not in this repo (vault-cloud):** connectors, Next.js UI, Supabase migrations, multi-tenant Postgres schema.

## Keeper (Python daemon, Phase 3+)

- **Run a keeper pass:** `cd packages/keeper && uv run python -m vault_mem_keeper run --vault ~/vault-mem`
- **Dry-run:** `… --dry-run`
- **Status (last keeper_run summary):** `… status --vault ~/vault-mem`
- **Health check:** `… doctor --vault ~/vault-mem`
- **Tests:** `cd packages/keeper && uv run pytest`
- **Lint:** `cd packages/keeper && uv run ruff check src tests`
- **Schedule via launchd:** see `packages/keeper/README.md` and `ops/keeper/com.vaultmem.keeper.plist`.

## Still-open questions (PRD §10)

These are blocking or near-blocking and need an answer before the relevant phase ships. Surface them when work bumps into them:

| # | Question | When it bites | Owner |
|---|---|---|---|
| 1 | Embedding model: Voyage `voyage-3` vs OpenAI `text-embedding-3-small` as Cloud default (per-org override already decided) | Before Cloud beta | Eng — week 4 |
| 2 | Should keeper auto-classify writes into buckets, or only humans/agents? | Phase 5 finish | PM — week 4 |
| 3 | Brand name: keep "vault-mem", or rename before public launch? | Before week 3 | Founder |
| 4 | Pricing currency: USD primary or ₹ primary for India tier? | Pre-launch | Founder — week 6 |
| 5 | Skills-file exporter: support OpenAI assistants / generic JSON, or Claude/Cursor/Windsurf only at v1? | Week 5 | PM — week 3 |
| 6 | DPDP/GDPR erasure cascade design (Risk #6) | NOW — before Phase 5 ships | Eng |
