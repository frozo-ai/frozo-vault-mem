# r/LocalLLaMA draft

**Status:** draft. r/LocalLLaMA leans toward Llama / Ollama / fully-local
inference; vault-mem is local for storage + embeddings but the MCP clients
that use it (Claude Code, etc.) typically aren't local. Frame as "the
storage layer is local; bring your own agent." Post on a weekday morning PT.

---

## Title

> I open-sourced a local-first shared memory layer for AI agents — markdown vault, local embeddings, no API keys

Alt:

- _One markdown vault, multiple agents — vault-mem (open source, no cloud)_

---

## Body

I built this for myself first. Spent months running Claude Code, Cursor, and
random custom MCP clients in parallel — every agent had its own siloed memory,
nothing was searchable, everything got copy-pasted between sessions. Built a
local-first shared memory layer to fix it. Releasing it as MIT today.

**The basics**

- Storage: plain markdown files at `~/vault-mem/`. Source of truth.
  Compatible with Obsidian (open the folder in Obsidian, see your vault).
- Search: SQLite FTS5 (keyword) + LanceDB (local ONNX MiniLM embeddings, 384-d).
  Fused via Reciprocal Rank Fusion. **Runs entirely on your machine. No
  embedding API calls, no telemetry, no cloud sync.**
- Interface: MCP server (stdio). Claude Code, Claude Desktop, Cursor, and any
  MCP-aware agent can write/read/search through it.
- Maintenance: Python daemon ("keeper") on a 30-min cron auto-promotes inbox
  writes, decays stale observations, archives expired ones, links
  semantically-related notes. Optional. The vault works fine without it.

**Why local-first matters here**

The whole point is that your second brain shouldn't depend on a vendor.
Markdown files. Local embeddings. No telemetry. If Anthropic/OpenAI/whoever
shuts down or paywalls something tomorrow, your knowledge keeps existing.

You can also `git init` the vault directly — version-controlled memory.

**A feature I'm pretty happy about**

`vault-mem-mcp export-skill <project> --target=claude|cursor|windsurf|generic`
turns a project's memory into a drop-in skill file:

```bash
vault-mem-mcp export-skill kincare --target=claude --output ./kincare-skill
```

Produces a `SKILL.md` + per-bucket reference docs (decisions / learnings /
entities / open questions / …). Drop the folder into Claude Code or
claude.ai and the agent now knows everything you've recorded about that
project. Same input vault → byte-identical `references/*.md` output, so it's
diff-friendly. cursor / windsurf / generic targets produce their format's
flavor.

**The constraint that gives it shape**

7 typed memory buckets: decision / observation / learning / todo / entity /
question / summary. Not one blob you stuff things into. Each has frontmatter,
decay rules, status. Filtering "show me active decisions for project x" is a
sub-ms SQLite query.

**What it isn't**

- Not a replacement for Mem.ai / Notion AI / Glean — different problem.
- Not a local LLM runtime. It's the storage + search layer. You bring your
  own agent. Works great with local-LLM-driven MCP clients too — anything
  that speaks MCP can read/write.
- Not magic. If you don't write memories down, none materialize. The MCP
  tools make it easy for agents to capture context automatically as they
  work, but the discipline is on you (or your agent's prompts).

**Stack**

- TypeScript + better-sqlite3 + LanceDB + `@xenova/transformers` (ONNX
  MiniLM) for the MCP server.
- Python + uv for the keeper daemon.
- Storage: `.md` files + SQLite index + LanceDB vectors. All on disk.
- Total dependencies you'll pull: ~80MB of npm + ~200MB of Python deps +
  the MiniLM ONNX model (~25MB).

**Tested**

- 172 TypeScript tests + 160 Python tests. All pass.
- Runs on macOS (used daily). Linux should work; the launchd plist is
  macOS-specific (Linux systemd unit file is a welcome PR). Windows
  untested.

**Repo**

<https://github.com/frozo-ai/frozo-vault-mem> · MIT

If anyone's been wanting "agent-shareable memory but local-only", give it
a spin and let me know what breaks. Especially curious about non-macOS
issues since I haven't tested broadly.

---

## Things to remember post-submit

- Engage with technical questions in detail; LocalLLaMA values depth.
- Be very honest about the "you still need a cloud LLM to use it
  effectively" caveat. Don't oversell the local-only angle.
- Link to a specific section of the README if someone asks "show me the
  search code" — they often want receipts.
