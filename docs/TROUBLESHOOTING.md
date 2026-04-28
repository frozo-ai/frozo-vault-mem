# Troubleshooting

Common issues and fixes. If something here doesn't help, open an issue with the output of `vault-mem-mcp doctor`, the last 20 lines of `~/vault-mem/_system/audit.log`, and the steps to reproduce.

## "Tool name validation error" in Claude Desktop

**Symptom:** Claude Desktop logs show:

```
tools.N.FrontendRemoteMcpToolDefinition.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'
```

**Cause:** Pre-0.1.0 builds used dotted tool names (`memory.write`). Claude Desktop's MCP validator rejects dots; only `[a-zA-Z0-9_-]` are allowed.

**Fix:** Upgrade to vault-mem 0.1.0 or newer (tool names are now `memory_write`, etc.). Rebuild and restart Claude Desktop:

```bash
git pull
pnpm --filter @vault-mem/mcp build
# Then ⌘Q Claude Desktop and reopen.
```

## "MCP server says `dist/` not found"

**Symptom:** When the MCP server spawns, you see:

```
vault-mem-mcp: failed to load — did you run 'pnpm --filter @vault-mem/mcp build'?
```

**Fix:** Build the package:

```bash
pnpm --filter @vault-mem/mcp build
```

The bin shim is small on purpose; it imports the compiled `dist/index.js`. After a fresh clone or `git pull` that touched TS sources, you need to rebuild.

## "Keeper doesn't run on schedule"

**Symptom:** You scheduled the keeper via launchd but no entries appear in the audit log every 30 min.

**Diagnose:**

```bash
launchctl list | grep vaultmem
# Expect a single line: -    0    com.vaultmem.keeper

tail -n 50 ~/Library/Logs/vault-mem-keeper.err.log
tail -n 50 ~/Library/Logs/vault-mem-keeper.out.log
```

**Common causes:**

- **`uv` not at the path the plist expects.** Run `which uv` in your shell. If it's not `~/.local/bin/uv`, update the plist's first `<string>` line.
- **Repo path in the plist is wrong.** The plist must point at `…/packages/keeper`, not the repo root.
- **Plist not loaded with `-w`.** Run `launchctl unload`, then `launchctl load -w …`. The `-w` flag persists the override across reboots.
- **Permission denied on the log files.** `~/Library/Logs/` should already exist; if not, `mkdir -p` it.

Force-fire to test:

```bash
launchctl kickstart -k gui/$UID/com.vaultmem.keeper
```

## "Indexes look stale after a manual edit in Obsidian"

**Symptom:** You edited a `.md` file in Obsidian. `memory_search` doesn't find the new content.

**Cause:** The MCP server's chokidar watcher reconciles the indexes on every file event — but the watcher only runs while the server is alive. If the watcher is offline (no Claude session active), changes pile up; the next server start picks them up via the populate pass.

**Fix:** Either start a Claude Code/Desktop session (any new MCP server spawn re-populates if the index counts have drifted), or run:

```bash
node packages/mcp/bin/vault-mem-mcp reindex --vault ~/vault-mem
```

`reindex` always works as a manual reset.

## "Search returns nothing for a query I know matches"

**Symptom:** A query that should hit a memory comes back empty.

**Things to check:**

- **Exact-id queries.** Use `mode: "fts"` for an id like `mem_2026-04-28_a8f3c0`. Hybrid mode treats hyphens via FTS5 special operators and may miss.
- **Hyphenated phrases.** `"freshly-shipped vault-mem MCP"` is sanitized into `freshly* shipped* vault* mem* mcp*` (prefix-match each token). If your terms are heavily punctuated, simpler queries work better.
- **Filters too narrow.** The `location: "memory"` default for `memory_context` excludes inbox. Pass `include_inbox: true` to also search fresh writes.
- **Index actually empty.** Run `node packages/mcp/bin/vault-mem-mcp doctor`. If `row_count_match` shows zero rows, run `reindex`.

## "First write after server start takes 1-2 seconds"

**Cause:** The embedder model loads lazily on the first call to `memory_write` or semantic-mode `memory_search`. Subsequent calls reuse the loaded pipeline (~50ms).

If this is a problem (e.g., a script doing many fresh writes back-to-back from cold starts), you can pre-warm by issuing a throwaway `memory_search` with `mode: "semantic"` first.

## "Lance / SQLite / better-sqlite3 errors at install time"

**Symptom:** `pnpm install` fails on a native dependency.

**Common causes:**

- **Node version too old.** `better-sqlite3` 11.x requires Node 18+; this project requires Node 20.
- **No prebuilt binary for your platform.** The package falls back to compiling from source; needs a C++ toolchain (`xcode-select --install` on macOS, `build-essential` on Debian/Ubuntu).
- **lancedb on Apple Silicon.** First install of `@lancedb/lancedb` may compile native bits; expect 30–60 seconds on the first run.

If install hangs longer than 5 minutes, check `pnpm install --reporter=ndjson | tee install.log` and open an issue with the log.

## "I want to nuke and start over"

The vault is plain markdown — destroying it is straightforward but irreversible:

```bash
# Disable the keeper first
launchctl unload ~/Library/LaunchAgents/com.vaultmem.keeper.plist 2>/dev/null

# Delete the vault
rm -rf ~/vault-mem

# Re-init
node packages/mcp/bin/vault-mem-mcp init --target ~/vault-mem
```

The audit log inside the deleted vault goes with it. If you want to preserve the log before nuking, copy `~/vault-mem/_system/audit.log` somewhere safe first.

## "How do I back up my vault?"

The vault is git-friendly by design. The fastest path:

```bash
cd ~/vault-mem
git init
git add .
git commit -m "init"
git remote add origin git@github.com:<you>/private-vault.git    # PRIVATE repo
git push -u origin main
```

Then a daily cron job pushing the latest:

```cron
0 22 * * * cd ~/vault-mem && git add -A && git commit -m "daily snapshot" && git push 2>>~/Library/Logs/vault-backup.err.log
```

The `_system/index.sqlite` and `_system/embeddings.lance/` are gitignored (rebuildable from `.md`), so commits stay light.

## "How do I migrate to a new machine?"

```bash
# Old machine: push the vault to a private git repo (see above)

# New machine
git clone https://github.com/frozo-ai/frozo-vault-mem.git
cd frozo-vault-mem
pnpm install
pnpm --filter @vault-mem/mcp build
cd packages/keeper && uv sync && cd ../..

git clone git@github.com:<you>/private-vault.git ~/vault-mem
node packages/mcp/bin/vault-mem-mcp doctor --vault ~/vault-mem
node packages/mcp/bin/vault-mem-mcp reindex --vault ~/vault-mem
```

Re-register MCP clients (Claude Code: `claude mcp add ...`; Claude Desktop: edit `claude_desktop_config.json`). Re-install the launchd plist. Done.

## "An agent wrote something wrong; how do I fix it?"

You have three escape valves:

1. **Edit the `.md` file directly in Obsidian.** The watcher reconciles indexes within a few seconds.
2. **Move the bad memory.** From `inbox/<type>/` or `memory/<type>/`, move it to `archive/`. The audit log records the original write so you can audit how it got there.
3. **Delete the file.** The watcher will remove it from the indexes on next event. The audit log retains the original `op: "write"` entry, but the content is gone.

vault-mem doesn't try to be tamper-evident — you own the data and can rewrite history. The audit log helps explain *what happened*, not enforce immutability.

## Still stuck?

Open an issue with:

- vault-mem version (commit SHA from `git log --oneline -1`)
- OS + version
- MCP client (Claude Code, Claude Desktop, etc.)
- Output of `node packages/mcp/bin/vault-mem-mcp doctor`
- Output of `cd packages/keeper && uv run python -m vault_mem_keeper doctor`
- Last 20 lines of `~/vault-mem/_system/audit.log` (sanitize anything private)
- Steps to reproduce

Use the bug template at [.github/ISSUE_TEMPLATE/bug_report.yml](../.github/ISSUE_TEMPLATE/bug_report.yml).
