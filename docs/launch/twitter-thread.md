# Twitter/X thread draft

**Status:** draft. 8 tweets. Pin the first one to the timeline for launch day.
Best posting time: Tuesday/Wednesday/Thursday 10am-1pm IST (US morning).

## The thread

---

**1/8** (the hook — must stand on its own)

Your AI agents have amnesia.

Claude Code forgets what Claude Desktop knows. Cursor doesn't see your custom
MCP client's decisions. Every new conversation re-derives context from
scratch.

I open-sourced the fix: vault-mem — one markdown vault every agent shares.

🎥 Attach 1-min video → https://x.com/ashishdhiman23/status/2058889731648471448
(the Cerebro Cloud demo — 63s, 1920×1080 — shows Claude Code asking the
vault and Cursor returning the same memory ID; Twitter native-video is
better than a link)

🧵👇

---

**2/8** (what it is, concrete)

vault-mem is a local-first MCP server.

→ Storage: plain `.md` files at `~/vault-mem/`
→ Search: SQLite FTS5 + local ONNX embeddings (no API keys!)
→ Works with Claude Code, Claude Desktop, Cursor, any MCP client
→ Optional Python daemon keeps everything coherent

If every AI company shut down tomorrow, your knowledge survives.

---

**3/8** (the typed-buckets insight)

Most "memory" layers are an undifferentiated text blob. vault-mem has 7
typed buckets:

decision · observation · learning · todo · entity · question · summary

Each has frontmatter, decay rules, status.

"Show me active decisions for project X" → 1 sqlite query, <1ms.

Structure compounds.

---

**4/8** (the headline feature — show, don't tell)

```bash
vault-mem-mcp export-skill kincare --target=claude
```

Produces a Claude skill bundle: SKILL.md + references/decisions.md,
learnings.md, entities.md, …

Drop it into Claude Code or claude.ai.

The agent now knows every decision your team has ever made about kincare.

---

**5/8** (4 targets)

Same vault, four export shapes:

→ --target=claude  → SKILL.md + references/
→ --target=cursor  → .cursor/rules/vault-mem-<project>.mdc
→ --target=windsurf → .windsurfrules
→ --target=generic → README + manifest.json + per-bucket md

Diff-friendly: re-export on an unchanged vault = byte-identical output.

---

**6/8** (the daemon)

A 30-min Python daemon ("the keeper") quietly maintains coherence:

→ promotes inbox writes after 24h dwell
→ decays stale observations
→ archives expired memories
→ semantically links related notes
→ NEW: Sonnet-driven contradiction detection ("you said A here and ¬A here")

Optional. Vault works fine without it.

---

**7/8** (origin)

This started as a weekend build for one person (me) running 4 AI agents in
parallel and tired of the memory silos.

Used it solo for a few weeks. Phases 0–5 shipped including the skill
exporter.

172 TS tests + 160 Python tests passing. MIT.

---

**8/8** (CTA)

If you've ever thought "my AI agents should share memory" — try it:

🔗 github.com/frozo-ai/frozo-vault-mem

`pnpm install && vault-mem-mcp init` and you're running locally in 60s.

PRs / bug reports / "this didn't work on Linux because X" issues all welcome.

🛠️ vault-mem v0.5 → today.

---

## Things to remember post-publish

- Reply to every reply for the first 2 hours.
- If "how is this different from mem0?" comes up: mem0 is an SDK, vault-mem
  is a complete tool — MCP server + storage + search + maintenance daemon
  + skill exporter, all local.
- Take screenshots of (a) the SKILL.md output, (b) the `vault-mem-mcp doctor`
  output, (c) Obsidian opening the vault folder. Attach to relevant
  follow-up tweets.
- Don't quote-tweet competitors. Don't be cute about it.
