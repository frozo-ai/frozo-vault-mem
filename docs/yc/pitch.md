# Cerebro pitch — YC S26 canonical wording

**Status:** locked 2026-05-21. Use this verbatim in: YC application form, landing
page hero (optional shorter variant), 1-min video demo opening, Show HN body
(optional reframe), Twitter bio.

Variant rejected: product-first ("Cerebro is an MCP-native, typed memory
layer…"). Variant rejected: market-first ("Every engineering team that runs AI
agents is about to need shared agent memory…"). Problem-first wins because the
"AI agents have amnesia" hook is concrete, visceral, and reads in three seconds.

---

## One-line

Cerebro is the shared memory layer for AI agents — every decision, learning,
and todo your team makes, available to every Claude, Cursor, or custom agent
through one MCP endpoint.

## Paragraph (~70 words)

AI agents have amnesia. Claude Code forgets what Claude Desktop knows; Cursor
doesn't see your custom MCP client's decisions; every conversation re-derives
context from scratch. Cerebro is the shared, typed memory layer every agent
reads from and writes to — a local-first open-source vault (vault-mem, MIT,
332 tests, public on GitHub) plus a multi-tenant cloud with Slack/GitHub
connectors and DPDP-compliant erasure. Dogfooded daily. Selling to engineering
teams running multi-agent workflows at $12/seat/month.

---

## Numbers to refresh before submitting

- "332 tests" = 172 TS + 160 Python as of 2026-05-21. Re-count before each
  public surface ships.
- "$12/seat/month" = decided 2026-05-21. ₹999/seat shown alongside for India
  IPs. Both routed through Dodo (live keys live on Railway as of 2026-05-21).
- "Dogfooded daily" = the founder generates 5-15 memories/day in production
  Cerebro across vault-mem / vault-cloud / kincare / frozo projects.

## Phrases that have to survive copy-edits

- "AI agents have amnesia" — the hook. Don't soften.
- "MCP endpoint" — keep the protocol name; it's the wedge and the
  distribution story.
- "local-first" — single most differentiating word in the paragraph.
- "DPDP-compliant erasure" — proves we shipped the privacy primitive, not
  just promised it.
- "Dogfooded daily" — the only line that signals the founder is the user.
