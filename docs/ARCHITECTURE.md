# Architecture

A guided tour of how vault-mem fits together — what each piece does, why it exists, and what's deliberately *not* in scope. Read this if you're contributing or trying to understand the design rationale.

## Mental model in one sentence

You have a personal assistant with amnesia. They forget everything overnight. You're tired of telling them the same context every morning. vault-mem is a notebook the assistant carries — they write things down as you say them, and read the relevant pages before answering. Every assistant on your machine reads the same notebook. The notebook is also yours, in markdown, on disk, in git. Forever.

## The vault

`~/vault-mem/` is a folder of plain markdown files. Each file is one *memory* — a `decision`, an `observation`, a `todo`, a `learning`, an `entity`, a `question`, or a `summary`. Folders organize them:

```
~/vault-mem/
├── memory/
│   ├── decisions/      mem_2026-04-27_a8f3c0.md
│   ├── observations/
│   ├── todos/
│   ├── learnings/
│   ├── summaries/
│   ├── entities/
│   └── questions/
├── inbox/              # fresh agent writes (mirror of memory/ structure)
├── archive/            # retired memories (TTL-expired or low-confidence)
├── projects/           # human-curated project pages
└── _system/
    ├── schema/         # JSON Schemas for each memory type
    ├── templates/      # markdown templates for each type
    ├── config.yaml     # per-vault config (server + keeper)
    ├── index.sqlite    # FTS5 keyword index (gitignored, rebuildable)
    ├── embeddings.lance/  # vector index (gitignored, rebuildable)
    ├── audit.log       # JSONL append-only log of every operation
    └── links.jsonl     # daemon-managed top-K semantic neighbors (gitignored, rebuildable)
```

The `.md` files are the **source of truth**. Everything else (`index.sqlite`, `embeddings.lance/`, `links.jsonl`) is derived and rebuildable via `vault-mem-mcp reindex`.

## The three actors

```
            ~/vault-mem/  (markdown files)
                  │
   ┌──────────────┼──────────────┐
   │              │              │
  You          AI agents      The keeper
(Obsidian)  (via MCP server)  (every 30 min via launchd)
```

Three processes share one folder. None of them locks the data behind a database; you can `cat` and `grep` the vault any time.

### Actor 1: You (Obsidian or any text editor)

You read and write `.md` files directly. The MCP server's chokidar watcher notices your changes and reconciles the indexes.

### Actor 2: AI agents (via the MCP server)

The MCP server (`packages/mcp/`) is a Node 20 stdio process exposing 5 tools:

| Tool | Purpose |
|---|---|
| `memory_write` | Validate frontmatter against schema, write `.md` to inbox, append audit, embed, upsert FTS + Lance |
| `memory_read` | Fetch one memory by id (index lookup, fallback to disk scan) |
| `memory_search` | Hybrid search (default): FTS5 BM25 + LanceDB cosine, fused via Reciprocal Rank Fusion |
| `memory_promote` | Move a memory from inbox/ to memory/ (rare; keeper auto-promotes most) |
| `memory_context` | Pack relevant project memories into a token budget for context-loading |

Stdio means **no network surface**. Each Claude Code or Claude Desktop session spawns a fresh server process.

### Actor 3: The keeper (Python daemon)

The keeper (`packages/keeper/`) is a Python 3.12 script scheduled every 30 min via macOS `launchd`. Each run:

1. **Triage** — promote inbox memories that are >24h old with `confidence ≥ 0.7` (or `human_reviewed: true`) into canonical `memory/<type>/`.
2. **Auto-link** — for each canonical memory, write the top-5 semantic neighbors (above similarity threshold) to `_system/links.jsonl`.
3. **Decay** — observations and learnings lose `0.05` confidence per period (30 days for observations, 60 for learnings, configurable). `last_decay_at` advances by completed periods, preserving partial-period progress across long downtimes.
4. **Archive** — memories with `confidence < 0.3` or expired `ttl_days` move to `archive/` with `status: "archived"`.

Each op writes to the same JSONL audit log with `agent: "keeper"`. Failures in one op don't block subsequent ops — the run completes and reports per-op status.

## A memory's life cycle

```
Agent writes              ↓ keeper triage          ↓ keeper decay         ↓ keeper archive
  via MCP        ─────►   inbox/      ─────►        memory/      ─────►    archive/
                         (24h grace)              (canonical)             (TTL or low-conf)
```

Confidence is reinforced explicitly (you bump the field in Obsidian, or an agent writes a fresh memory). Edits to body content do **not** reset the decay clock — content changes ≠ trust changes.

## Indexes

vault-mem maintains two derived indexes alongside the `.md` files:

### FTS5 (`_system/index.sqlite`)

A SQLite virtual table with porter+unicode61 tokenization on `title`, `body`, and `tags` columns; type/project/status/location stored as `UNINDEXED` filter columns. Updated synchronously on every `memory_write`; reconciled by the chokidar watcher on external edits.

### LanceDB (`_system/embeddings.lance/`)

A Lance file-format directory storing `(id, vector[384], metadata)` per memory. Vectors are produced by `@xenova/transformers` running ONNX-quantized MiniLM (`Xenova/all-MiniLM-L6-v2:int8`, ~22 MB, downloaded once and cached at `~/.cache/huggingface/`). Mean-pooled, L2-normalized.

### Hybrid search (default mode)

```
memory_search(query, mode: "hybrid")
  ↓
  ┌─ FTS5: BM25 ranking (top 50)              ─┐
  ↓                                             │  RRF: score = 1/(60 + rank_fts)
  └─ Embed query, Lance cosine search (top 50) ─┘        + 1/(60 + rank_semantic)
  ↓
  Top N results by RRF score
```

RRF fuses the two rank lists so that exact-token matches and conceptual matches both score well. `mode: "fts"` and `mode: "semantic"` skip one branch entirely.

## Audit log

Every operation appends one JSON line to `_system/audit.log`. Schema:

```json
{"ts":"2026-04-28T03:00:00.123Z","v":1,"op":"write","agent":"claude-code","session":"01HX...","id":"mem_2026-04-28_a8f3c0","type":"decision","path":"...","schema_version":"0.1"}
```

Both the TS server and the Python keeper produce records in the same shape. Search and context queries are stored as `query_hash: "sha256:..."` — never raw text.

## Trust boundaries

- **Stdio MCP, no network.** The server has no HTTP endpoint, no port bindings. A process can only call it if it can spawn it as a subprocess.
- **Schema validation on every write.** All frontmatter is validated against versioned JSON Schemas before any disk write.
- **Inbox isolation.** Agents write to `inbox/` only. The keeper is the only writer for `memory/` and `archive/` (the manual `memory_promote` tool exists but is rarely used).
- **Atomic writes.** Every `.md` mutation goes through temp-file rename; per-file advisory locks via `proper-lockfile` serialize concurrent writes to the same id.
- **Audit log is append-only.** No tool deletes from it; no timeline rewriting.

## What's deliberately NOT in scope

- **Multi-user / collaboration.** vault-mem is single-tenant by design.
- **Cloud sync, hosted services.** Local-first is a hard requirement, not a default.
- **Encryption at rest.** Use OS-level full-disk encryption.
- **Hosted MCP transport.** Stdio only; no SSE/WebSocket/HTTP.
- **Telegram approval gate** (Phase 4 on the roadmap, not yet shipped).
- **Sonnet-powered contradiction detection / summarization** (Phase 5).
- **Cross-platform installer** (macOS launchd ships; Linux/systemd unit files welcome as PRs).
- **Windows support** (untested; PRs welcome).

## Why these choices

1. **Files first.** If everything else burns down, your knowledge survives in plain markdown. Indexes are derived; rebuild them anytime.
2. **Three processes, not one.** The MCP server must respond fast (synchronous tool calls). The keeper does slow background work (embeddings, decay scans). Splitting them keeps each simple and isolatable.
3. **No cloud, no API keys.** Embedding model runs locally via ONNX. The vault works offline. Privacy is the default, not a feature.
4. **Two languages, one vault.** TypeScript fits the MCP SDK; Python fits the LLM ecosystem (sentence-transformers, lancedb, etc.). Both speak the same data shapes (JSON Schemas, JSONL audit format) so they coexist cleanly.
5. **Schema additivity rule.** Once a memory is written, its frontmatter shape must remain valid forever. New fields are optional; renames and removals require a versioned migration before they may ship. This protects existing vaults from breakage when the project evolves.

## Further reading

- [docs/INSTALL.md](INSTALL.md) — full install guide for all clients
- [docs/CONFIG.md](CONFIG.md) — every config field documented
- [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common issues and fixes
- [docs/origin/personal-use-prd.md](origin/personal-use-prd.md) — the original PRD that drove the design
- [docs/superpowers/specs/](superpowers/specs/) — phase-by-phase design docs (Phases 0–3)
- [docs/superpowers/plans/](superpowers/plans/) — TDD implementation plans (Phases 0–3)
