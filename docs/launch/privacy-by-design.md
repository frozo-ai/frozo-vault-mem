# Privacy by Design — blog post draft

**Status:** draft. Intended to publish alongside the 2026-08-30 OSS
announcement (decided per spec §9 Q6). Posting venues: blog +
cross-post to Hacker News / r/privacy / r/LocalLLaMA. The technical
spec at `docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md`
is the canonical reference; this post is the public-facing narrative.

---

## Title

> Privacy by design in vault-mem: what right-to-erasure actually means for AI memory

Alt titles tried:

- _Why we published our DPDP erasure architecture_ (good for HN, narrow
  for r/privacy)
- _Forgetting in vault-mem — how the GDPR "right to erasure" became 1,000 lines of code_ (concrete but long)

---

## Hook (lede)

The right-to-erasure clause in DPDP and GDPR is a single sentence in
the regulation. Implementing it in a memory layer used by AI agents
is a thousand lines of code, two SQLite indexes, a cascade with
explicit failure modes, a human-gated approval queue, and a runbook
covering the parts the cascade refuses to touch.

We published all of it before we needed to. Here's why.

---

## What vault-mem stores

Vault-mem is a local-first markdown memory layer for AI agents.
Decisions, observations, learnings — written by humans or by agents
during conversations, persisted as `.md` files in `~/vault-mem/`,
searchable by any MCP-aware client (Claude Code, Cursor, custom
agents).

A memory looks like:

```markdown
---
id: mem_2026-05-14_c2bc8c
type: decision
title: GitHub connector v0.1 shipped
project: vault-cloud
tags: [vault-cloud, github, connectors]
source.author: github:priya
created: 2026-05-14T05:47:49.538Z
...
---

PR #18 from Priya. Picks up issues + merged PRs ...
```

Two things matter here:

1. **The frontmatter contains structured identifiers** — `github:priya`
   in tags, `source.author: github:priya` from the GitHub connector.
2. **The body contains free-text mentions** of people who may or may
   not also be in the structured fields.

When Priya later asks her employer "please delete all data you hold
about me," both kinds of references need to go. The hard problem is
the second kind — prose is not mechanically rewritable without losing
meaning.

## What "erasure" must mean to be legitimate

A real erasure cascade has to cover:

1. **The markdown file** — easy: rewrite or move.
2. **The embedding** — a vector that encodes the body. Even after the
   `.md` is gone, the vector can leak content via nearest-neighbor
   search. Must drop the row in LanceDB / pgvector.
3. **The full-text search index** — SQLite FTS5 tokens, Postgres
   `tsvector`. Must drop the row.
4. **The subject-to-memory index** — our own derived "who is
   mentioned where" table. Must prune the subject.
5. **The audit log** — paradox. We are legally required to keep an
   audit trail of the erasure itself. But the trail names the subject.
   We solve this by **hashing**: the audit log stores `sha256(subject_id)`,
   never plaintext. The original identifier lives in a separate
   controller-private log under our retention policy.
6. **The proposals queue** — where pending erasure approvals live.
   Once applied or rejected, status flips and the queue moves on.
7. **The gatekeeper log** — same logic if a separate transport exists
   (we currently use the proposals queue itself; Telegram bot would
   add its own scrub-on-cascade).

Things the cascade **refuses** to do automatically:

8. **Rewrite git history.** If you `git push` the vault to a backup
   remote, the history contains pre-cascade bodies. Rewriting that
   history breaks every clone of the repo. Force-pushing the rewrite
   is irreversible. We refuse to take that action without explicit
   operator decision, and we ship a runbook for when and how to do
   it manually: [`docs/runbooks/erasure-git-history.md`](../runbooks/erasure-git-history.md).
9. **Rewrite prose.** If a memory body says "I disagreed with Priya
   on the launch date," there is no mechanical way to scrub Priya's
   name without destroying meaning. We flag these as
   `manual_redaction_required` and emit a proposal for human review.
   We DO NOT call an LLM to "redact this nicely." Legal-grade
   correctness can't depend on a probabilistic rewrite.

Refusing to do these is not a feature gap. It's a property of the
design. Auto-doing them would create worse outcomes: silently
destructive history rewrites, or LLM-mediated prose surgery that
leaves the regulator's request half-met in a non-auditable way.

## Six design decisions we resolved on day one

Before writing a line of cascade code, we resolved six open questions
in the spec and committed them to the public record:

| Q | Decision | Why |
|---|---|---|
| Hard delete or 30-day grace? | **Hard delete.** | DPDP "right to erasure" is conceptually immediate. The safety net belongs in `--dry-run`, not in post-erasure recovery. |
| `--reason` required? | **Required for non-dry runs.** | Regulators prefer documented reasons. One extra flag is cheap. |
| `manual_redaction_required` exit code? | **Exit 2** = partial success / needs human attention; **exit 1** reserved for cascade bugs. | CI/cron distinguishes "machine part broke" from "human part queued." |
| Cloud rate limit on `erase_subject`? | **10 calls/hour per org admin.** | Most realistic DPDP volumes are <1 SAR/quarter. Limit exists to mitigate compromised-admin abuse. |
| Self-host without gatekeeper? | **TTY confirm fallback for CLI; proposals queue for the MCP tool.** | Single-user self-host shouldn't require Telegram setup. The MCP tool still never silently runs the cascade. |
| Publish this design publicly? | **Yes, with the OSS announce.** | Privacy by design is a marketing asset. Differentiates from competitors who don't publish their erasure architecture. |

That last decision is why you're reading this. We could have kept the
spec private. We could have shipped the cascade and let users
reverse-engineer the guarantees. Both would be normal industry
practice. Neither builds the trust this category needs.

## What a self-host operator gets, today

```bash
# Verify the subject is present (dry-run)
vault-mem-keeper erase-subject email:priya@example.com \
  --dry-run

# Run the cascade
vault-mem-keeper erase-subject email:priya@example.com \
  --reason "DPDP SAR ticket #42"

# Confirm clean
vault-mem-keeper audit-subject email:priya@example.com
# → status=clean, exit 0
```

Exit code 2 means prose mentions remain that need human editing.
Exit code 3 means an index drifted (run `vault-mem-mcp reindex`).
Exit code 1 means we have a bug — file an issue at
`github.com/frozo-ai/frozo-vault-mem/issues` with the audit log
snippet.

For agent-driven erasure (an MCP tool call from Claude Code or any
other client), the agent gets back `{status: "pending_approval"}`
and the operator approves the request via
`vault-mem-keeper review --filter subject_erase_request`. The
cascade never fires without that explicit human approval.

## What we deliberately don't do

Three things people sometimes ask for that we won't ship:

1. **Encrypt-and-throw-key.** Some systems "delete" by encrypting
   data and throwing away the key. We rejected this — embeddings
   leak content via search even before the key matters, and key
   management becomes an entirely new attack surface.
2. **LLM-mediated body rewriting.** "Ask Claude to rewrite this
   memory without mentioning Priya." Rejected — too unreliable for
   a legal-grade pipeline. The OSS exposes `manual_redaction_required`
   proposals for human-driven prose review instead.
3. **Bulk multi-subject erasure as the default API.** A single CLI
   that erases hundreds of people at once is the kind of feature
   that causes irreversible mistakes. Bulk is a v2 RPC in `vault-cloud`
   with explicit attestation and rate limits; not in the OSS today.

## Where we're going

- **Cloud parity.** The `vault-cloud` product (proprietary multi-tenant
  layer on Supabase) implements the same cascade against Postgres +
  pgvector via an `erase_subject(subject_id, reason)` RPC, gated by
  the 10/hour rate limit and RLS-enforced org admin role. Same audit
  shape, same hashing discipline.
- **Telegram transport.** The proposals queue is the gate today. A
  Telegram bot becomes an alternate delivery channel for the same
  queue — operator approves on their phone, cascade fires on the
  vault host. Not a rewrite; a transport plugin.
- **Eval gold sets that include privacy questions.** "Does the
  retrieval system surface erased memories?" should be a regression
  test. We ship a dogfood set for vault-mem itself; design partners
  get their own.

## Why publish all of this

Three reasons:

1. **Trust isn't transitive.** "We comply with GDPR" is a marketing
   claim. "Here is our cascade in 1,047 lines of code, our verifier
   in 200 lines, our runbook for the parts the cascade refuses to
   automate, and our hashed-audit-log invariant enforced at the
   TypeScript type level" is a verifiable claim.
2. **Other people writing memory layers should not have to do this
   work twice.** This category is going to grow. The DPDP +
   right-to-erasure problem isn't going away. If our cascade saves
   someone else two weeks, that's two weeks of better infrastructure
   for everyone.
3. **It's a recruitment surface.** People who care about privacy by
   design are the people we want building this with us.

If you want to talk about any of the above:

- File an issue: `github.com/frozo-ai/frozo-vault-mem/issues`
- Security/privacy disclosure: `SECURITY.md`
- DM on Twitter: @<HANDLE>

Read the full design at [`docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md`](../superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md)
and the runbook at [`docs/runbooks/erasure-git-history.md`](../runbooks/erasure-git-history.md).

---

## Posting checklist

- [ ] Replace `@<HANDLE>` with the real Twitter handle.
- [ ] Confirm the public spec link survives the rename to whatever
      final URL the repo lives at by 2026-08-30.
- [ ] Cross-link from the main launch posts (`show-hn.md`,
      `reddit-localllama.md`, `twitter-thread.md`) so this isn't
      orphaned.
- [ ] Pre-pin a comment with the runbook link + a clear FAQ on
      git-history caveats. HN/Reddit commenters WILL ask about that.
- [ ] Add a screenshot of the audit log showing
      `subject_erased_complete` with hashed ids (proves the
      no-plaintext claim).
