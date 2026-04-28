# Contributing to vault-mem

vault-mem started as a one-person weekend build to solve a concrete problem: too many AI agents, each with their own siloed memory, no shared context between sessions. It shipped as a personal-use tool, ran solo for a few weeks, and is now public for anyone who wants the same thing. Contributions — bug fixes, new memory types, platform support, docs improvements — are welcome. Keep scope tight: this is a local-first tool and should stay that way.

## Code of conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). Please read it before participating.

## Development setup

**Prerequisites**

1. Node 20+ (`node --version`)
2. pnpm 9+ (`pnpm --version`; install via `npm i -g pnpm`)
3. Python 3.12+ (`python3 --version`)
4. uv 0.4+ (`uv --version`; install via `curl -LsSf https://astral.sh/uv/install.sh | sh`)
5. macOS or Linux (Windows untested; PRs welcome)

**Clone and install**

```bash
git clone https://github.com/frozo-ai/frozo-vault-mem.git
cd frozo-vault-mem
pnpm install
```

**Install Python dependencies**

```bash
cd packages/keeper && uv sync && cd ../..
```

**Run TypeScript tests**

```bash
pnpm --filter @vault-mem/mcp test
```

**Run Python tests**

```bash
cd packages/keeper && uv run pytest
```

**Run typecheck**

```bash
pnpm --filter @vault-mem/mcp typecheck
```

**Run Python lint**

```bash
cd packages/keeper && uv run ruff check src tests
```

All four must be green before a PR is ready to merge.

## Branch conventions

- `main` is the integration branch. It is always in a releasable state.
- Feature branches: `feat/<topic>`
- Bug fix branches: `fix/<topic>`
- Documentation: `docs/<topic>`

PRs are squash-merged so the commit history on `main` stays clean and bisectable.

## PR expectations

- All tests must pass (`pnpm --filter @vault-mem/mcp test`, `uv run pytest`).
- Typecheck and ruff must be clean.
- Add tests for any behavior change. Bug fixes should include a test that would have caught the bug.
- Use **Conventional Commits** style for commit messages:
  - `feat(mcp): add memory_summarize tool`
  - `fix(keeper): triage skips inbox entries with missing title`
  - `docs: document CONFIG.md knobs`
  - `chore: bump lancedb to 0.14`
  - `test: cover hybrid search with empty semantic index`
  - `refactor: extract embedder factory into module`
- One concern per PR. Small, focused diffs are much easier to review and revert if needed.

## Architecture

Before diving in, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The three-actor model (you / agents / keeper sharing one folder) and the inbox-first write flow are load-bearing constraints — changes that break this mental model need a discussion first.

## Adding a new memory type or schema field

Schema additivity applies: **new fields must be optional, with defaults**. Never remove a field from an existing schema, never rename, never change a field's type in a breaking way. Existing vault files may not have the new field and must continue to load without errors.

If you need to add a memory type:

1. Add the type slug to `MemoryType` in `packages/mcp/src/vault/paths.ts`.
2. Add its JSON Schema in `vault-template/_system/schema/`.
3. Add decay/TTL defaults in `packages/mcp/src/tools/write.ts`.
4. Add it to the keeper's decay config in `packages/keeper/src/vault_mem_keeper/ops/decay.py`.
5. Document it in README.md and docs/ARCHITECTURE.md.

See `docs/origin/` for the migration philosophy that informed these rules.

## Reporting bugs / requesting features

Use the issue templates in [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/). Please fill them out fully — especially the `doctor` output and recent audit log tail for bug reports. Issues that skip the template will be closed with a pointer back here.

Security vulnerabilities: do **not** open a public issue. See [SECURITY.md](SECURITY.md).
