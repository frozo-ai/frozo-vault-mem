# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — DPDP / GDPR per-subject erasure cascade

Complete pipeline for fulfilling right-to-erasure requests against the
vault. Design landed first (`docs/superpowers/specs/2026-05-19-dpdp-
erasure-cascade-design.md`), then five implementation commits across
the OSS keeper + MCP server. Cloud parity (in the separate `vault-cloud`
repo) is a follow-up.

**Subject-mention index (Phase 1):**
- New SQLite store at `_system/subjects.sqlite` mapping `subject_id →
  memory_id[]` so the cascade can look up affected memories in O(1)
  rather than scanning the vault on every request.
- New keeper module `subject_index.py` + extractor that recognizes
  canonical subject ids (`email:`, `slack:`, `github:`, `linear:`,
  `notion:`, `local:`) in `tags` + `sources` frontmatter fields.
  Case-insensitive on the prefix label; email and github values
  canonicalized to lowercase.
- `vault-mem-keeper reindex-subjects [--dry-run]` CLI subcommand for
  one-shot backfill of legacy vaults that predate this work.

**Cascade + verifier (Phase 2):**
- `vault-mem-keeper erase-subject <subject-id> --reason "..."
  [--dry-run] [--no-confirm]` — hard-delete cascade per spec §4. Routes
  per-memory by mention kind: `primary_subject` → full delete (move .md
  to `archive/erased/<id>.md` with a redacted stub carrying only
  hashed forensic metadata); `tag` / `source_author` → scrub (filter
  subject from `tags` + `sources` arrays, rewrite in place);
  `body_match` → manual review required.
- Direct FTS + LanceDB row deletion for full-deleted memories
  (`fts.delete_by_ids`, `lance.delete_by_ids` — module-level escape
  hatches from the previously read-only invariants, documented
  accordingly).
- Per-cascade audit emission: `subject_erased` per memory +
  `subject_erased_complete` summary, all using SHA-256 hashes of
  `subject_id` and `reason`. Plaintext lives in controller-private
  `_system/erasure_requests.jsonl` only.
- `vault-mem-keeper audit-subject <subject-id> [--json]` — verifier
  per spec §5. Exit codes: `0` clean / `1` structured_leak (cascade
  bug) / `2` needs_human_review (prose mentions) / `3` index_drift
  (FTS/Lance row still references an archived memory; run
  `vault-mem-mcp reindex`).

**Read-path filter (Phase 2 TS):**
- `memory_search` and the underlying FTS + Lance handles now hide
  `status: 'erased'` memories by default. Pass `status: 'erased'`
  explicitly for forensic inspection. Archived and superseded memories
  remain visible (existing behaviour).
- AuditEntry union widened with six new op types
  (`subject_index_build`, `subject_mention_added`,
  `subject_mention_removed`, `subject_erase_requested`,
  `subject_erased`, `subject_erased_complete`,
  `manual_redaction_required`) so `tail-audit` renders them cleanly.

**Agent-callable approval flow (Phase 3):**
- **New MCP tool `memory_erase_subject(subject_id, reason)`**.
  Validates input, writes a `subject_erase_request` proposal to
  `_system/proposals.jsonl`, returns `{status: "pending_approval",
  proposal_id, subject_id_hash, instructions}`. **Never executes the
  cascade directly** — that's the design.
- `vault-mem-keeper review` extended to dispatch by proposal kind:
  contradict proposals route to the existing supersede flow;
  `subject_erase_request` proposals show a distinct UI (subject,
  reason, requester, ⚠ UNRECOVERABLE warnings) and call
  `run_erase_subject` on accept. `--filter subject_erase_request`
  isolates erasure approvals from contradict noise.

**Operator runbook + privacy README section:**
- `docs/runbooks/erasure-git-history.md` covers the manual
  `git filter-repo` flow for vaults backed up via `git push` (the
  cascade refuses to rewrite git history automatically; see spec §8).
- README "Privacy & DPDP / GDPR compliance" section explains the
  privacy posture: no telemetry, no cloud dependency, hashed audit log,
  end-to-end erasure pipeline, links to the public design spec.

**Test coverage:** 52 new pytest/vitest cases across the five commits.
Full suites: 161 MCP TS + 160 Python keeper, ruff + tsc clean.

### Added — Supersede flow (PRD week 11)

- **New MCP tool `memory_supersede`**: marks `loser_id` as superseded by
  `winner_id`. Sets loser status to `superseded`, moves the .md from
  `memory/<bucket>/` to `archive/`, appends `loser_id` to winner's
  `supersedes` frontmatter list. Updates both the FTS index and Lance
  metadata in-place so search reflects the new state immediately.
- **Idempotent**: re-running on an already-applied pair returns
  `already_applied: true` and touches no files. Safe to call from agents
  that may retry on transient failures.
- **Recovery-tolerant**: if loser is already in `archive/` from a prior
  partial run but winner doesn't yet list it, the tool patches just the
  winner side.
- **CLI variant**: `vault-mem-mcp supersede <winner> <loser> [--reason]`
  for manual ops and scripting.
- **New audit op**: `supersede` with `{winner_id, loser_id, loser_from,
  loser_to, reason?}`.
- **Refuses**: self-supersede, inbox-side memories (promote first),
  unknown ids, already-archived winner.
- 13 vitest cases cover happy path, idempotency, partial-state recovery,
  accumulation, lance metadata sync, audit shape, and 5 error paths.

### Added — Eval harness (PRD §6.6, week 8 — quality gate)

- **`vault-mem-mcp eval run <project>`** CLI subcommand. Loads every gold
  set under `<vault>/evals/<project>/*.json` (or one named set via
  `--set <name>`), runs each question through `memory.context`, scores
  retrieval against expected citations.
- **Gold set format**: pinned `vault-mem-eval-set/1` schema. One JSON file
  per set, with N questions each having `{id, question, expected_citations: [memId], ...}`.
  Schema lives at `vault-template/_system/schema/eval-set.json`; a sample
  set ships at `vault-template/evals/sample/smoke.json` so `init` users see
  the file shape.
- **Scoring**: per-question precision, recall, F1 against expected memory
  ids within `top_k`. A question "passes" when recall==1 (all expected
  citations surface within top_k). Aggregate metrics micro-averaged.
- **CI gate**: `--min-pass-rate` (default `0.7`, per PRD §8 target) — exits
  non-zero when fewer than 70% of questions pass. Also `--min-f1` for
  precision-aware gating; off by default.
- **Output**: stdout text by default (✓/◐/✗ per question, missing-citation
  callout, overall metrics line). `--output report.json` emits a stable
  JSON shape for CI consumption.
- **Per-question overrides**: `top_k`, `max_tokens`, `include_inbox` can be
  set in the gold set or overridden globally via CLI flags.
- Tests: 15 vitest cases (scorer + loader). Live dogfood against
  `~/vault-mem/` returned 4/4 pass, recall=100%, F1=32% (precision drag
  from `memory.context` returning a wide bundle by design — recall is the
  meaningful signal here, which is why pass-rate is the default gate).

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
