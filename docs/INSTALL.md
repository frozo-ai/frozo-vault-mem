# Install guide

Full installation from a fresh checkout to running vault-mem against Claude Code, Claude Desktop, and the keeper daemon.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node | 20 LTS or newer | https://nodejs.org or via `nvm`/`fnm` |
| pnpm | 9.x | `npm install -g pnpm` |
| Python | 3.12+ | https://www.python.org or `pyenv install 3.12` |
| uv | 0.4+ | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| git | any modern | system package manager |
| macOS | 13+ recommended | the launchd plist is macOS-specific (Linux works for the script; systemd unit needed) |

Verify all four:

```bash
node --version && pnpm --version && python3 --version && uv --version
```

## 1. Clone and build

```bash
git clone https://github.com/frozo-ai/frozo-vault-mem.git
cd frozo-vault-mem
pnpm install
pnpm --filter @vault-mem/mcp build
cd packages/keeper && uv sync && cd ../..
```

The first `pnpm install` may take a couple of minutes (downloads `better-sqlite3`, `@xenova/transformers`, `@lancedb/lancedb` — each ships native binaries for the major platforms; if a platform is unsupported it falls back to compiling from source which takes longer).

## 2. Materialize a vault

```bash
node packages/mcp/bin/vault-mem-mcp init           # creates ~/vault-mem/
node packages/mcp/bin/vault-mem-mcp doctor         # 9/9 PASS
```

Optional: `--target /custom/path` to put the vault somewhere else, `--git` to `git init` the new vault for version-controlled backups.

The vault contains a sample `decision` memory under `memory/decisions/` so the indexes are non-empty on first server start.

## 3. Configure your MCP client(s)

### Claude Code

```bash
claude mcp add --scope user vault-mem \
  -e VAULT_MEM_PATH=$HOME/vault-mem \
  -- node $(pwd)/packages/mcp/bin/vault-mem-mcp
```

Verify:

```bash
claude mcp list | grep vault-mem
# vault-mem: node /…/packages/mcp/bin/vault-mem-mcp - ✓ Connected
```

The next Claude Code session will have the 5 tools available.

### Claude Desktop (macOS)

1. Quit Claude Desktop fully (`⌘Q`).
2. Open `~/Library/Application Support/Claude/claude_desktop_config.json` in your editor.
3. Inside the top-level `mcpServers` object (create it if missing), add:
   ```json
   "vault-mem": {
     "command": "node",
     "args": ["/absolute/path/to/frozo-vault-mem/packages/mcp/bin/vault-mem-mcp"],
     "env": {
       "VAULT_MEM_PATH": "/Users/<you>/vault-mem"
     }
   }
   ```
4. Save the file. Use absolute paths — Claude Desktop does not expand `~`.
5. Reopen Claude Desktop. The 5 tools should appear in the available-tools list.

If Claude Desktop reports a tool-name validation error, ensure you're on vault-mem 0.1.0 or newer (tools were renamed from `memory.X` → `memory_X` for MCP spec compliance).

### Other MCP clients

vault-mem speaks plain stdio MCP. Any client that can spawn a child process and exchange JSON-RPC messages over stdin/stdout works. Server name: `vault-mem-mcp`. Protocol: as supported by `@modelcontextprotocol/sdk` 1.0.x. Cursor, custom Python clients, etc. should all work — adapt the registration to that client's config format.

## 4. (Optional but recommended) Schedule the keeper daemon

The keeper runs maintenance ops every 30 min: triage inbox memories to canonical, decay confidence on aging observations, archive expired memories, and recompute auto-link neighbors.

### macOS via launchd

1. Edit `ops/keeper/com.vaultmem.keeper.plist` — replace every `REPLACE_USER` with your username and the placeholder repo path with your actual checkout location. Confirm `uv` lives at `~/.local/bin/uv` (or update the plist).
2. Install:
   ```bash
   cp ops/keeper/com.vaultmem.keeper.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.vaultmem.keeper.plist
   ```
3. Trigger an immediate first run:
   ```bash
   launchctl start com.vaultmem.keeper
   tail -n 30 ~/Library/Logs/vault-mem-keeper.err.log
   ```
4. Verify the daemon is registered:
   ```bash
   launchctl list | grep vaultmem
   # -    0    com.vaultmem.keeper      (PID dash, exit 0, label)
   ```

The daemon will run every 30 min from then on, surviving reboots.

### Linux (systemd)

A systemd unit file is not yet shipped. The keeper script itself works fine on Linux. PR welcome — the unit should call `uv run --directory /path/to/packages/keeper python -m vault_mem_keeper run --vault $VAULT_MEM_PATH` on a 30-min timer.

### pm2 (cross-platform alternative)

```bash
pm2 start ./packages/keeper/bin/run-keeper.sh \
  --cron-restart "*/30 * * * *" \
  --no-autorestart \
  --name vault-mem-keeper
```

## 5. Verify everything

```bash
# MCP server health
node packages/mcp/bin/vault-mem-mcp doctor --vault ~/vault-mem
# Should print 9 PASS lines.

# Keeper health
cd packages/keeper && uv run python -m vault_mem_keeper doctor --vault ~/vault-mem
# Should print 4 PASS lines (vault_root, config_file, schemas_load, keeper_config).

# Tail the audit log to watch agents/keeper write
node packages/mcp/bin/vault-mem-mcp tail-audit --vault ~/vault-mem -n 20
```

In Claude Code or Claude Desktop, ask the agent to write a decision memory. Then ask it to search for that decision. If both round-trip cleanly, the install is complete.

## Backing up the vault

The vault is plain markdown. The recommended backup is git:

```bash
cd ~/vault-mem
git init
git add .
git commit -m "init"
git remote add origin git@github.com:<you>/private-vault.git    # private repo strongly recommended
git push -u origin main
```

A daily push as a launchd or cron job keeps your memories backed up off-machine. The `_system/audit.log` is a convenient bisect target if anything ever looks wrong.

## Uninstall

```bash
# 1. Disable the keeper daemon (if installed)
launchctl unload ~/Library/LaunchAgents/com.vaultmem.keeper.plist
rm ~/Library/LaunchAgents/com.vaultmem.keeper.plist

# 2. Remove the MCP server registration from Claude Code
claude mcp remove vault-mem -s user

# 3. (Claude Desktop) Edit ~/Library/Application Support/Claude/claude_desktop_config.json
#    and remove the "vault-mem" entry from mcpServers. Restart Claude Desktop.

# 4. (Optional) Delete the vault and the cloned repo
rm -rf ~/vault-mem
rm -rf /path/to/frozo-vault-mem
```

The HuggingFace model cache at `~/.cache/huggingface/` is shared across other ML projects — don't delete it unless you're sure.
