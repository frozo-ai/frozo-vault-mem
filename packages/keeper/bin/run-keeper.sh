#!/usr/bin/env bash
# Convenience wrapper for pm2 / scripts that prefer a single shell command.
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run python -m vault_mem_keeper run "$@"
