# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Plan of record

The **`vault-mem-PRD.md`** at the repo root (v1.0, dated 2026-05-13) is the contract. It supersedes the personal-use PRD at `docs/origin/personal-use-prd.md`, which is retained for historical context only.

Vault-mem is a **two-product play**:

- **Vault-mem (OSS, MIT)** — this repo. Local-first markdown memory layer + MCP server + keeper + skills-file exporter. **Public at `github.com/frozo-ai/frozo-vault-mem`** (note: PRD §11 wrote `github.com/ashishdhiman/vault-mem` — actual landing was under the `frozo-ai` org).
- **Vault Cloud (proprietary)** — separate repo at `/Users/ashishdhiman/WORK/Frozo-projects/frozo-vault-cloud`. Multi-tenant Postgres on Supabase, connectors (Slack/GitHub/Linear/Notion/meetings), Next.js web UI, audit log. Cloud-specific code never lands here.

**Vault-mem is the lead bet** (Risk #7, decided 2026-05-13). Frozo and kincare are at maintenance until YC S26 application submits (deadline **2026-09-30**). If asked to add scope here that pulls effort away from remaining PRD §11 milestones, flag it.

## Repository state

- **Current branch:** `main`. Recent feature branches (`feat/phase-5-llm`, `feat/eval-harness`, `feat/skill-exporter`, `feat/supersede`) are all merged.
- **Repo is PUBLIC on GitHub** (`frozo-ai/frozo-vault-mem`, MIT, since 2026-04-28). Backups via `git push` — public remote is now the canonical mirror.
- **Production user:** Ashish, generating ~5–15 memories/day across `kincare`, `vault-mem`, `frozo`, `vault-cloud` projects. Keeper runs via launchd every 30 min. **Don't break the running keeper** — this dogfood path is the YC demo.

**PRD §11 roadmap status (timeline anchored to 2026-05-13 PRD approval):**

| Week | Deliverable | Status |
|---|---|---|
| 0 | PRD approved, decisions logged | ✅ |
| 1–2 | Multi-tenant Postgres rewrite (Supabase, RLS, SSO) | ✅ in `vault-cloud` |
| 3 | OSS repo public, MIT, landing page | ✅ public; landing page status — verify |
| 3–4 | Slack connector + Haiku classifier + inbox→memory UX | ✅ verified end-to-end 2026-05-19 |
| 5 | Skills-file exporter (`vault-mem export-skill`) | ✅ supports `claude` / `cursor` / `windsurf` / `generic` |
| 6–7 | Web UI v1 (Next.js + shadcn/ui): list, detail, search, manual write, connector config | ✅ in `vault-cloud/packages/web` |
| 8 | Eval harness CLI + gold-set scaffolding | ✅ code; gold sets scaffolded at `vault-template/evals/` (3 design-partner sets — verify seeded) |
| 8–9 | GitHub + Linear connectors | GitHub ✅ verified end-to-end 2026-05-19. Linear ✅ code exists, **not yet verified live**. |
| 9–10 | 3 design partners fully onboarded | ⏳ founder work — no code signal |
| 11 | `memory_supersede` MCP tool + conflict-detection primitives | ✅ tool + CLI variant. Conflict-resolution UI lives in `vault-cloud` — verify |
| 12 | YC S26 application + 1-min video demo | ⏳ founder work |
| +30 days | Public Vault Cloud launch | ⏳ |
| +60 days | Notion + meeting connectors GA | Notion + meeting code exists in `vault-cloud`; GA = ⏳ |
| +90 days | First paid customer renewal | ⏳ |

**Hard deadlines (still binding):**
- Public OSS announcement (Show HN, r/LocalLLaMA): **2026-08-30** (drafts already written, see commit `54ed883`)
- YC S26 application close: **2026-09-30**

**What's actually open in this repo (OSS):**
1. **DPDP/GDPR per-subject erasure cascade** (Risk #6, High severity). **Design landed** at `docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md` (all 6 open questions resolved 2026-05-19). Implementation pending: ~3.5 weeks across 5 phases (subject-index foundation → cascade → gating → Cloud parity → docs). Owed before public Vault Cloud launch.
2. **Open Q #2** (PRD §10): should the keeper auto-classify writes into buckets, or only humans/agents? Phase 5 shipped without resolving this — current behaviour is humans/agents only. Decision pending.
3. **Open Q #4** (PRD §10): pricing currency (USD vs ₹) for India tier. Founder call.
4. **Landing page** for `vault-mem.dev` (or chosen domain) — confirm exists / verify status.
5. **Eval gold-set content**: 3 design-partner Q&A sets seeded into `vault-template/evals/` — verify each has the PRD-required ≥50 questions.

**What's open in `vault-cloud` (not this repo, but adjacent):**
- Browser-triggered connector sync (currently CLI-only — every sync needs a terminal).
- Conflict-resolution UI on top of `memory_supersede`.
- Linear / Notion / meeting connectors verified end-to-end (only Slack + GitHub verified so far).
- Design partner onboarding flow.

## What Vault-Mem is (OSS core)

A **local-first** shared memory layer for any MCP-aware agent stack (Claude Code, Cursor, custom agents). Every agent write becomes a typed markdown file in a user-owned vault with enforced YAML frontmatter, providing:

- Shared memory across agents, addressable by `project` slug
- Human-readable audit trail (plain `.md` files, git-able)
- Background hygiene (dedupe, link, decay, contradiction detection, summarization)
- Telegram-gated approval for destructive ops (self-host)
- **Skills-file export**: `vault-mem export-skill <project> --target <claude|cursor|windsurf|generic>` → skill bundle other agents can consume. PRD §6.2 demo asset.

The vault itself lives at `~/vault-mem/` (outside this repo). This repo holds the **components that read/write/maintain that vault**. Cloud multi-tenancy reads/writes a Postgres-backed vault and lives in `vault-cloud`.

**Self-host parity is non-negotiable** (PRD §9 pricing principle): "OSS never gets crippled. Self-hosters get *all* core features. Cloud sells convenience, integrations, and team scale."

## Architecture: 4 components (OSS)

The system is intentionally split into 4 separately-deployable processes. Don't merge them — each has a different language/runtime by design:

1. **`vault-mem-mcp`** — MCP server (TypeScript, official MCP SDK). Local daemon, exposes `memory_read/search/write/update/link/contradict/query/recent/context` plus `memory_supersede` and skill-export tools. Localhost-only by default; bearer token if exposed via Tailscale.
2. **`vault-mem-keeper`** — Hygiene daemon (Python + `uv`). Runs every 30 min via launchd/cron. Inbox triage, dedupe, auto-link, contradiction detection, confidence decay, summarization, TTL expiry. **LLM provider auto-selects** based on env: `OPENROUTER_API_KEY` (preferred) or `ANTHROPIC_API_KEY`. Haiku for triage/classification; Sonnet for contradiction/summary reasoning.
3. **`vault-mem-gatekeeper`** — Telegram approval gate. Bring your own Telegram bot. Required for: merging memories, marking superseded, archiving recently-touched memories, resolving contradictions.
4. **`vault-mem-index`** — Embedding index. Self-host: LanceDB + `all-MiniLM-L6-v2` (local, free). Cloud: pgvector + Voyage `voyage-3` by default, configurable per-org. Re-indexes on file change via `chokidar`; full reindex weekly.

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
- Every memory has an enforced frontmatter schema (PRD §6.1 v1 fields: `id`, `type`, `title`, `project`, `tags`, `confidence`, `created`, `updated`, `status`, `supersedes`). The `id`, `type`, `agent`, `created`, `confidence`, `sources`, `contradicts`, `supersedes`, `status` fields are load-bearing for hygiene logic — don't drop them.
- 7 memory types (buckets) with different decay TTLs: `decision` (permanent), `observation` (90d), `todo` (30d or done), `learning` (180d), `summary` (permanent, regenerated), `entity` (permanent), `question` (until resolved).
- Schemas are versioned. **Never edit historical memories' schemas in place** — write migrations.
- **CQRS guarantees** (PRD §6.1): write-latency ≤ 50ms (file write); read-your-writes via in-memory pending queue; eventual consistency to index ≤ 2s p99.

## Scope rules

The PRD §6 is the menu. Anything listed P0/P1 is green-lit — execute proactively without asking permission each time. Anything **not** in the PRD is what now requires push-back.

**Green-lit (P0/P1 from PRD §6):**
- Multi-tenancy primitives, SSO, audit log (*implementation* in `vault-cloud`, not here)
- Ingestion connectors (in `vault-cloud`)
- Web UI (in `vault-cloud`)
- Eval harness (this repo, OSS) ✅
- Skills-file exporter (this repo, OSS, P0 demo asset) ✅
- Conflict detection, supersede, confidence decay (this repo) ✅
- Entity-graph projection (P1, this repo) — open

**Still ❌ — push back and park in `vault-mem-v3-ideas.md`:**
- Mobile app (PRD §3)
- General-purpose enterprise search (Glean-equivalent) (PRD §3)
- Meeting transcription/recording product (PRD §3 — we *consume* transcripts, not produce them)
- Chat as the primary product surface (PRD §3)
- Code-search / code-memory (PRD §3)
- Multi-modal (image/audio/video) memory in v1 (PRD §3 — flagged P2)
- Real-time collaborative editing on memories (PRD §3)
- Workflow / automation engine (PRD §3)
- Cross-agent consensus, trust scores, federation
- Time-travel / belief replay queries
- Cross-org anonymized learnings (PRD §5 #15 — P2, requires consent flow)

When tempted by something on the ❌ list, the answer is no — park it.

## Tech stack constraints (PRD §7.2)

These choices are deliberate — don't substitute without a reason:

- **TypeScript** for the MCP server and skills-file exporter (native MCP SDK ecosystem)
- **Python + `uv`** for the hygiene daemon (LLM ecosystem)
- **LanceDB** for vectors in self-host (file-based, zero server)
- **`all-MiniLM-L6-v2`** for embeddings in self-host (local, free, runs on macOS host CPU)
- **Voyage `voyage-3`** as Cloud default, **OpenAI `text-embedding-3-small`** as Cloud fallback, **per-org configurable**
- **Claude Haiku 4.5** for triage/classification (PRD §6.3, P0)
- **Claude Sonnet** for contradiction/summary reasoning
- **OpenRouter** is the preferred LLM gateway in both the keeper and `vault-cloud` connectors when `OPENROUTER_API_KEY` is set — falls back to direct Anthropic SDK with `ANTHROPIC_API_KEY`. Model names auto-prefix `anthropic/` on OpenRouter.
- **Pino** (TS) / **structlog** (Py) → file-based audit log

## Operating context

- **Primary host (dogfooding):** macOS box. Reuse existing Tailscale infra; don't add new.
- **Cost ceiling:** ~$30–50/month for this repo (keeper LLM spend + eval runs). Flag anything that could exceed $100/month.
- **Backup:** daily `git push` to `frozo-ai/frozo-vault-mem` (public); weekly full backup of `~/vault-mem/` to external drive.
- **Privacy:** zero hard cloud dependency for self-host (DPDP compliance). Cloud product has its own privacy posture and lives in `vault-cloud`.
- **Telemetry:** **opt-in only** for the OSS (PRD §10 Open Q #8, decided 2026-05-13). Shipped with zero telemetry by default. Opt-in flag documented in README.
- **DPDP/GDPR per-subject erasure** (Risk #6, High severity): **still open**. Must cascade through `.md` files → embeddings → FTS → audit. Design + ship before public Vault Cloud launch.

## Running and developing

**MCP server:**
- Default mode: `node packages/mcp/bin/vault-mem-mcp` — MCP over stdio. Vault path resolves from `--vault` flag → `VAULT_MEM_PATH` env → `~/vault-mem/`.
- Bootstrap a vault: `node packages/mcp/bin/vault-mem-mcp init [--target PATH] [--git]`
- Health check: `node packages/mcp/bin/vault-mem-mcp doctor [--vault PATH]`
- Rebuild FTS index: `node packages/mcp/bin/vault-mem-mcp reindex [--vault PATH]`
- Tail audit log: `node packages/mcp/bin/vault-mem-mcp tail-audit [--vault PATH] [-n 50] [--follow]`
- Export skill bundle: `node packages/mcp/bin/vault-mem-mcp export-skill <project> --target <claude|cursor|windsurf|generic> --out <dir>`
- Supersede a memory: `node packages/mcp/bin/vault-mem-mcp supersede <old-id> <new-id>`

**Tests / lint:**
- All: `pnpm test`
- Filtered: `pnpm --filter @vault-mem/mcp test path/to/file.test.ts`
- Type check: `pnpm typecheck`
- Dev (TS without build): `pnpm --filter @vault-mem/mcp dev`

## Where things live

- `vault-mem-PRD.md` — plan of record at repo root.
- `vault-template/` — canonical scaffolding `init` copies from. Schemas, templates, sample memory, **eval gold-set scaffolds (`vault-template/evals/`)**. Edit only when adding/changing schema artifacts.
- `packages/mcp/src/` — server source, organized by responsibility (`config/`, `schema/`, `vault/`, `id/`, `audit/`, `index/`, `tools/`, `cli/`, `server/`, **`exporter/` for skill-file generation**). Tests co-located (`*.test.ts`); integration/e2e under `packages/mcp/test/`.
- `packages/keeper/src/` — Python keeper source. Phase 5 LLM modules in `llm/` (client, budget, prompts, OpenRouter provider).
- `_system/index.sqlite` (inside any materialized vault) — gitignored. Always rebuildable via `reindex`. The `.md` files are the source of truth.
- **Not in this repo (vault-cloud):** connectors, Next.js UI, Supabase migrations, multi-tenant Postgres schema.

## Keeper (Python daemon)

- Run a keeper pass: `cd packages/keeper && uv run python -m vault_mem_keeper run --vault ~/vault-mem`
- Dry-run: `… --dry-run`
- Status: `… status --vault ~/vault-mem`
- Health check: `… doctor --vault ~/vault-mem`
- Tests: `cd packages/keeper && uv run pytest`
- Lint: `cd packages/keeper && uv run ruff check src tests`
- Schedule via launchd: see `packages/keeper/README.md` and `ops/keeper/com.vaultmem.keeper.plist` (env-file variant available for secret hygiene).

## Open questions (PRD §10) — resolution status

| # | Question | Status | Notes |
|---|---|---|---|
| 1 | Embedding model: Voyage `voyage-3` vs OpenAI `text-embedding-3-small` as Cloud default | ⏳ open | Per-org override decided. Default still TBD before Cloud beta. |
| 2 | Keeper auto-classify writes into buckets, or only humans/agents? | ⏳ open | Phase 5 shipped without resolving; current behaviour is humans/agents only. |
| 3 | Brand name: keep "vault-mem" or rename before public launch? | ✅ resolved | Kept "vault-mem"; landed at `frozo-ai/frozo-vault-mem` (org-scoped vs personal). |
| 4 | Pricing currency: USD primary or ₹ primary for India tier? | ⏳ open | Founder call, pre-launch. |
| 5 | Exporter targets: Claude/Cursor/Windsurf only, or also OpenAI/generic? | ✅ resolved | Shipped all four: `claude`, `cursor`, `windsurf`, `generic`. |
| 6 | DPDP/GDPR erasure cascade design (Risk #6) | 🟡 design resolved | Spec at `docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md`. Implementation still pending (~3.5w). |
| 7 | (covered in CLAUDE.md — vault-mem as lead bet) | ✅ resolved | Decided 2026-05-13. |
| 8 | Telemetry default — opt-in vs opt-out for OSS | ✅ resolved | Opt-in only, zero telemetry by default. |

## gstack

Use the `/browse` skill from gstack for all web browsing.

Available gstack skills:
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /document-generate, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn

Install gstack locally: `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` (requires bun).
