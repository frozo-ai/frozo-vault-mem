# Vault-Mem DPDP / GDPR Per-Subject Erasure Cascade — Design

**Status:** Approved, ready for implementation
**Date:** 2026-05-19 (decisions resolved same-day)
**Owner:** the maintainer
**PRD:** [`vault-mem-PRD.md`](../../../vault-mem-PRD.md) — Risk #6 (High severity), §10 Open Q #6
**Related:**
- [`2026-04-27-vault-mem-mcp-design.md`](2026-04-27-vault-mem-mcp-design.md) — vault layout + audit log
- [`2026-04-27-vault-mem-phase-2-design.md`](2026-04-27-vault-mem-phase-2-design.md) — LanceDB embedding store
- [`2026-04-28-vault-mem-phase-3-design.md`](2026-04-28-vault-mem-phase-3-design.md) — keeper ops + archive flow
- [`2026-05-01-vault-mem-phase-5-design.md`](2026-05-01-vault-mem-phase-5-design.md) — proposals + audit op types

**Branch base:** `main` (post `e6b2bd8` CLAUDE.md rewrite)

---

## 1. Context & purpose

Vault-mem v0.1 was personal-use only — the user was the sole subject and the sole data controller, so the right-to-erasure question was implicit ("`rm`"). PRD v1.0 changes that:

- **Vault Cloud** stores memories about *other* people — Slack authors, GitHub PR authors, mentioned colleagues — across multi-tenant orgs.
- The OSS vault now ingests connector data that names third parties, so a self-hoster's vault contains personal data of subjects who are not them.

Under **DPDP (India)** and **GDPR (EU)**, those subjects have a right to request erasure of their personal data. The controller (Vault Cloud org, or self-host operator) is on the hook to:

1. Identify all data tied to the subject.
2. Erase it from the live store and every derived index.
3. Produce evidence the erasure happened.
4. Do all the above within a regulatory deadline (DPDP: "reasonable time"; GDPR: 1 month, extendable).

**Why this is hard in vault-mem specifically:**

- Memories are **markdown** with free-form bodies — subjects can be referenced unstructured ("met with Priya about the launch").
- Memories are **append-only by design** (PRD §6.1) — the canonical write path doesn't delete.
- The **embedding vector** in LanceDB/pgvector is a derived representation that can leak content even after the source `.md` is gone.
- The **FTS index** holds tokens.
- The **audit log** records the original write — itself a record about the subject.
- **Git history** (the OSS backup story) is immutable by design — `git filter-repo` rewrites are destructive to clones.

This spec defines a cascade-deletion pipeline that handles items 1–3 above with explicit calling-out of what's out-of-scope (item 4 SLA, git history rewrites, weekly backup drives).

**Done-when:** A self-host user can run `vault-mem erase-subject email:priya@example.com --reason "DPDP SAR"` and afterwards:
- No `.md` file in the vault contains `priya@example.com` in any structured field.
- No embedding row in LanceDB exists for any affected memory id.
- No FTS row in `_system/index.sqlite` exists for any affected memory id.
- An `audit.log` `subject_erased` entry exists with hashed subject id, affected count, reason, timestamp.
- A verification command (`vault-mem audit-subject`) returns clean.

Cloud parity follows the same model with Postgres `DELETE`/`UPDATE` cascades behind a Supabase RPC.

---

## 2. Scope

**In scope:**

- New CLI: `vault-mem erase-subject <subject-id> [--vault PATH] [--dry-run] [--reason TEXT]`
- New CLI: `vault-mem audit-subject <subject-id>` (verification / dry-run inspection)
- New MCP tool: `memory_erase_subject` (gated behind gatekeeper Telegram approval — never auto-callable from agent path)
- New keeper module: `subject_index.py` — maintains `_system/subjects.sqlite` mapping `subject_id → memory_id[]`
- Index population at write-time (MCP `memory_write` path) + bulk backfill via `vault-mem reindex-subjects`
- Cascade order: `.md` files → embeddings (LanceDB) → FTS (sqlite) → audit log (append + redact)
- Idempotent re-runs (running erase twice for the same subject must be safe)
- Audit-log entry for the erasure itself (`subject_erased` op type)
- Cloud counterpart: Supabase migration adding `subjects` + `subject_mentions` tables and a `erase_subject(text, text)` RPC with RLS
- Self-host parity: every OSS CLI also exists in Cloud admin UI (PRD §9 pricing principle)

**Out of scope (deferred or punted to the user):**

- Erasing git history. `git filter-repo` rewrites destroy all clones — document as user responsibility with a runbook in `docs/`. For Cloud, point-in-time backups are governed by separate retention policy (out of this spec).
- Pseudonymization mode (replace subject's data with anonymized stand-in but keep the memory). v1 is hard-delete or scrub-then-redirect-source only.
- LLM-driven free-text scrubbing ("rewrite this body to remove Priya's quoted statement"). Too unreliable for legal-grade correctness. Out-of-band human review required for prose redaction; this spec only handles structured fields.
- Bulk org-wide erasure (Cloud feature, v2 spec).
- Subject Access Requests (SAR) — read-side disclosure of "all data we hold about you." Different feature, different spec.
- Skills-file bundles previously exported via `export-skill` — the file is outside the vault once exported. Document as "you must re-export after erasure"; not automatable.
- Eval gold-set anonymization — gold sets in `vault-template/evals/` must be anonymized at authoring time. Add a CI lint, not part of erasure path. Tracked separately.
- Cross-org anonymized learnings (PRD §5 #15, P2) — not yet built; subject-isolation rules will go in that spec when it's drafted.
- Real-time SAR responses; we only do erasure here.

---

## 3. Subject identification model

The hardest part of erasure is "what counts as data about this subject?" Vault-mem uses a layered model: **structured first, unstructured best-effort**.

### 3.1 Canonical subject ids

A `subject_id` is a string in one of these forms:

| Prefix | Canonical form | Example |
|---|---|---|
| `email:` | `email:<lowercased-rfc5322>` | `email:priya@example.com` |
| `slack:` | `slack:<workspace_team_id>:<user_id>` | `slack:T0X1Y2Z3:U0A1B2C3` |
| `github:` | `github:<lowercased-login>` | `github:ashishdhiman` |
| `linear:` | `linear:<user_uuid>` | `linear:7f2b...e1d3` |
| `notion:` | `notion:<user_uuid>` | `notion:9c1f...4a2b` |
| `local:` | `local:<kebab-slug>` | `local:priya-anand` |

A single human may map to multiple subject ids (an email, a Slack id, a GitHub login). The CLI supports either:
- A single id → cascade for that id alone.
- A subject-bundle file: JSON listing all known ids for one person → cascade across all.

### 3.2 Where subject mentions live

| Source | Structured fields with subject ids | Free-text body |
|---|---|---|
| Slack ingest (vault-cloud) | `source.user` (slack id), `source.workspace` | yes |
| GitHub ingest | `source.author` (github login), `source.assignee` | yes |
| Linear ingest | `source.author_uuid`, `source.assignee_uuid` | yes |
| Notion ingest | `source.last_edited_by`, `source.created_by` | yes |
| Meeting connector | `source.attendees[]`, `source.organizer` | yes (transcript) |
| Human-written `entity` memory | `id`, `tags` (handles), body | yes |

The structured fields are deterministic; the body is not. v1 erasure handles structured fields **mechanically** and flags memories whose bodies need human review.

### 3.3 The subject-index

A new sqlite database `_system/subjects.sqlite` (self-host) or table `subject_mentions` (Cloud Postgres) maintains a many-to-many index:

```sql
CREATE TABLE subject_mentions (
  subject_id TEXT NOT NULL,        -- e.g. "slack:T0X:U0A"
  memory_id TEXT NOT NULL,         -- e.g. "mem_2026-05-19_f9b2b0"
  mention_kind TEXT NOT NULL,      -- "primary_subject" | "source_author" | "tag" | "body_match"
  field_path TEXT,                 -- e.g. "source.user", null for body_match
  created_at INTEGER NOT NULL,     -- unix ms
  PRIMARY KEY (subject_id, memory_id, mention_kind, field_path)
);
CREATE INDEX idx_subject ON subject_mentions(subject_id);
CREATE INDEX idx_memory ON subject_mentions(memory_id);
```

Populated by:

1. **`memory_write` path (MCP server)** — on every write, extract structured subject ids from `source.*` fields and `tags`, write rows to `subject_mentions`. Best-effort body scan for known subjects (deferred to keeper for cost — write-path stays ≤ 50ms per PRD §6.1 CQRS guarantee).
2. **Keeper `link` op** — body scan against known subject ids for `body_match` rows. Quick string match + word-boundary regex, not LLM-driven.
3. **One-time `vault-mem reindex-subjects`** — for legacy vaults (Phase 0–5 ones that predate this spec). Backfill via scanning all canonical memories.

### 3.4 What about names in prose?

A body that says "had coffee with Priya" doesn't auto-link to `email:priya@example.com` — that's an inference problem this spec refuses to handle mechanically. The user is responsible for either:
- Writing structured `entity` memories that link prose-names to canonical ids, OR
- Accepting that prose-only mentions may survive erasure and triggering manual review.

When the keeper detects a prose mention of a known entity's *display name* (`entity` memory's `title` or `tags`), it can offer a `subject_link` proposal in the existing `_system/proposals.jsonl` (Phase 5 machinery). Human approves → row added to `subject_mentions` as `mention_kind: body_match`.

This is a **proposal**, never auto-applied, exactly because legal-grade correctness requires human judgement.

---

## 4. Cascade order & atomicity

**The cascade order is deliberate.** It optimizes for "if anything fails mid-way, the rest can be reconstructed deterministically from the remaining state."

```
1. Look up subject_id → memory_id[] from subjects.sqlite (read-only)
2. For each memory_id, decide action: full-delete | scrub
3. Atomic step (per memory):
   a. Write new .md file content (or move .md to archive/erased/) — atomic via temp + fsync + rename
   b. Delete embedding row in LanceDB by memory_id
   c. Delete FTS row in _system/index.sqlite by memory_id
   d. Append to audit.log: subject_erased entry with affected memory_id
4. After all memories processed:
   e. Remove rows from subjects.sqlite for the erased subject_id
   f. Append final summary audit entry: subject_erased_complete (count, duration, hash of subject_id)
5. Run verify pass (next section) — fail loud if anything left behind.
```

**Why this order:**

- The `.md` file is the source of truth (PRD invariant). If we delete the index rows first and then the `.md` write fails, the index disagrees with reality and the next `reindex` would re-add the now-orphaned data. By writing `.md` first, the index is *behind* truth, which a `reindex` resolves correctly.
- Per-memory atomic is acceptable; subject-wide atomic isn't (no cross-file transaction in markdown vaults). Idempotency makes partial-failure safe to retry.
- Audit-log appends are last-per-memory but final for the cascade, so a crashed run leaves audit evidence that the cascade *started* even if it didn't complete.

### 4.1 Full-delete vs scrub

Decision rule per memory:

| Memory kind | Subject role | Action |
|---|---|---|
| `entity` where `entity.id == subject_id` or `tags ∋ subject_id` | primary | **Full delete** (move to `archive/erased/`, strip body) |
| Any memory where the subject is the `source.user` / `source.author` and the body is *about* the message they sent | source author | **Full delete** if the body quotes them directly; **Scrub source field + keep memory** if the memory is a synthesis that mentions multiple people |
| Memory where subject appears in `source.attendees[]` (meeting) | incidental | **Scrub source field**, keep memory |
| Memory body free-text mentions subject (body_match) | incidental | **Flag for human review** — do NOT auto-rewrite prose |

When the rule says "flag for human review," the cascade writes a proposal to `_system/proposals.jsonl` (Phase 5 format, new op type `manual_redaction_required`) and the erasure run completes with a non-zero exit code indicating "structured cascade complete, prose review outstanding." Regulators get the structured-cascade evidence immediately; human review follows.

### 4.2 Archive-vs-delete

"Full delete" in v1 means: move the `.md` to `archive/erased/<memory_id>.md` with body replaced by a stub:

```markdown
---
id: mem_2026-05-19_f9b2b0
type: archived
status: erased
erased_at: 2026-05-19T14:23:11Z
erasure_reason_hash: <sha256 of (subject_id + reason)>
original_type: decision
original_project: frozo
---

(body redacted per erasure request)
```

The stub keeps minimal metadata for our own audit-against-our-actions (regulators consistently distinguish "data about the subject" — which we delete — from "evidence of our compliance with their erasure request" — which we keep, hashed). Original_type and original_project preserve enough for our internal counts.

`status: erased` is a new value joining the existing `active | archived | superseded`. The keeper's `archive` op skips `erased` memories; the MCP `memory_search` filters them out by default.

---

## 5. Verification (`vault-mem audit-subject`)

After erasure (or as a standalone dry-run before erasure), `vault-mem audit-subject <subject-id>` answers: *is this subject still in the vault anywhere we can mechanically detect?*

Checks performed:

1. `subjects.sqlite` — any rows for `subject_id`?
2. Grep every `.md` body for the literal `subject_id` string (e.g. `slack:T0X:U0A`, `email:priya@example.com`).
3. Grep frontmatter (`source.*`, `tags`, `entity_id`) for `subject_id`.
4. LanceDB — any rows where `metadata.memory_id ∈ erased_set`?
5. `_system/index.sqlite` FTS — any rows where `memory_id ∈ erased_set`?
6. `_system/proposals.jsonl` — pending proposals referencing memories in `erased_set`?

Exit codes:
- `0` — clean
- `1` — structured leak (subject_id found in a structured field somewhere — bug in cascade, file a ticket)
- `2` — prose mention found — human review required, not a bug
- `3` — index inconsistency (subjects.sqlite or LanceDB drifted) — re-run `reindex` to fix

Output format: JSON with `{leaks: [...], proposals_pending: [...], summary: ...}` so it's machine-readable for a Cloud admin UI.

---

## 6. API surfaces

### 6.1 CLI

```bash
# Single subject id
vault-mem erase-subject email:priya@example.com --reason "DPDP SAR 2026-05-19"

# Subject bundle (multiple ids for one person)
vault-mem erase-subject --bundle priya.json --reason "DPDP SAR 2026-05-19"

# Dry-run shows what would be affected, no changes
vault-mem erase-subject email:priya@example.com --dry-run

# Verify after the fact
vault-mem audit-subject email:priya@example.com
```

Flags: `--vault PATH` (override `VAULT_MEM_PATH`), `--reason TEXT` (required for non-dry-run), `--no-confirm` (skip TTY confirm prompt for scripts), `--bundle PATH`.

### 6.2 MCP tool (gated)

```
memory_erase_subject(subject_id: string, reason: string)
```

**Gated**: this MCP tool requires gatekeeper Telegram approval *before* it executes (existing gatekeeper machinery from Phase 4) **when gatekeeper is configured**. An agent invoking this tool gets a `pending_approval` response with a Telegram message id; user approves on their phone; only then does the cascade run.

**Self-host fallback (Q5 resolved):** when no gatekeeper is configured (common in single-user self-host), the cascade falls back to a blocking TTY confirm prompt. Scripts can pass `--no-confirm` to skip the prompt — at which point the operator is explicitly accepting the unrecoverable action without any approval gate. We never *silently* skip the gate.

This is the only destructive MCP tool that requires an approval gate. Other destructive ops (archive, supersede) already require human review via the proposals queue — erasure is the same pattern with stricter gating because the result is unrecoverable.

### 6.3 Cloud admin

Supabase RPC `erase_subject(subject_id text, reason text)` callable only by `org_admin` role. RLS enforces org-scoping (org A's admin can't erase from org B's memories). Web UI surfaces the action at `/admin/subjects/<id>` with a confirmation modal.

**Rate limit (Q4 resolved):** 10 calls per hour per org admin, enforced server-side in the RPC. Most realistic DPDP volumes are <1 SAR/quarter so the limit is non-binding for legitimate use; the rate limit exists to mitigate abuse via a compromised admin token. Bulk erasure (e.g. anonymizing a departed employee across hundreds of memories) waits for the v2 bulk feature with its own RPC + admin attestation.

Out of scope: the web UI design itself. This spec only nails the back-end contract.

---

## 7. Audit log additions

New op types in `_system/audit.log`:

| Op | Fields | Notes |
|---|---|---|
| `subject_index_build` | `subject_id`, `mention_count`, `mention_kinds` | Keeper-emitted on initial index build |
| `subject_mention_added` | `subject_id`, `memory_id`, `kind`, `field` | MCP write path |
| `subject_mention_removed` | `subject_id`, `memory_id` | Cascade-emitted |
| `subject_erased` | `subject_id_hash`, `memory_id`, `action` (`full_delete`/`scrub`), `reason_hash` | One per affected memory |
| `subject_erased_complete` | `subject_id_hash`, `count`, `duration_ms`, `verify_status` | One per cascade run |
| `manual_redaction_required` | `subject_id_hash`, `memory_id`, `field_path: "body"` | Flag for human review queue |

**Hashing decision:** `subject_id` is hashed with SHA-256 in audit entries (`subject_id_hash`), not stored as plaintext. The reasoning:

- The audit log is "data about us" (our compliance actions) and we keep it.
- But the audit log mentions the subject's identifier, which is "data about them."
- Hashing preserves audit utility (we can verify "yes we erased *this* request" by re-hashing the original subject id and matching) without retaining the identifier in plaintext after the fact.

`reason` is also hashed. The original `reason` text is recorded in a one-time `_system/erasure_requests.jsonl` (gitignored) that the controller is responsible for managing per their retention policy — separate from the audit log because it's controller-private.

---

## 8. Constraints, gotchas, and explicit non-promises

1. **Git history is immutable.** A `git filter-repo` rewrites every commit hash, breaks all clones, and is the user's responsibility. We provide a runbook in `docs/runbooks/erasure-git-history.md` (to be written alongside implementation). For the public OSS repo `frozo-ai/frozo-vault-mem`, this only matters for the *user's own vault* `git` push (memories aren't pushed to that repo — only code is). The Cloud product doesn't `git push` memories, so this is purely a self-host concern.
2. **Backups outside the vault.** Weekly external-drive backups (per CLAUDE.md operating context) are user-managed. Document erasure-from-backups as a manual step.
3. **Exported skill-files.** Once a `vault-mem export-skill` bundle is on disk somewhere, it's outside our control. Documented as "re-export after erasure to ensure downstream consumers don't re-ingest the erased subject."
4. **Telegram gatekeeper audit.** The gatekeeper bot's own audit (Telegram message ids, approval timestamps) lives in `_system/gatekeeper.log`. Erasure cascade must scrub subject id from that file too. Add to §4 cascade order as step 3.e: gatekeeper log scrub.
5. **Embedding model leakage.** A vector embedding is information-bearing. Once we delete the row from LanceDB, the embedding is gone — but if it was ever exported (Cloud → user dumps embeddings), it's out. v1: documented; v2: explore embedding deletion proofs (a hash-of-vector you can prove was removed).
6. **Keeper proposals queue.** Any pending `proposals.jsonl` entries referencing erased memories should be auto-resolved as `auto_resolved: target_erased`, not silently dropped.
7. **Concurrency.** A keeper run in progress while erasure is running can re-add a `subject_mention` row for an in-flight write. v1: acquire an exclusive flock on `_system/erasure.lock` for the duration of the cascade; MCP `memory_write` blocks on this lock briefly (≤ 50ms expected, ≤ 5s worst case). MCP server returns `423 Locked` if held longer.
8. **Test data.** All erasure tests use synthetic subject ids (`email:test-fake@example.test` etc.) — never real people.

---

## 9. Decisions (resolved 2026-05-19)

All six open questions resolved before implementation. Rationale captured in `mem_…` decision memory; summary below.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Hard delete.** No grace period. | DPDP "right to erasure" is conceptually immediate. Soft delete creates a window of continued processing that's hard to defend if challenged. Operator safety net belongs in the `--dry-run` flow + explicit TTY/gatekeeper confirm, not in post-erasure recovery. |
| 2 | **`--reason` is required for non-dry runs.** | Regulators consistently prefer documented reasons. Negligible ergonomic cost (one extra flag). Hash of the reason goes into the audit log; plaintext goes to controller-private `_system/erasure_requests.jsonl`. |
| 3 | **Exit code 2 = "partial success / needs human attention".** Exit 1 reserved for "broken/bug." | Structured cascade truly succeeded (the mechanical part of the regulator's ask is done); prose review is a human workflow that can run in parallel. CI/cron should distinguish "broken" from "needs human attention." |
| 4 | **Cloud rate limit: 10 calls/hour per org admin** on the `erase_subject` RPC. | Most realistic DPDP volumes are <1 SAR/quarter so the limit is non-binding for legitimate use. Exists to mitigate abuse via a compromised admin token. Bulk erasure (v2) gets a separate RPC + attestation flow. |
| 5 | **Self-host without gatekeeper: TTY confirm fallback.** `--no-confirm` flag for scripts. | Self-host is single-user 95% of the time; forcing gatekeeper raises adoption friction. If gatekeeper IS configured, it's used (not bypassed). We never *silently* skip the gate. |
| 6 | **Publish spec publicly with the 2026-08-30 OSS announcement.** | Privacy-by-design is a marketing asset that differentiates from Mem.ai/Glean/Notion-AI who don't publish their erasure architecture. Aligns with the opt-in-telemetry decision (already a public privacy stance). |

---

## 10. Implementation plan (high level — detailed plan in a separate doc post-approval)

Phase 1 — index foundation (1 week):

1. `subject_index.py` keeper module + sqlite schema.
2. MCP `memory_write` path emits `subject_mention_added` audit entries and writes index rows.
3. `vault-mem reindex-subjects` CLI for legacy backfill.
4. Tests: write a memory with `source.user`, verify index row appears. Write a memory mentioning a known entity name, verify keeper proposes a `subject_link`.

Phase 2 — cascade (1 week):

5. `vault-mem erase-subject` CLI with the cascade order from §4.
6. `vault-mem audit-subject` verification CLI.
7. New audit op types in TS `AuditEntry` union + Python emitters.
8. `archive/erased/` directory + status: erased frontmatter handling in MCP read path (filter from search).

Phase 3 — gating + gatekeeper integration (3 days):

9. `memory_erase_subject` MCP tool with gatekeeper hook (Phase 4 machinery).
10. Gatekeeper log scrub during cascade.

Phase 4 — Cloud parity (1 week, in `vault-cloud`):

11. Supabase migration: `subjects` + `subject_mentions` tables, RLS.
12. `erase_subject` RPC.
13. Admin UI flow at `/admin/subjects/<id>`.

Phase 5 — docs + announcement (2 days):

14. `docs/runbooks/erasure-git-history.md`.
15. README section on DPDP compliance.
16. CHANGELOG entry.
17. (Optional, founder call) Publish this spec as a public-facing privacy-by-design post.

**Total estimate:** ~3.5 weeks from approved spec to public-launch-ready. Comfortably inside the 30-day window between OSS launch (2026-08-30 target) and the +30-day Cloud launch.

---

## 11. Alternatives considered (rejected)

- **Tombstone-only model** (mark erased, don't delete content from `.md`). Rejected — fails DPDP "data minimisation" and a forensic read of the `.md` would recover the subject's data.
- **Encrypt-and-throw-key** (data stays, key is destroyed). Rejected — overkill for v1; embedding leakage still a problem; adds dependency on a key-management service.
- **LLM-driven prose redaction in cascade**. Rejected — too unreliable for legal-grade correctness; documented as future v2 work behind explicit human approval.
- **Bulk erase via SQL** (Cloud only). Rejected as the default path — single-subject cascade composes cleanly; bulk is a v2 ergonomic.
- **No subject-index, scan at erase time**. Rejected — O(vault) scan per request is too slow at Cloud scale (>1M memories per org target).

---

*End of design — 2026-05-19*
