# vault-mem

> A local-first, file-based shared memory layer for your AI agents. One Obsidian-friendly markdown vault, multiple agents, zero cloud dependency.

[![CI](https://github.com/frozo-ai/frozo-vault-mem/actions/workflows/ci.yml/badge.svg)](https://github.com/frozo-ai/frozo-vault-mem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-blue)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.12-blue)](https://www.python.org)

> **Want this for your whole team?** [Cerebro](https://cerebro.frozo.ai) is the hosted, multi-tenant version — the same MCP memory tools, shared across your team's humans *and* agents, fed by Slack/GitHub connectors. This repo stays MIT and fully featured for solo / self-host use; Cloud sells convenience, integrations, and team scale.

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
- **Export any project's memory as a drop-in skill.** `vault-mem-mcp export-skill <project> --target=claude|cursor|windsurf` turns accumulated decisions + learnings into a `SKILL.md` bundle any agent can load — [see below](#export-your-memory-as-a-skill-bundle). No other memory tool does this.

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
| `memory_supersede` | Mark one memory as superseded by another. Archives the loser, appends to winner's `supersedes`. Idempotent. |

## CLI

| Command | Use |
|---|---|
| `vault-mem-mcp init` | Materialize a fresh vault from the bundled template. |
| `vault-mem-mcp doctor` | Health check. |
| `vault-mem-mcp reindex [--fts-only \| --semantic-only]` | Drop + rebuild indexes from `.md` files. |
| `vault-mem-mcp tail-audit [-n N] [--follow]` | Tail the audit log. |
| `vault-mem-mcp export-skill <project> --target=claude\|cursor\|windsurf\|generic` | Export a per-project skill bundle (see below). |
| `vault-mem-mcp supersede <winner> <loser> [--reason]` | One-shot supersede from the command line (same mechanics as the MCP tool). |
| `vault-mem-mcp serve` (default) | Run the MCP server over stdio. |
| `python -m vault_mem_keeper run [--dry-run]` | Run a keeper pass (also via launchd). |
| `python -m vault_mem_keeper review` | Walk pending contradiction proposals interactively. |
| `python -m vault_mem_keeper {status,doctor}` | Inspect keeper state. |

## Export your memory as a skill bundle

The thing that makes vault-mem more than another note-taker: you can export
any project's memory as a drop-in skill for Claude / Cursor / Windsurf.

```bash
# Export every decision, learning, entity, and open question
# for the "kincare" project as a Claude skill.
vault-mem-mcp export-skill kincare --target=claude --output ./kincare-skill

# Then drop ./kincare-skill into Claude Code or claude.ai.
# The agent now knows everything the team has decided about kincare.
```

The exporter is **target-agnostic**: same vault, four output shapes.

- `--target=claude` → `SKILL.md` (YAML frontmatter) + `description.yaml` + `references/{decisions,learnings,entities,…}.md`.
- `--target=cursor` → `.cursor/rules/vault-mem-<project>.mdc` with `alwaysApply: true`.
- `--target=windsurf` → `.windsurfrules`.
- `--target=generic` → `README.md` + `manifest.json` + per-bucket markdown. For OpenAI assistants / custom agents.

Output is **deterministic** within each bucket (`created DESC, id ASC`), so
re-running on an unchanged vault produces byte-identical `references/*` —
diff-friendly, CI-friendly.

## Memory types

`decision` · `observation` · `learning` · `todo` · `entity` · `question` · `summary`

Each has typed frontmatter (validated against JSON Schema), markdown body, and decay policy (configurable in `_system/config.yaml`). Reference: [docs/CONFIG.md](docs/CONFIG.md).

## Privacy & DPDP / GDPR compliance

Vault-mem treats privacy as a design constraint, not a feature toggle.

**No telemetry.** Zero phone-home. Opt-in only — and there's no opt-in flag in v0.1 because there's no upstream collector to opt into. The keeper, MCP server, and exporter never make outbound network calls except to the LLM provider you've explicitly configured (Anthropic or OpenRouter, with your key).

**No cloud dependency.** Self-host runs end-to-end on your machine. Embeddings are local (`all-MiniLM-L6-v2` ONNX, runs on CPU). FTS is SQLite. Vector store is LanceDB. The only network egress is to the LLM provider, and only for the Phase 5 keeper ops you can disable in `_system/config.yaml`.

**Hashed audit log.** Every `memory_write`, `memory_search`, and `memory_context` is recorded in `_system/audit.log` (JSONL). Query text is **sha256-hashed before write** — raw queries never persist. Subject identifiers in erasure-cascade audit entries are likewise hashed; plaintext lives only in the gitignored `_system/erasure_requests.jsonl` under your retention policy.

**Per-subject erasure cascade (DPDP / GDPR Article 17).** Vault-mem ships a complete subject-erasure pipeline:

- `vault-mem-keeper erase-subject <subject-id> --reason "..."` — cascades through `.md` files (full-delete to `archive/erased/<id>.md` with a redacted stub, or scrub of the subject from `tags` + `sources` arrays), prunes the `_system/subjects.sqlite` index, drops FTS + LanceDB rows for full-deleted memories, and emits hashed audit entries.
- `vault-mem-keeper audit-subject <subject-id>` — verifies the cascade was complete. Exit codes per spec §5: `0` clean / `1` structured leak / `2` prose mention needs human review / `3` index drift (run `vault-mem-mcp reindex`).
- `memory_erase_subject` MCP tool — agent-callable, but **never silently runs the cascade**. Writes a `subject_erase_request` proposal to the approval queue and returns `pending_approval`. Operator runs `vault-mem-keeper review --filter subject_erase_request` to approve before the cascade fires. The full design lives at [`docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md`](docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md).

**Git history is the operator's call.** If you `git push` your vault to a backup remote, erasing memories from current state doesn't erase them from past commits. The cascade refuses to rewrite history automatically because force-pushing rewrites breaks every existing clone. The runbook for when and how to do it manually lives at [`docs/runbooks/erasure-git-history.md`](docs/runbooks/erasure-git-history.md).

We chose to **publish the erasure design publicly** rather than treat it as a vendor moat. Privacy by design is a marketing asset — and an obligation, since you're trusting vault-mem with your team's tribal knowledge.

## Status

**Active development.** 161 TypeScript tests + 160 Python tests, all passing.
macOS-tested. Linux should work for the MCP server and the keeper script
(the launchd plist is macOS-only — Linux/systemd unit files welcome as PRs).
Windows untested.

Shipped: vault scaffolding, MCP server v0.1, hybrid FTS + semantic search,
hygiene daemon (triage / link / decay / archive), Sonnet contradiction engine
+ per-project summarization, skills-file exporter, supersede flow, eval
harness, DPDP/GDPR per-subject erasure cascade.

**What's next:** Phase 6 polish (Obsidian Dataview dashboards + optional
Obsidian plugin), Telegram approval-gate transport (proposals queue exists
today; Telegram would plug in as an alternate delivery channel), broader
connector ingestion. The current roadmap lives in [`vault-mem-PRD.md`](./vault-mem-PRD.md); the original
solo-build PRD is preserved in [docs/origin/](docs/origin/) for context.

## Contributing

Bug reports, PRs, and feature requests welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — © 2026 Frozo AI.

## Origin

This project began as a one-person weekend build to solve a concrete personal problem. It shipped as a personal tool, was used solo for the weeks before this release, and is now public for anyone who wants the same thing. The original PRD (with all its personal scope and "this isn't a product" framing) is preserved in [docs/origin/](docs/origin/) for context. The release-prep history (specs and TDD plans for Phases 0–3) lives under [docs/superpowers/](docs/superpowers/) for anyone curious about how it was built.
