# Runbook — Erasure of subject data from git history

**Audience:** Operators handling DPDP/GDPR per-subject erasure requests
on a vault that's backed up via `git push` (the OSS default).
**Status:** Operator action required; the cascade itself does not touch
git history.

This document explains why git history rewrites are intentionally out
of scope for the automated `vault-mem-keeper erase-subject` cascade,
and walks through the manual steps when an erasure request requires
purging the subject's data from past commits too.

---

## TL;DR

1. The cascade erases the **current state** of the vault (`.md` files,
   embeddings, FTS rows, subject-mentions index). It does **not** touch
   `.git/`.
2. If you `git push` your vault to a remote (private or public), the
   subject's data persists in git history until you rewrite it.
3. Rewriting git history breaks every clone of the repo. It is
   destructive in a way our automated cascade refuses to be.
4. The operator must decide per request whether history rewriting is
   required, and run `git filter-repo` manually.
5. For the vault-mem **code repo** (`github.com/frozo-ai/frozo-vault-mem`),
   this is moot — code commits never contain memory bodies. This runbook
   only applies to **personal vault repos** (your `~/vault-mem/` if
   you've `git init`-ed it).

---

## Why the cascade refuses to do this for you

Three reasons:

1. **Rewriting history breaks all clones.** Anyone with a clone of the
   vault repo (a backup, a machine you sync to, a team member) keeps
   the unrewritten history forever. Force-pushing the rewrite doesn't
   help — their local `git pull` will see divergent history and either
   fail or silently re-introduce the unrewritten commits.
2. **Force-push of rewritten history is irreversible.** A bug in the
   filter command can lose work. We won't run that command without
   you knowing exactly what you're approving.
3. **DPDP/GDPR doesn't strictly require it.** Regulators distinguish
   "live data we process" from "audit/forensic records." A reasonable
   interpretation is that current vault state must be cleansed; history
   that's locked to a private backup repo and which the subject cannot
   access does not constitute ongoing processing. Talk to a lawyer
   about your specific jurisdiction.

---

## Decision tree

```
Did you `git push` the vault to a remote?
├── NO  → no action needed. Cascade alone is sufficient.
└── YES → is the remote (a) public or (b) shared with > yourself?
         ├── NO (private, solo-access remote)
         │       → consider if your backup retention policy makes
         │         rewriting unnecessary. If yes, skip. If no,
         │         proceed to "Procedure" below.
         └── YES → REWRITE REQUIRED before next backup push.
                  Proceed to "Procedure" below.
```

---

## Procedure (`git filter-repo`)

**Prerequisite:** install `git-filter-repo`. It is NOT bundled with git
itself.

```bash
# macOS:
brew install git-filter-repo
# Linux:
pipx install git-filter-repo
```

### 1. Run the cascade first

Make sure the live vault is clean before rewriting history. The order
matters — if you rewrite history while pending mentions still exist,
you'll have to repeat.

```bash
vault-mem-keeper erase-subject email:priya@example.com \
  --reason "DPDP SAR ticket #42" \
  --vault ~/vault-mem
vault-mem-keeper audit-subject email:priya@example.com \
  --vault ~/vault-mem
# Expect: status=clean, exit 0.
```

### 2. Identify the affected files

The cascade moves erased memories to `archive/erased/<id>.md` with a
redacted body. Anything in `archive/erased/` is the result of an
erasure cascade — its body is already `(body redacted per erasure
request)`, but **the history still contains the un-redacted body**
from before the cascade.

```bash
cd ~/vault-mem
git log --all --diff-filter=D --name-only --pretty=format: \
  | sort -u | grep -E "(memory|inbox)/.*\.md$"
# Lists every .md file ever deleted across history. The ones with
# matching archive/erased/<id>.md stubs are erasure candidates.
```

### 3. Rewrite

```bash
cd ~/vault-mem

# (Recommended) Take a snapshot of the current repo before rewriting:
git clone --mirror . ~/vault-mem-backup-pre-erasure-$(date +%Y%m%d).git

# Run the filter. This removes the named paths from EVERY commit:
git filter-repo --invert-paths \
  --path memory/decisions/mem_2026-05-19_aaaaaa.md \
  --path inbox/observations/mem_2026-05-19_bbbbbb.md \
  --path archive/erased/mem_2026-05-19_aaaaaa.md
```

⚠ The `archive/erased/<id>.md` stub itself contains only hashed
metadata + `(body redacted per erasure request)`. It's safe to keep
in history as evidence the cascade ran. We typically only filter the
ORIGINAL paths (`memory/<type>/`, `inbox/<type>/`), leaving the stub
intact for audit purposes. Run a quick `git log -p -- <stub-path>` to
confirm the stub has no PII before deciding.

### 4. Force-push

```bash
git push --force origin --all
git push --force origin --tags
```

### 5. Coordinate with anyone who has a clone

Send a heads-up to anyone with a backup or sync of this repo:

> The repo history was rewritten on YYYY-MM-DD to fulfil a DPDP/GDPR
> erasure request. Please delete your local clone and re-clone:
>
> ```
> rm -rf ~/vault-mem
> git clone <remote> ~/vault-mem
> ```
>
> Do NOT `git pull` — that will re-introduce the rewritten commits.

### 6. Audit log entry

The cascade already emitted `subject_erased` + `subject_erased_complete`
audit ops with hashed subject id. Append a manual note about the
history rewrite so future audits show the full picture:

```bash
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"v\":1,\"op\":\"git_history_rewritten\",\"subject_id_hash\":\"<copy from cascade audit entry>\",\"operator\":\"$(whoami)\",\"note\":\"git filter-repo on <date>; clones notified\"}" \
  >> ~/vault-mem/_system/audit.log
```

---

## What this runbook does NOT cover

- **External backup drives**: weekly backups to USB / external SSD per
  CLAUDE.md operating context. The operator is responsible for either
  re-creating the backup post-cascade or maintaining a retention
  policy that ages out older snapshots. Cascade doesn't reach into
  Time Machine, Arq, restic, or any other backup tool.
- **Cloud product (`vault-cloud`)**: that repo handles erasure via the
  `erase_subject` Supabase RPC plus point-in-time backup retention. See
  the Cloud-side runbook (separate repo) when it lands.
- **Exported skills bundles**: any `vault-mem-mcp export-skill` output
  on disk is outside the vault's control. Re-export after erasure;
  delete prior exports.
- **Indexed search caches outside the vault**: e.g. an Obsidian plugin
  that maintains its own search cache. Operator's responsibility.

---

## References

- Spec: [`docs/superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md`](../superpowers/specs/2026-05-19-dpdp-erasure-cascade-design.md) — §8 explicitly calls out git history as out of automated scope.
- `git filter-repo`: <https://github.com/newren/git-filter-repo>
- DPDP Act 2023: <https://www.meity.gov.in/digital-personal-data-protection-act-2023>
- GDPR Article 17 ("Right to erasure"): <https://gdpr-info.eu/art-17-gdpr/>
