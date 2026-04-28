# Configuration reference

Every knob in `<vault>/_system/config.yaml`, what it controls, and what the defaults are.

The MCP server reads the top-level fields; the keeper reads the `keeper:` section. Extra fields are tolerated (server validation uses `additionalProperties: true`), so you can add comments or extra keys without breaking startup.

## Top-level

| Field | Type | Default | Notes |
|---|---|---|---|
| `vault_version` | string | `"0.1"` | Bumped only on breaking vault-format changes. |
| `schema_version` | string | `"0.1"` | Tracks frontmatter schema family. Memories carry their own `schema_version` field. |
| `default_agent` | string | `"human"` | Used when neither the MCP `clientInfo` nor the tool args supply an `agent` value. |
| `inbox_routing` | enum (`"always"`) | `"always"` | All MCP `memory_write` calls land in `inbox/` first. |
| `vault_id` | string (ULID) | (auto) | Stamped at `init` time; used by future federation features. |

## `fts:`

| Field | Type | Default | Notes |
|---|---|---|---|
| `index_path` | string | `_system/index.sqlite` | Relative paths resolve against the vault root. Absolute paths used as-is. |
| `rebuild_on_startup` | boolean | `false` | When `true`, the server drops and re-populates the FTS index on every start. Useful for debugging schema changes. |

## `audit:`

| Field | Type | Default | Notes |
|---|---|---|---|
| `log_path` | string | `_system/audit.log` | Append-only JSONL. Same path resolution as FTS index. |

## `keeper:` — Python daemon ops

The keeper validates this section with pydantic. Missing fields fall back to defaults; missing the entire `keeper:` block also works (defaults everywhere).

### `keeper.triage`

Inbox → memory promotion.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Disable to manually-only manage promotion. |
| `min_age_minutes` | integer | `1440` | Minimum age (since `created`/`updated`) before auto-promote. 1440 = 24h. |
| `min_confidence` | number 0..1 | `0.7` | Memories below this confidence never auto-promote, regardless of age. |
| `promote_immediately_if_human_reviewed` | boolean | `true` | If a memory has `human_reviewed: true`, skip the age gate and promote on next run. |

### `keeper.link`

Top-K semantic-neighbors writer.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `top_k` | integer | `5` | Neighbors per memory in `_system/links.jsonl`. |
| `min_similarity` | number 0..1 | `0.55` | Documented but not yet enforced in 0.1.0 (see TROUBLESHOOTING). |
| `cross_type_allowed` | boolean | `true` | When `false`, decisions only link to other decisions, etc. |
| `rebuild_full_each_run` | boolean | `true` | Truncate-and-rewrite `links.jsonl` every run. Cheap at vault sizes <5k. |

### `keeper.decay`

Confidence erosion.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `decay_amount_per_period` | number | `0.05` | Confidence delta per completed period. |
| `rates.decision` | integer or `null` | `null` | Period in days. `null` = never decay. |
| `rates.observation` | integer | `30` | Lose `0.05` confidence every 30 days. |
| `rates.learning` | integer | `60` | |
| `rates.todo` | integer or `null` | `null` | Todos manage themselves via `todo_status`. |
| `rates.summary` | integer or `null` | `null` | Summaries are derived data; not decayed. |
| `rates.entity` | integer or `null` | `null` | Permanent. |
| `rates.question` | integer or `null` | `null` | Permanent until resolved. |

The keeper tracks `last_decay_at` in each memory's frontmatter and advances it by completed periods only — partial-period progress carries forward across long downtimes.

### `keeper.archive`

Move-to-archive policy.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `archive_below_confidence` | number 0..1 | `0.3` | Memories with confidence below this floor archive on next run. |
| `respect_ttl_days` | boolean | `true` | Honor each memory's per-frontmatter `ttl_days`. |

## Environment variables

These override config-file defaults at runtime:

| Var | Effect |
|---|---|
| `VAULT_MEM_PATH` | Override the vault root. Same priority as `--vault` flag. |
| `VAULT_MEM_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Default `info`. |
| `VAULT_MEM_KEEPER_LOG_LEVEL` | Same range, applies to the Python keeper. |
| `HF_HOME` | HuggingFace cache directory (where the MiniLM model is downloaded). |
| `TRANSFORMERS_CACHE` | Same; takes precedence over `HF_HOME` if both set. |

## Editing config

After editing `_system/config.yaml`, restart the MCP server (next Claude Code/Desktop session does this automatically) and the keeper (`launchctl kickstart -k gui/$UID/com.vaultmem.keeper`). The vault config is read at startup; there's no live reload.
