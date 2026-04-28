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
