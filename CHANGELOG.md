# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Skills-file exporter (PRD §6.2, week 5 — headline demo asset)

- **`vault-mem-mcp export-skill <project>`** CLI subcommand. Reads a vault's
  memories filtered by project, bundles them target-agnostically, then writes
  per-target output files:
  - `--target=claude` (default): `SKILL.md` with YAML frontmatter (name +
    description) + `description.yaml` manifest + `references/{decisions,
    learnings, observations, entities, questions, todos, summaries}.md`.
  - `--target=cursor`: single `.cursor/rules/vault-mem-<project>.mdc` with
    `alwaysApply: true` frontmatter.
  - `--target=windsurf`: single `.windsurfrules` (plain markdown, no frontmatter).
  - `--target=generic`: `README.md` + machine-readable `manifest.json` +
    per-bucket markdown files. Designed for OpenAI assistants / custom agents.
- Deterministic sort within each bucket (`created DESC, id ASC`) so re-runs
  produce byte-identical `references/*` output (only the `generatedAt`
  timestamp in `SKILL.md` / `description.yaml` differs run-to-run).
- `--include-inbox` flag opts into inbox memories (default: canonical only).
- `--max-bytes-per-bucket` caps wildly-large vaults so a single bucket can't
  blow up the bundle. Items beyond the cap are dropped whole (no mid-content
  truncation) to keep what remains self-consistent.
- Atomic writes (temp+rename) for every output file.
- 16 vitest cases covering bucket sort, project isolation, inbox toggle,
  byte-cap, per-target output shape, manifest schema, and invalid-target
  rejection. Live-dogfooded against `~/vault-mem/` on 2026-05-13.

### Added — Phase 5 (Sonnet contradiction engine + summarization)

- **Contradiction detection** (`ops/contradict`): pairwise Haiku pre-filter +
  Sonnet judge across canonical memories whose `updated` advanced since the last
  pass. High/medium-severity contradictions land in `_system/proposals.jsonl`.
- **Per-project summaries** (`ops/summarize`): daily / weekly / monthly rollups
  gated by both time and a new-memory threshold. Outputs a typed `summary`
  memory under `memory/summaries/` with a `covers: [<ids>]` list.
- **Interactive proposal walker** (`keeper review`): accept / reject / skip /
  view / notes / quit on each pending proposal. Accept on `supersede_M_with_N`
  archives the loser, sets its `status: superseded`, and appends to the winner's
  `supersedes` list.
- **Cost tracking** (`llm/budget`): per-call USD accounting in
  `_system/budget.jsonl`, configurable monthly soft cap (`keeper.budget.monthly_usd_cap`,
  default `$5.00`). Subsequent calls short-circuit when the cap is reached.
- **Keeper state** (`_system/state.json`): tracks `last_contradict_at` and
  per-project / per-period `summaries.{project}.{period}` watermarks so re-runs
  stay incremental.
- **New audit ops**: `contradict_scan`, `summarize`, `budget_exceeded`,
  `proposal_applied`, `proposal_rejected`, `proposal_note`, `proposal_apply_failed`.
- **`keeper_run` audit summary** now surfaces `pending_proposals` and
  `budget_mtd_usd` for at-a-glance status.

### Fixed

- `state.read_state()` no longer returns a shared mutable reference to the
  default `summaries` dict.

### Changed

- **LLM provider auto-selection**: keeper now picks between OpenRouter
  (`OPENROUTER_API_KEY`, OpenAI-compatible `/chat/completions`) and the
  native Anthropic SDK (`ANTHROPIC_API_KEY`, `/v1/messages`) based on
  which env var is set. OpenRouter takes priority when both are present.
  Bare model names (e.g. `claude-haiku-4-5`) auto-prefix to
  `anthropic/claude-haiku-4-5` for OpenRouter. The `LlmClient` protocol
  is the new duck-typed surface that `ops/contradict` + `ops/summarize`
  depend on.

## [0.1.0] - 2026-04-28

First public release. Originally built as a personal-use weekend project; now released for anyone who wants a local-first shared memory layer for their AI agents. The original PRD is preserved in `docs/origin/`.

### Added

#### MCP server (`packages/mcp/`)

- 5 MCP tools: `memory_write`, `memory_read`, `memory_search`, `memory_promote`, `memory_context`.
- 4 CLI subcommands: `init`, `doctor`, `reindex`, `tail-audit`.
- SQLite FTS5 keyword index with chokidar-driven reconciliation.
- LanceDB vector index via `@xenova/transformers` (ONNX-quantized MiniLM, 384-dim).
- Hybrid search via Reciprocal Rank Fusion (default mode for `memory_search`).
- JSONL audit log with SHA-256-hashed search queries.
- Atomic writes via temp+fsync+rename; per-file advisory locks via `proper-lockfile`.
- Stdio transport (no network surface).
- Vault scaffolding for 7 memory types: `decision`, `observation`, `todo`, `learning`, `summary`, `entity`, `question`.
- JSON Schema (draft-07) frontmatter validation with `additivity-only` upgrade policy.

#### Hygiene daemon (`packages/keeper/`, Python 3.12+)

- Stateless `python -m vault_mem_keeper run` invocation; scheduled every 30 min via macOS `launchd`.
- 4 ops in deterministic order: triage → link → decay → archive.
- Inbox triage with configurable age and confidence gates; immediate promote on `human_reviewed: true`.
- Auto-link top-K semantic neighbors to `_system/links.jsonl`.
- Per-type confidence decay with `last_decay_at` boundary tracking.
- TTL and low-confidence archive.
- `--dry-run` flag; `status` and `doctor` subcommands.
- launchd plist template at `ops/keeper/com.vaultmem.keeper.plist`; pm2 wrapper at `packages/keeper/bin/run-keeper.sh`.
- pydantic-validated `keeper:` config section in vault `_system/config.yaml`.
- Audit entries with `agent: "keeper"` mixed into the same JSONL log as MCP server entries.

#### Infrastructure

- Monorepo with pnpm workspace (`packages/mcp/`) and Python `uv` workspace (`packages/keeper/`).
- 106 TypeScript tests (Vitest) + 46 Python tests (pytest) all passing.
- TypeScript: strict ESM, NodeNext, `noUncheckedIndexedAccess`, declaration maps.
- Ruff lint (Python).
- Vault template (committed scaffolding) with bundled JSON Schemas, markdown templates, sample memory, config example.
- `vault-mem-mcp init` materializes a working vault; `vault-mem-mcp doctor` runs 9 health checks.

### Notes for adopters

- Tool names use **underscores** (`memory_write`, etc.) per the MCP specification's `^[a-zA-Z0-9_-]{1,64}$` constraint. Earlier internal designs used dots — these were renamed before public release.
- Schema changes from this release forward are **additive-only** (new optional fields). Renames or breaking changes require a versioned migration before they may ship.
- macOS-tested. Linux should work for the MCP server and the keeper as a script (the launchd plist is macOS-only — Linux/systemd unit files welcome as PRs).
- Telegram approval gate (Phase 4) and Sonnet-powered contradiction detection / summarization (Phase 5) are on the roadmap. See `docs/origin/personal-use-prd.md` §8.

[Unreleased]: https://github.com/frozo-ai/frozo-vault-mem/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/frozo-ai/frozo-vault-mem/releases/tag/v0.1.0
