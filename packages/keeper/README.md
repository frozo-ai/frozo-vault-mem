# vault-mem-keeper

Python hygiene daemon for the Vault-Mem vault. Runs every 30 min via launchd; performs
inbox triage, auto-linking, confidence decay, and archival.

See `docs/superpowers/specs/2026-04-28-vault-mem-phase-3-design.md` for the design.

## Develop

```bash
uv sync
uv run pytest
uv run ruff check src tests
```

## Run

```bash
uv run python -m vault_mem_keeper run --vault ~/vault-mem
uv run python -m vault_mem_keeper run --vault ~/vault-mem --dry-run
uv run python -m vault_mem_keeper status --vault ~/vault-mem
uv run python -m vault_mem_keeper doctor --vault ~/vault-mem
```

## Review contradiction proposals (Phase 5)

When the `contradict` op flags a likely conflict between two memories, the
proposal lands in `_system/proposals.jsonl` for human review. Walk the queue:

```bash
uv run python -m vault_mem_keeper review --vault ~/vault-mem
uv run python -m vault_mem_keeper review --vault ~/vault-mem --severity high
uv run python -m vault_mem_keeper review --vault ~/vault-mem --project myapp
```

Per proposal: `a`ccept · `r`eject · `s`kip · `v`iew (opens in `$EDITOR`) ·
`n`otes · `q`uit. Accepting a `supersede_M_with_N` proposal archives the
loser, marks it `status: superseded`, and appends to the winner's
`supersedes` list. All actions append to the audit log (`proposal_applied` /
`proposal_rejected` / `proposal_note`).

### Cost ceiling (Phase 5)

The `contradict` and `summarize` ops make Anthropic API calls (Haiku for the
pre-filter, Sonnet for the judge + summaries). The keeper enforces a soft
monthly USD cap from `keeper.budget.monthly_usd_cap` in
`_system/config.yaml` (default: `$5.00`). Each call is logged to
`_system/budget.jsonl`. When the cap is reached, the keeper short-circuits
remaining LLM calls and writes a `budget_exceeded` audit entry — the other
ops (triage / link / decay / archive) still run normally.

An LLM API key must be in the keeper's environment for Phase 5 ops to run.
Otherwise `contradict` and `summarize` skip gracefully and the rest of the
pass is unaffected.

### Providers (Anthropic native vs OpenRouter)

The keeper auto-picks the LLM provider from env vars:

| Env var (priority order)   | Provider used                                             |
| --------------------------- | --------------------------------------------------------- |
| `OPENROUTER_API_KEY`        | OpenRouter via OpenAI-compatible `/chat/completions`      |
| `ANTHROPIC_API_KEY`         | Native Anthropic SDK (`/v1/messages`)                     |
| (neither)                   | Phase 5 ops skip; triage/link/decay/archive still run     |

If `OPENROUTER_API_KEY` is set, the keeper auto-prefixes bare model names
with `anthropic/` (so `claude-haiku-4-5` becomes `anthropic/claude-haiku-4-5`).
Set already-prefixed names in `keeper.contradict.haiku_model` /
`sonnet_model` if you want a different vendor or a specific OpenRouter
slug (e.g. `anthropic/claude-sonnet-4.5`).

OpenRouter's `usage.cost` is honored when present; falls back to the
internal Anthropic price table otherwise. Soft cap enforcement is
identical across providers.

## Schedule via launchd (macOS)

See `ops/keeper/com.vaultmem.keeper.plist` at the repo root. Customize the absolute
paths and copy to `~/Library/LaunchAgents/`, then `launchctl load -w ...`.

## Install via launchd (macOS)

```bash
# 1. Edit ops/keeper/com.vaultmem.keeper.plist:
#    - Replace REPLACE_USER (3 places) with your username
#    - Replace REPLACE_WITH_OPENROUTER_KEY with your real key
#      (or move the key to ANTHROPIC_API_KEY if you prefer native).
#    DO NOT commit your real key — the plist is in git as a template only.
# 2. Copy and load:
cp ops/keeper/com.vaultmem.keeper.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.vaultmem.keeper.plist
# 3. Trigger an immediate run to verify:
launchctl start com.vaultmem.keeper
# 4. Check the log:
tail -f ~/Library/Logs/vault-mem-keeper.err.log
```

If you'd rather keep the key out of `~/Library/LaunchAgents/` entirely
(safer for backups + Time Machine), use a wrapper script and source a
`.env` file:

```bash
# Create ~/.config/vault-mem/keeper.env (chmod 600):
echo 'OPENROUTER_API_KEY=sk-or-...' > ~/.config/vault-mem/keeper.env
chmod 600 ~/.config/vault-mem/keeper.env

# Then point the plist at packages/keeper/bin/run-keeper.sh instead of uv
# directly; the wrapper script sources keeper.env before exec.
```

To remove:

```bash
launchctl unload ~/Library/LaunchAgents/com.vaultmem.keeper.plist
rm ~/Library/LaunchAgents/com.vaultmem.keeper.plist
```

## Install via pm2

```bash
pm2 start ./bin/run-keeper.sh --cron-restart "*/30 * * * *" --no-autorestart \
  --name vault-mem-keeper -- --vault $HOME/vault-mem
```
