# Vault-mem — Product Requirements Document

**Product:** Vault-mem (OSS core) + Vault Cloud (commercial)
**Tagline:** The company brain — turn scattered knowledge into an executable skills file every AI agent can use.
**Author:** Ashish Dhiman
**Status:** Draft v1.0
**Date:** 2026-05-13 (IST)
**Target launch:** YC S26 application demo — 2026-07-15 ・ Public OSS launch — 2026-08-30 ・ Cloud GA — 2026-12-01
**Related:** YC RFS #5 "Company Brain" (Tom Blomfield)

---

## 0. TL;DR

Every company runs on knowledge that lives in people's heads, Slack threads, and 18-month-old Notion pages. AI agents cannot operate on top of that. Vault-mem is the missing layer: a durable, typed, queryable record of *how a company actually works* that compiles into a skills file every AI agent — Claude, Cursor, Windsurf, custom — can consume.

The OSS core is markdown-durable, MCP-native, and already in production for single-founder use. The commercial product extends it to teams with ingestion connectors (Slack, GitHub, Linear, Notion, meeting tools), multi-tenancy, an eval harness, and a hosted web UI.

We win on two axes incumbents cannot match: **markdown-as-source-of-truth** (no lock-in, portable, auditable) and **typed memory ontology** (decision / observation / learning / todo / entity / question / summary — not a single undifferentiated blob).

---

## 1. Problem Statement

**The user problem.** As AI agents become capable enough to do real work, the bottleneck has shifted from model quality to context. Agents fail not because they cannot reason, but because they do not know:

- Which decisions a team has already made and why
- What conventions, exceptions, and edge cases the team has encoded over time
- Which people, projects, and tools matter and how they relate
- What is currently true vs. what was true 9 months ago

Today this context lives in five places — none of them queryable by an agent: human memory, Slack DMs and threads, meeting recordings, scattered docs, and ticket history. Each individual agent invocation reconstructs context from scratch, badly, every time.

**Cost of not solving it.**
- Agents hallucinate decisions the company already made (expensive errors, sometimes irreversible)
- Companies cannot trust agents with anything mission-critical → AI adoption stalls at "copilot" never reaches "autonomous"
- Onboarding takes 3–6 months because tribal knowledge is not transferable
- Decision velocity drops as companies grow because nobody remembers why current systems exist

**Evidence (qualitative).** Tom Blomfield's RFS #5 explicitly identifies this as the #1 blocker to AI automation. Every YC W26/S26 batch interview transcript surfaces the same complaint: "the agent works in demos and breaks at our customer because it doesn't know our weird stuff."

**Evidence (founder-level dogfooding).** Vault-mem's Phase 3 keeper has been running in production since 2026-04-28 across three concurrent projects (kincare, vault-mem, frozo). The current operator (Ashish) generates ~5–15 memories/day; without vault-mem, each project conversation re-derives context that should already be canon. With vault-mem, project-scoped context loads in under one tool call.

---

## 2. Goals

Outcomes — what success looks like 12 months post-launch.

**User goals**
1. **Reduce time-to-context for an agent from minutes to <500ms.** An agent given `project=kincare` should have full prior decisions, entities, and learnings loaded before its first tool call.
2. **Enable agents to write to memory, not just read.** Closed-loop systems: agents propose memories, humans (or rules) ratify, the brain compounds.
3. **Eliminate vendor lock-in for company knowledge.** A customer who churns gets a folder of `.md` files. A customer mid-migration loses zero data. A customer with a compliance audit can grep their entire brain.
4. **Turn scattered company artifacts into a refreshing skills file.** `vault-mem export-skill <project>` produces a Claude/Cursor/Windsurf skill bundle that auto-updates as the brain grows.

**Business goals**
5. **Reach 1,000 GitHub stars and 100 self-hosted deployments within 90 days of OSS launch.** Distribution proxy.
6. **Land 3 paying design partners ($100–$500/mo) before YC S26 application close (2026-09-30).** Commercial-viability proxy.
7. **Achieve 60% week-4 retention on Vault Cloud free tier.** Stickiness proxy.
8. **Become the default open-source memory layer for MCP-compatible agents.** Category leadership proxy — measured by inbound integration requests from agent framework authors.

---

## 3. Non-Goals

What v1 explicitly will not do, and why.

| Non-goal | Why out of scope |
|---|---|
| **A general-purpose enterprise search product** (Glean-equivalent) | Different value prop. Vault-mem is curated decision memory, not document discovery. Stay focused. |
| **A meeting transcription / recording product** | Crowded, capital-intensive, low-margin. We *ingest from* Granola/Fireflies/Gong; we don't compete with them. |
| **A chat interface as the primary surface** | Chat-over-memory is a feature, not the product. The MCP and skills-file exports are the surface; chat ships as table-stakes UI. |
| **A code-search / code-memory product** | Cursor, Sourcegraph, Greptile own this category. We touch *engineering decisions* (in Linear/GitHub PRs), not the codebase itself. |
| **A multi-modal (image/audio/video) memory store in v1** | Markdown-durable design assumes text. Multi-modal is a v2 architectural decision; flagged as P2 to avoid blocking design. |
| **Real-time collaborative editing on memories** | Memories are append-only with supersede semantics. Editing is a workflow, not a primitive. |
| **A workflow / automation engine** | Vault-mem informs agents; it does not orchestrate them. Zapier/Make/n8n are downstream consumers. |

---

## 4. Target Users & Personas

### Primary persona — Anya, AI-forward founder/engineer (10–50 person company)
- Runs an AI-native or AI-adjacent product
- Already uses Claude, Cursor, or Windsurf daily
- Personally owns multiple projects and loses 30+ min/day re-loading context
- Pain: "My agents work in demos and forget everything between conversations."
- Buying power: yes, founder/CTO.

### Secondary persona — Dev, IC engineer at AI-forward company
- Day-to-day Claude/Cursor user
- Self-hosts the OSS, writes memories from CLI, gradually convinces team
- Pain: "Onboarding new engineers takes a quarter because nobody documents *why*."
- Buying power: influencer; champions purchase decisions.

### Tertiary persona — Maya, ops/COO at a non-tech company (20–100 person)
- Runs an operations-heavy team (services firm, clinic group, agency)
- Does not write code; will not touch markdown
- Pain: "Every new hire asks the same 50 questions; I'm tired of answering them."
- Buying power: yes; pays for Vault Cloud Business tier.
- *Critical for proving "every company in the world" thesis.*

### Anti-persona — solo content creator / writer
- Wants Obsidian, not vault-mem. We will not optimize for them.

---

## 5. User Stories

Ordered by priority.

### P0 — required for v1

1. **As a developer**, I want to install vault-mem with one command and start writing memories from my Claude/Cursor MCP session, so that I can adopt it without operational overhead.
2. **As a developer**, I want all my memories stored as `.md` files in a directory I own, so that I can `git` them, back them up, and never get locked in.
3. **As a developer**, I want my agent to call `memory.context(project="x")` and receive a token-budgeted bundle of the most relevant prior decisions, observations, and entities, so that agent quality improves without prompt-engineering.
4. **As a developer**, I want my agent to write decisions, observations, and learnings to vault-mem proactively, so that the brain grows without manual capture.
5. **As a team admin**, I want to authenticate my team via Google/Microsoft SSO and grant per-project access, so that the brain is shared without being a free-for-all.
6. **As a team admin**, I want to connect Slack and have decisions made in `#engineering` or `#product` automatically classified, structured, and written as memories, so that my brain captures knowledge passively.
7. **As a team admin**, I want to connect GitHub and have decisions surfaced in PR descriptions and issue threads captured, so that engineering rationale is preserved.
8. **As any user**, I want to run `vault-mem export-skill <project>` and receive a Claude/Cursor/Windsurf skill bundle that I can drop into my agent and have it instantly behave like a teammate who knows our company, so that the brain has a portable runtime artifact.
9. **As any user**, I want to search across all my memories by natural-language query and get ranked results with provenance (who wrote, when, what confidence), so that I can trust what the brain returns.

### P1 — fast-follow within 60 days of GA

10. **As a team admin**, I want Linear, Notion, and Granola/Fireflies connectors, so that all major decision artifacts ingest automatically.
11. **As a user**, I want a web UI showing a timeline of memories, an entity graph, and a chat-over-memory interface, so that non-technical teammates can use the brain.
12. **As any user**, I want conflicting decisions to be detected and surfaced for resolution (supersede / merge / both-stand), so that the brain stays coherent over time.
13. **As a team admin**, I want confidence to decay by bucket type (decisions decay slowly, observations fast), so that stale context gets de-weighted automatically.
14. **As a compliance officer**, I want per-subject deletion that cascades through embeddings and caches, so that DPDP/GDPR erasure requests are mechanically satisfiable.

### P2 — explicit v2

15. **As a user**, I want to share anonymized learnings cross-org, so that the brain compounds across the customer base. (Architectural P2 — opt-in, requires consent flow.)
16. **As a user**, I want voice-note ingestion, so that I can write memories hands-free. (Architectural P2 — multi-modal track.)
17. **As a team admin**, I want fine-tuned per-org classifiers that learn what *we* call a decision, so that quality keeps improving. (Architectural P2 — eval infra dependency.)
18. **As a developer**, I want an SDK in Python, TypeScript, and Go, so that I can build vault-mem integrations into my own agents.

---

## 6. Functional Requirements

### 6.1 Core memory engine (OSS, MIT)

**P0**

- **Storage**: Markdown source-of-truth at `~/vault-mem/<location>/<bucket>/<id>.md`, where `location ∈ {inbox, memory, archive}` and `bucket ∈ {decisions, observations, learnings, todos, entities, questions, summaries}`.
- **Memory schema (frontmatter required)**:
  - `id` (string, content-addressed hash)
  - `type` (enum: 7 buckets)
  - `title` (string, required)
  - `project` (string, lowercase slug)
  - `tags` (string[])
  - `confidence` (float 0–1)
  - `created`, `updated` (ISO 8601)
  - `status` (enum: active / archived / superseded)
  - `supersedes` (id reference, optional)
- **Read-side index**: Postgres + pgvector, derived from markdown via async indexer. Rebuildable from markdown at any time.
- **CQRS guarantees**: write-latency ≤ 50ms (file write); read-your-writes via in-memory pending queue; eventual consistency to index ≤ 2s p99.
- **Search**: hybrid (BM25 / FTS5 + pgvector cosine, Reciprocal Rank Fusion). Filters: project, type, status, tags, date range.
- **MCP server**: tools `memory.write`, `memory.read`, `memory.search`, `memory.context`, `memory.promote`. STDIO + HTTP transports.
- **Keeper daemon**: scheduled job (default: every 6h) that promotes inbox → memory after 24h dwell + quality checks. Existing behavior; do not regress.

**P1**

- Conflict detection on write (same project, same entity, semantically-opposed decisions → flag for resolution).
- Confidence decay function configurable per bucket type.
- Entity-graph projection: `memory.graph(entity_id)` returns neighborhood subgraph.

**P2**

- Multi-modal blob storage (images, audio attachments) referenced from markdown.
- Federated brains (read across multiple vaults with permission scoping).

### 6.2 Skills-file exporter (OSS, MIT) — **demo asset**

**P0**

- `vault-mem export-skill <project> --target=claude|cursor|windsurf|generic` produces a deployable skill bundle:
  - `SKILL.md` summarizing the project, entities, conventions
  - `references/decisions.md`, `references/learnings.md`, `references/entities.md`
  - `description.yaml` matching target's plugin schema
- Refresh: `--watch` flag re-emits on memory writes; or scheduled job ≥ daily.
- Determinism: same input vault produces byte-identical output (modulo timestamps).

**P1**

- Custom templates per org.
- Direct push to claude.ai skills, Cursor MCP registry, Windsurf agent config (auth-permitting).

### 6.3 Ingestion connectors (Vault Cloud, commercial)

**P0**

- **Slack connector**: read from designated channels, classify message → {decision-candidate, observation, noise}, write candidates to inbox. Human-in-the-loop confirm before promotion to memory.
- **GitHub connector**: ingest PR descriptions, merged-issue threads, repository README diffs. Classify and write to inbox.

**P1**

- Linear connector (issues, comments, project status updates)
- Notion connector (databases + page updates)
- Granola / Fireflies / Gong connector (meeting transcripts → decisions extracted)
- Gmail connector (decision-bearing email threads)
- Generic webhook ingester

**P2**

- Salesforce, HubSpot, Zendesk (CS / support memory)
- ERP / billing systems (financial decisions)

### 6.4 Multi-tenancy & access (Vault Cloud)

**P0**

- Org → Workspace → Project → Memory hierarchy
- Roles: Owner, Admin, Editor, Reader; per-project ACLs
- SSO: Google + Microsoft (SAML); magic-link fallback
- Audit log: every read, write, search, export — immutable, exportable
- Per-org Postgres tenant (logical isolation via `org_id` + RLS); dedicated tenants for Enterprise tier

**P1**

- SCIM provisioning
- Self-hosted Vault Cloud (single-binary deploy + Postgres) for Enterprise
- Per-memory ACL overrides

### 6.5 Web UI (Vault Cloud)

**P0**

- Auth + workspace switcher
- Memory list view with filters (project / type / tags / date)
- Memory detail view (markdown render, provenance, edit, supersede)
- Manual write form
- Search bar with hybrid results

**P1**

- Timeline view (memories chronologically by project)
- Entity-graph view (D3 / Mermaid)
- Chat-over-memory (RAG with citations)
- Conflict resolution UI
- Skills-file preview & one-click export
- Connector configuration

### 6.6 Eval harness (OSS + Vault Cloud telemetry)

**P0**

- Define `evals/` directory: gold-set Q&A pairs per project
- `vault-mem eval run <project>` reports answer accuracy, citation precision, recall
- CI integration: regression test on every memory engine change

**P1**

- Cross-org benchmark (opt-in): anonymized accuracy comparison
- Per-connector precision/recall reporting (Slack classifier accuracy, etc.)
- Confidence calibration plots

---

## 7. Architecture

### 7.1 High-level

```
┌─────────────────────────────────────────────────────────────┐
│   Agents (Claude, Cursor, Windsurf, custom)                 │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP (stdio / HTTP)
┌────────────────────────▼────────────────────────────────────┐
│   Vault-mem core (OSS, MIT)                                 │
│  ┌──────────────────────┐   ┌─────────────────────────────┐ │
│  │  Write path          │   │  Read path                  │ │
│  │  → Markdown file     │   │  → Hybrid search            │ │
│  │  → Indexer (async)   │   │  → Context bundle (budget)  │ │
│  │  → Keeper daemon     │   │  → Graph queries (P1)       │ │
│  └──────────────────────┘   └─────────────────────────────┘ │
│                                                             │
│  Source of truth: ~/vault-mem/**/*.md                       │
│  Read index: Postgres + pgvector (or SQLite + sqlite-vec    │
│  for self-host single-user)                                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│   Vault Cloud (commercial)                                  │
│  • Multi-tenant Postgres on Supabase                        │
│  • Connectors (Slack / GitHub / Linear / Notion / meetings) │
│  • Web UI (Next.js)                                         │
│  • Auth (Supabase + SSO)                                    │
│  • Audit log (immutable, append-only)                       │
│  • Skills-file CDN (markdown + index per project)           │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Architectural decisions

| Decision | Choice | Why |
|---|---|---|
| Source of truth | Markdown files in user-owned directory | Portability, auditability, no-lock-in moat, AI-skill-file-compatible |
| Read index | Postgres + pgvector (cloud) / SQLite + sqlite-vec (self-host single-user) | Hybrid search at scale; reproducible from markdown |
| Hosting (cloud) | Supabase (managed Postgres + auth + RLS) | DPDP-compatible, fast to ship, India/EU residency available |
| Backend language | TypeScript (MCP server + indexer + connectors) | MCP SDK maturity, ecosystem |
| Frontend | Next.js + shadcn/ui | Fast, conventional, agent-aware |
| Vector embedding | Voyage `voyage-3` or OpenAI `text-embedding-3-small` (configurable) | Best cost/quality ratio; both DPDP-friendly with right region |
| Classifier (Slack→decision) | Claude Haiku 4.5 with prompt + gold-set eval; fine-tune only if accuracy ceiling hit | Lowest infra burden, highest current quality |
| License (core) | MIT | Maximum distribution, dev trust |
| License (cloud + connectors + UI) | Proprietary | Commercial gate; aligns with engineer-installs / buyer-pays |

### 7.3 Data model (Postgres, simplified)

```sql
-- Tenancy
orgs(id, name, billing_plan, created_at)
workspaces(id, org_id, name, slug)
projects(id, workspace_id, slug, name, retention_policy)
users(id, email, primary_org_id, sso_provider, created_at)
memberships(user_id, org_id, role)
project_access(user_id, project_id, role)

-- Memory
memories(
  id text primary key,           -- content-addressed
  project_id uuid,
  bucket text,                   -- decision/observation/...
  title text,
  body text,                     -- markdown body
  status text,                   -- active/archived/superseded
  supersedes text,
  confidence float,
  tags text[],
  created_at, updated_at,
  source jsonb,                  -- {connector, ref_id, ref_url}
  written_by_user_id uuid,
  written_by_agent text          -- if agent-authored
)

-- Index
memory_chunks(
  memory_id text,
  chunk_idx int,
  body text,
  embedding vector(1024),
  tsv tsvector
)

-- Audit
audit_log(id, org_id, user_id, action, target_id, payload, created_at)

-- Eval
eval_sets(id, project_id, name, questions jsonb)
eval_runs(id, eval_set_id, run_at, accuracy float, results jsonb)
```

### 7.4 MCP surface (stable contract)

| Tool | Description | Status |
|---|---|---|
| `memory.write` | Append a new memory; returns id. Required: `title`. Strong: `type`, `project`, `tags`, `confidence`. | Live |
| `memory.read` | Fetch one memory by id. | Live |
| `memory.search` | Hybrid query with filters; returns ranked results. | Live |
| `memory.context` | Token-budgeted bundle for a project, with optional `query` for semantic-led ranking. | Live |
| `memory.promote` | Force-promote inbox → memory (rare; keeper auto-handles). | Live |
| `memory.supersede` | New decision that replaces an older one; old is marked superseded. | P0 — new |
| `memory.graph` | Return entity neighborhood. | P1 |
| `memory.export_skill` | Produce skill bundle for target agent runtime. | P0 — new |
| `memory.eval_run` | Run eval set; report accuracy. | P1 |

---

## 8. Success Metrics

### Leading indicators (track from week 1)

| Metric | Definition | 30-day target | 90-day target |
|---|---|---|---|
| OSS installs | GitHub clones + `npm install` + Homebrew installs | 1,000 | 5,000 |
| GitHub stars | github.com/ashishdhiman/vault-mem | 200 | 1,000 |
| Active self-hosted instances | Telemetry ping with opt-out | 100 | 500 |
| Cloud signup → first memory written | % of signups who write within 24h | 40% | 60% |
| Cloud activation: 10 memories + 1 connector configured | Within 7 days | 25% | 40% |
| Agent reads per active project per day | proxy for "is this actually used?" | 20 | 50 |

### Lagging indicators (evaluate at 90 / 180 days)

| Metric | Definition | 90-day target | 180-day target |
|---|---|---|---|
| Paying design partners | $100+/mo or signed LOI | 3 | 10 |
| Week-4 retention (cloud free tier) | % of week-1 actives still active week 4 | 50% | 65% |
| Net revenue retention (paying) | % MRR retained + expanded | — | 110% |
| Eval harness accuracy on golden set | Avg answer accuracy across DP brains | 70% | 85% |
| Connector precision (Slack→decision classifier) | True positive rate on annotated samples | 75% | 90% |
| Inbound integration requests | Agent framework authors asking to integrate | 3 | 15 |

### Quality gate before YC application

- Ship demo: raw Slack channel → 30s later → Claude answers a real project question with cited memories. **Must work live with zero prep.**
- 3 paying or LOI'd design partners.
- ≥ 1,000 OSS users.
- Eval harness reporting ≥ 70% accuracy on 3 design-partner gold sets.

---

## 9. Pricing & Packaging

| Tier | Price (₹/$ monthly) | Includes | Target persona |
|---|---|---|---|
| **OSS / Self-host** | Free | Full core, single workspace, SQLite index, MCP server, skills-file exporter | Dev personal use |
| **Cloud Free** | ₹0 / $0 | 1 workspace, 3 users, 500 memories, 1 connector, Web UI | Solo founder, small team trial |
| **Team** | ₹1,650 / $20 per user/mo | Unlimited workspaces & memories, 3 connectors, full UI, audit log (30d), eval harness | 5–25 person AI-forward teams |
| **Business** | ₹4,100 / $50 per user/mo | All connectors, SSO, audit log (1y), conflict resolution UI, priority support, DPDP DPA | 25–100 person ops-heavy teams |
| **Enterprise** | Custom | Self-host option, SCIM, dedicated tenant, SLA 99.9%, on-prem connectors, India residency | Regulated industries, 100+ people |

**Pricing principles**
- OSS never gets crippled. Self-hosters get *all* core features. Cloud sells convenience, integrations, and team scale.
- Per-user pricing aligns with how knowledge work scales; capacity pricing punishes the right behavior (writing more memories).
- Annual prepay discount: 20%.

---

## 10. Open Questions

| # | Question | Blocking? | Owner |
|---|---|---|---|
| 1 | Embedding model lock-in: configurable per-org, or fixed? | Blocking | Engineering — week 1 |
| 2 | Should keeper daemon auto-classify writes into buckets, or only humans/agents? | Non-blocking | PM — week 4 |
| 3 | Brand name for the commercial product — keep "vault-mem", or rename? | Blocking before OSS launch | Founder + 2 trusted advisors |
| 4 | Pricing currency: USD primary or ₹ primary for India tier? | Non-blocking | Founder — week 6 |
| 5 | Cross-org anonymized learnings (P2) — opt-in default or opt-out default? | Non-blocking, architectural | Legal + PM — before P2 |
| 6 | Skills-file exporter: support OpenAI assistants / generic JSON, or Claude/Cursor/Windsurf only at v1? | Non-blocking | PM — week 3 |
| 7 | Self-hosted Vault Cloud — is it BSL or proprietary? | Non-blocking | Founder — month 4 |
| 8 | When (and how) to start collecting telemetry on OSS installs without harming dev trust? | Blocking before OSS launch | Engineering + community |

---

## 11. Timeline & Milestones

| Week | Deliverable | Owner |
|---|---|---|
| **0 (current)** | PRD approved, vault-mem decisions logged | Ashish |
| **1–2** | Multi-tenant Postgres rewrite (Supabase): orgs, workspaces, projects, RLS, SSO via Supabase Auth | Eng |
| **3** | OSS repo public at `github.com/ashishdhiman/vault-mem` under MIT; landing page live | Eng + design |
| **3–4** | Slack connector + decision classifier (Claude Haiku 4.5) + inbox-to-memory promotion UX | Eng |
| **5** | Skills-file exporter (`vault-mem export-skill`) — first public demo asset | Eng |
| **6–7** | Web UI v1 (Next.js + shadcn/ui): list, detail, search, manual write, connector config | Eng |
| **8** | Eval harness + 3 design-partner gold sets seeded | PM |
| **8–9** | GitHub + Linear connectors | Eng |
| **9–10** | 3 design partners fully onboarded with paying tier or LOI | Founder |
| **11** | Conflict-resolution UI + supersede flow | Eng + design |
| **12** | YC S26 application submitted with 1-min video demo | Founder |
| **+30 days** | Public Vault Cloud launch | All |
| **+60 days** | Notion + meeting-tool connectors GA | Eng |
| **+90 days** | First paid customer renewal | Founder |

**Hard deadlines**
- YC S26 application close: **2026-09-30**
- Public OSS announcement (Hacker News, Reddit r/LocalLLaMA, Show HN): **2026-08-30**

---

## 12. Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Thesis is crowded.** Mem.ai, Glean, Notion AI, Granola, every YC W26/S26 AI startup pitches "memory." | High | Differentiate on (a) markdown durability, (b) typed bucket ontology, (c) skills-file export — none of which competitors do. Make these the headline. |
| 2 | **Slack→decision classifier precision <80%** → inbox fills with noise → users abandon | High | Inbox-to-memory always human-confirmed in v1. Promote auto-classification to default only after classifier hits 90% on 3 design-partner gold sets. |
| 3 | **Markdown-CQRS consistency edge cases** confuse users ("I wrote it, why isn't it in search?") | Medium | Pending-write queue + read-your-writes in MCP; explicit "indexing..." state visible in UI. |
| 4 | **Open-core boundary drift**: community demands connectors be OSS | Medium | Hold the line publicly: core = MIT, connectors = commercial, no exceptions. Document the rule in the README on day 1. |
| 5 | **AWS / hyperscaler reselling Vault Cloud once it's popular** | Low (year 1), High (year 3) | Stay MIT in year 1 — distribution > defense. Re-evaluate BSL only after 10K+ users. |
| 6 | **DPDP / GDPR per-subject erasure complexity** in markdown + embeddings | High | Design erasure pipeline in week 1, not week 12. Test on every release. |
| 7 | **Founder bandwidth split across Frozo + kincare + vault-mem** | High | Decide before YC application whether vault-mem becomes the lead bet. If yes, freeze Frozo at maintenance. |
| 8 | **Embedding cost balloons at scale** | Medium | Cache aggressively; recompute only on memory change; use cheaper model below quality threshold. |
| 9 | **No design partner converts to paying** by week 10 | Medium | Pre-line up 8–12 candidates in week 0; convert in batches with clear pilot terms. |
| 10 | **Eval harness fails to find regressions** because gold sets too small | Medium | Require ≥ 50 questions per design-partner project; add adversarial questions monthly. |

---

## 13. Appendix A — Glossary

| Term | Definition |
|---|---|
| **Memory** | A single typed, durable, markdown-backed record. Has frontmatter, body, provenance. |
| **Bucket** | One of 7 memory types: decision, observation, learning, todo, entity, question, summary. |
| **Project** | Lowercase slug grouping memories (e.g. `kincare`, `frozo`, `vault-mem`). Roughly 1 project ≈ 1 product/initiative. |
| **Workspace** | Container for multiple projects under one tenant org. |
| **Inbox** | Holding location for new/agent-written memories before keeper promotion. |
| **Keeper** | Background daemon that promotes inbox → memory after dwell + quality checks. |
| **Skills file** | Bundle of markdown + metadata produced by `export-skill`, consumable by Claude/Cursor/Windsurf as a plugin/skill. |
| **CQRS** | Command Query Responsibility Segregation; here: markdown is write-side source-of-truth, Postgres is read-side index. |
| **Supersede** | A new memory marks an older one as no longer current; old is retained for audit. |
| **Provenance** | The source of a memory: who/what wrote it (human, agent, connector), when, with what confidence. |

## 14. Appendix B — Competitive landscape (one-line each)

- **Mem.ai** — consumer notes with AI overlay. No agent-native MCP; no typed ontology; closed.
- **Glean** — enterprise search. Search-first not memory-first; closed; expensive.
- **Notion AI** — RAG over Notion. Locked to Notion as substrate; not portable.
- **Granola / Fireflies / Gong** — meeting capture. We *consume* from them; not competitors.
- **Obsidian / Logseq** — personal markdown notes. Manual, no agent loop, no team mode.
- **LangChain Memory / mem0** — agent memory libraries. SDK-level, not a product; no UI / connectors / multi-tenancy.
- **PostgresML / Supabase pgvector** — infra primitives. We build on these, we're not them.

## 15. Appendix C — One-line YC application drafts

- **1-liner:** *Vault-mem turns scattered company knowledge into an executable skills file every AI agent can use.*
- **50-word version:** *Every company runs on tribal knowledge in Slack threads and people's heads — and AI agents can't use any of it. Vault-mem captures decisions, observations, and learnings as durable markdown memories, then exports them as a refreshing skills file Claude/Cursor/Windsurf can drop in. Open-source core, hosted cloud.*
- **Demo video premise (60s):** Live Slack channel with three decisions made in five minutes. Cut to Claude on the side. Ask Claude a question about the project. Watch it answer with cited memories that did not exist at the start of the video.

---

*End of PRD v1.0 — 2026-05-13*
