#!/usr/bin/env bash
# Convenience wrapper for pm2 / launchd / scripts that prefer a single
# shell command. Sources $VAULT_MEM_KEEPER_ENV or ~/.config/vault-mem/keeper.env
# if present so secrets (OPENROUTER_API_KEY / ANTHROPIC_API_KEY) live
# outside the launchd plist.
set -euo pipefail

ENV_FILE="${VAULT_MEM_KEEPER_ENV:-$HOME/.config/vault-mem/keeper.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$(dirname "$0")/.."
exec uv run python -m vault_mem_keeper run "$@"
