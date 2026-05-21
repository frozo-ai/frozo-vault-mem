# Show HN draft

**Status:** draft. Pick a posting window (Tuesday/Wednesday 9-11am PT is the
empirical sweet spot for technical Show HN posts) and verify CI is green
+ links resolve before submitting.

---

## Title

> Show HN: Vault-mem – a local-first shared memory layer for AI agents

Alt titles tried:

- _Show HN: One markdown vault, every AI agent can read it_ (more
  jargon-free, but loses "shared memory")
- _Show HN: Vault-mem – stop your AI agents from forgetting everything_
  (catchier but feels markety; HN dislikes)

---

## Body

I've been running Claude Code, Claude Desktop, and Cursor in parallel for months
and the recurring pain was: every agent has its own siloed memory. Every new
conversation reconstructs context from scratch, badly. Notion docs go stale.
Project context gets copy-pasted between sessions.

Vault-mem is one shared markdown vault that all my AI agents read from and
write to. Built it for myself, used it solo for a few weeks, now public.

**What it is**

- 8 MCP tools (`memory_write` / `memory_read` / `memory_search` /
  `memory_promote` / `memory_context` / `memory_supersede` /
  `memory_erase_subject` / `memory_graph`) usable from Claude Code,
  Claude Desktop, Cursor, or any MCP client.
- Storage is plain `.md` files at `~/vault-mem/`. Open them in Obsidian.
  Commit them to git. If every AI company shut down tomorrow, my knowledge
  survives.
- Hybrid search: SQLite FTS5 (BM25) + local ONNX MiniLM embeddings (384-d),
  fused via Reciprocal Rank Fusion. **No API keys, no cloud dependency.**
- A 30-min Python daemon (the "keeper") auto-promotes inbox writes after
  dwell, decays stale observations, archives expired ones, links
  semantically-related notes. Optional but recommended.
- Recent shipped feature: `export-skill <project> --target=claude|cursor|windsurf|generic`
  bundles a project's memory into a drop-in skill file. The agent goes
  from "what's our auth choice again?" → it already knows.

**Why typed buckets, not blobs**

Most memory layers are an undifferentiated text blob you stuff things into.
Vault-mem has 7 typed buckets (decision / observation / learning / todo /
entity / question / summary), each with frontmatter, decay policy, and
status. Filtering by `type: decision, project: x, status: active` is a
sub-millisecond SQLite query. The structure pays for itself.

**Honest about the trade-offs**

- macOS tested. Linux should work for the daemon + MCP server but the
  launchd plist is macOS-only. Windows untested. PRs welcome.
- Markdown is the source of truth. Indexes are derived. That means index
  drift is possible if you edit `.md` files outside the MCP tools; a
  `reindex` CLI rebuilds from disk in seconds.
- This isn't competing with Mem.ai (consumer notes with AI), Glean
  (enterprise search), or Notion AI (RAG over Notion). It's specifically
  for the "I run agents and want them to share memory" case.

**Try it**

```
git clone https://github.com/frozo-ai/frozo-vault-mem
cd frozo-vault-mem && pnpm install && pnpm --filter @vault-mem/mcp build
node packages/mcp/bin/vault-mem-mcp init
```

Then `claude mcp add … vault-mem` to wire it into Claude Code.

Repo: <https://github.com/frozo-ai/frozo-vault-mem>
MIT licensed. 172 TypeScript tests + 160 Python tests passing.

Happy to answer questions. Particularly curious whether the "typed
ontology beats one blob" intuition holds up for other people too.

---

## Things to remember post-submit

- First-hour replies matter most. Refresh every 15 min for the first 90.
- Don't argue with the "this is just SQLite" comment — say "fair, and
  here's why MCP-level access still matters."
- If someone asks about cross-org / team use: be upfront that Vault Cloud
  (commercial) is in development; the OSS half is feature-complete for
  single-user.
- Don't link to commercial offerings in the post (HN frowns on it).
