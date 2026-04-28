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

## Schedule via launchd (macOS)

See `ops/keeper/com.vaultmem.keeper.plist` at the repo root. Customize the absolute
paths and copy to `~/Library/LaunchAgents/`, then `launchctl load -w ...`.

## Install via launchd (macOS)

```bash
# 1. Edit ops/keeper/com.vaultmem.keeper.plist — replace REPLACE_USER and paths
# 2. Copy and load:
cp ops/keeper/com.vaultmem.keeper.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.vaultmem.keeper.plist
# 3. Trigger an immediate run to verify:
launchctl start com.vaultmem.keeper
# 4. Check the log:
tail -f ~/Library/Logs/vault-mem-keeper.err.log
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
