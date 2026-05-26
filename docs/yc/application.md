# YC S26 Application — Cerebro (working draft)

**Status:** working draft, 2026-05-21. The S26 form typically opens mid-July
with deadline 2026-09-30. This locks the narrative we'll paste once the form
goes live. Sourced from `docs/yc/pitch.md` for canonical wording — keep this
file consistent with the pitch.

The questions below are reconstructed from previous batches' forms (S24 / W25 /
S25). YC tweaks wording year-to-year but the shape is stable. Update each
answer once the actual S26 form is live.

---

## Company basics

**Company name:** Frozo (legal) / Cerebro (product brand)

**One-liner (50 char max — hardest single sentence in the app):**

> Shared memory layer for AI agents.

(50 chars exactly. Alternate if YC raises the cap: "The shared brain for AI
agents — MCP-native, local-first.")

**URL:** https://cerebro.frozo.ai · https://github.com/frozo-ai/frozo-vault-mem

**Where based:** India (founder in India; Cerebro Cloud hosted in
Supabase ap-south-1 + Railway). Open to relocating during YC batch.

---

## What does your company do?

AI agents have amnesia. Claude Code forgets what Claude Desktop knows; Cursor
doesn't see your custom MCP client's decisions; every conversation re-derives
context from scratch. Cerebro is the shared, typed memory layer every agent
reads from and writes to — a local-first open-source vault (vault-mem, MIT,
332 tests, public on GitHub) plus a multi-tenant cloud with Slack/GitHub
connectors and DPDP-compliant erasure. Dogfooded daily. Selling to engineering
teams running multi-agent workflows at $12/seat/month.

---

## Why did you pick this idea? Do you have domain expertise?

I built this for myself first. I've been running Claude Code, Claude Desktop,
Cursor, and custom MCP clients in parallel for months — each one has its own
siloed memory, every new conversation re-derives context, and nothing the
agents collectively "know" is queryable from outside the chat window.

I'm an engineer, not a memory-researcher — but I'm exactly the user the
product needs. The first version was a weekend tool that I used solo for ~6
weeks before deciding it was big enough to open-source. The OSS landed on
2026-04-28; the Cloud half is in private beta as of 2026-05.

The deeper expertise that matters is operational: I've been building
production agents (frozo.ai, kincare, edgegate) and felt every variant of
this pain. I know what "memory" actually has to do for agents to compose
across sessions, vs. what looks good in a demo.

---

## What's new? What substitutes do people resort to?

What's new:

1. **Typed memory ontology.** 7 buckets (decision / observation / learning /
   todo / entity / question / summary), each with frontmatter, decay rules,
   and status. Not one undifferentiated blob. Lets agents filter by
   "active decisions for project X" in ms.
2. **MCP-native from day one.** Every operation is an MCP tool call. Drop-in
   for Claude Code / Cursor / Windsurf / any MCP client without per-agent
   integration code.
3. **Local-first OSS with Cloud parity.** Markdown files at `~/vault-mem/`
   are the source of truth. Cloud adds Postgres for multi-tenancy but every
   OSS feature exists in Cloud (and vice versa).
4. **Privacy-by-design.** Per-subject erasure cascade (DPDP/GDPR-compliant)
   shipped in v0.1, design published publicly — first OSS memory layer to
   do this.

Substitutes people resort to:

- Stuffing context into the system prompt by hand (breaks at 100k tokens,
  no inter-agent sharing).
- Notion / Linear / Slack as "memory" (not queryable by agents,
  format-fragile).
- Building their own per-agent SQLite store (no sharing, no decay, every
  team reinvents it).
- Mem.ai (consumer notes with AI on top — doesn't solve the agent-shared
  case; closed-source).
- Cursor's `.cursor/rules/` (one-agent-only, not queryable).

---

## Who are your competitors? Who might become competitors? Who do you fear most?

**Today:**

- **Mem.ai** — Consumer AI notes. Closed-source, no MCP, no team layer.
  Different shape of product; overlaps only on the word "memory."
- **Glean / Coveo / Hebbia** — Enterprise search across docs. They index
  *content the team already created*; we index *what the agents decided*.
  Different sides of the same coin.
- **Notion AI / Confluence AI** — RAG over existing wiki. Same overlap as
  Glean: they retrieve, we record-and-retrieve.
- **Roll-your-own per-team** — Most engineering teams who've felt the pain
  have built an internal sqlite memory tool. None of them have shipped it.
  We win by being the open-source default they adopt instead.

**Future:**

- **Anthropic / OpenAI ship memory** — Most realistic threat. Anthropic
  added memory to Claude in 2025; OpenAI has it in ChatGPT. But: their
  memory is per-agent (Claude Code's memory ≠ Cursor's memory) and
  closed-source. The MCP-native, cross-agent, local-first wedge is
  defensible.
- **Cursor / Windsurf integrate memory deeply** — Possible. We're a
  protocol-layer play (MCP), so even if Cursor ships rich internal memory,
  teams running multi-agent workflows still want one source of truth.

**Who we fear most:** A well-funded YC-batch team building "Mem for agents,
cross-IDE, open-source." That product doesn't exist yet; we're racing to
become it before someone else does.

---

## How will you make money? How much could you make?

**Model:** Per-seat SaaS.

- Free tier: self-host the OSS, unlimited memories, single user. Distribution
  channel.
- Team: $12/seat/month USD (₹999/seat in India), Cloud-hosted, includes
  connectors (Slack / GitHub / Linear / Notion / meetings), audit log,
  web UI, multi-org.
- Enterprise: contact sales. Custom SSO, on-prem option, dedicated
  embedding-model choice, SLA.

**Pricing decided 2026-05-21.** Live on Dodo Payments as of today.

**TAM math (rough, intentionally conservative):**

- 2026: ~25M engineers globally (Stack Overflow + GitHub data).
- ~10% actively use coding agents in 2026, growing to 50%+ by 2028.
- Of those, ~30% in orgs with 5+ engineers (the wedge — single-agent users
  stay on free).
- 25M × 50% × 30% = 3.75M paid seats addressable by 2028.
- At $12/seat/month average: $540M ARR ceiling.
- Realistic 2-year capture target: 0.5% = $2.7M ARR by end of 2028, $10M+ by
  2030 if we win the open-source default.

**The unit economics:** ~$1/seat/month infrastructure cost (Supabase +
Voyage embeddings + Anthropic Haiku for triage). $11/seat gross margin.

---

## How long have you been working on this?

- **Solo idea + first prototype:** 2026-02 (4 months ago)
- **OSS public on GitHub:** 2026-04-28
- **Cerebro Cloud private beta:** 2026-05
- **Founder full-time:** since 2026-02 (no other employment)
- **Lines of code shipped:** ~12k TS + 6k Python + 4k SQL across the two
  repos.
- **Tests:** 172 TypeScript + 160 Python = 332 passing.

---

## What tech is your company built around?

- **MCP** (Model Context Protocol) — the wedge. Every agent client speaks
  it; we expose the memory layer through it.
- **TypeScript** for the MCP server (official SDK ecosystem).
- **Python + uv** for the hygiene daemon (LLM ecosystem).
- **LanceDB + ONNX MiniLM** for local-first embeddings (zero API cost).
- **Postgres + pgvector** on Supabase for Cloud multi-tenancy. Voyage AI
  `voyage-3` as the default Cloud embedding model.
- **Next.js + shadcn/ui** for the Cloud web UI.
- **Claude Haiku 4.5** for keeper triage; Sonnet for contradiction
  detection.
- **OpenRouter** as the preferred LLM gateway (BYOK per-org).
- **Dodo Payments** for global billing (USD + INR native).

---

## How long would it take to build a minimum viable version?

Already shipped. Cerebro Cloud is in private beta at `cerebro.frozo.ai` with
the founder + early signups as live users. OSS is public, MIT, dogfooded
daily.

---

## What convinced you to apply to YC?

Three things:

1. **Network leverage** — engineers in YC batches are exactly the early
   adopter profile. Every batchmate running 3+ AI agents is a potential
   first user.
2. **Distribution validation** — a YC-backed open-source dev tool gets a
   reading at every dev's first scroll through Show HN, Twitter, and
   r/programming. The compounding effect of YC's logo on "should I trust
   this?" is real.
3. **Speed pressure** — we're racing against the chance that
   Anthropic/OpenAI ship cross-agent memory natively. YC's 3-month sprint
   structure is the right cadence to ship the wedge before that window
   closes.

---

## If you had other ideas, list them

We considered three:

1. **kincare** — family health-tech app. Active side project, won't apply
   to YC with it; too small a wedge.
2. **fleetml** — open-source edge MLOps platform ("Kubernetes for edge
   AI"). Real product, but the market is narrower than Cerebro's and the
   sales motion is longer.
3. **frozo-trading-view** — TradingView automation MCP. Personal tool;
   not a venture.

Cerebro is the only one big enough.

---

## Things to nail before submission

- [ ] Refresh test count to current as-of-submission day
- [ ] Refresh "X paying seats" or "Y signups" numbers
- [ ] Refresh "Selling to engineering teams" → "Selling to N teams" if
      design partners onboarded
- [ ] Add 1-2 named customer logos if any closed by Aug
- [ ] 1-min demo video uploaded + linked
      (draft locked at `cerebro-yc-demo/cerebro-yc-demo-final-v3-1080p.mp4`,
      1920×1080 · 13MB · 63s · MiniMax-cloned founder VO + burned-in captions;
      upload to https://x.com/ashishdhiman23/status/2058889731648471448 then paste here)
- [ ] Verify all GitHub / website / blog links resolve
- [ ] Co-founder section (if applicable; currently solo)
- [ ] Anti-cliché pass: kill anything that sounds like every other YC app
      ("we're disrupting…", "the future is…", etc.)
