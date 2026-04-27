# Vault-Mem

Personal memory vault for Ashish's agent stack. See the project repo's [`vault-mem-prd.md`](https://github.com/ashishdhiman/frozo-vault-mem/blob/main/vault-mem-prd.md) for context.

## Layout

- `memory/<type>/` — promoted, canonical memories
- `inbox/<type>/` — newly-written memories awaiting review/promotion
- `archive/` — decayed or superseded memories
- `projects/` — human-curated project pages
- `_system/` — schemas, templates, audit log, FTS index (gitignored)

## Schema additivity rule

Schema changes from v0.1 onward are **additive only** (new optional fields).
Renames, removals, and type-narrowing require a versioned migration.

## Memory types

`decision` · `observation` · `todo` · `learning` · `summary` · `entity` · `question`

See `_system/schema/` for the JSON Schema definitions.
