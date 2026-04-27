# Vault-Mem MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 0 (vault scaffolding) and Phase 1 (TS MCP server with `memory.read`, `memory.write`, `memory.search`, `memory.promote`, plus `init`/`doctor`/`reindex`/`tail-audit` CLI subcommands) so Claude Code can read and write memories during a real session.

**Architecture:** Monorepo with pnpm workspace. `vault-template/` is committed scaffolding that the `init` CLI materializes into a working vault. `packages/mcp/` is the Node 20 + TypeScript MCP server that uses Ajv (JSON Schema), better-sqlite3 (FTS5), chokidar (file watcher), proper-lockfile (advisory locks), and gray-matter (frontmatter). Stdio transport — no network surface in Phase 1.

**Tech Stack:** Node 20 LTS · pnpm · TypeScript (ESM, strict) · Vitest · `@modelcontextprotocol/sdk` · `ajv` · `better-sqlite3` · `chokidar` · `proper-lockfile` · `gray-matter` · `pino` · `ulid` · `commander` · `yaml`.

**Spec:** [`docs/superpowers/specs/2026-04-27-vault-mem-mcp-design.md`](../specs/2026-04-27-vault-mem-mcp-design.md)

---

## File Structure

### Created files

**Repo root:**
- `package.json` — root workspace
- `pnpm-workspace.yaml`
- `tsconfig.base.json`

**Vault template (Phase 0):**
- `vault-template/_system/schema/_common.json`
- `vault-template/_system/schema/{decision,observation,todo,learning,summary,entity,question}.json`
- `vault-template/_system/templates/{decision,observation,todo,learning,summary,entity,question}.md`
- `vault-template/_system/config.yaml.example`
- `vault-template/_system/audit.log` (empty)
- `vault-template/.gitignore`
- `vault-template/README.md`
- `vault-template/memory/{decisions,observations,todos,learnings,summaries,entities,questions}/.gitkeep`
- `vault-template/inbox/{decisions,observations,todos,learnings,summaries,entities,questions}/.gitkeep`
- `vault-template/projects/.gitkeep`, `vault-template/archive/.gitkeep`
- `vault-template/memory/decisions/sample-decision.md`

**MCP package (Phase 1) — `packages/mcp/`:**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `bin/vault-mem-mcp`
- `src/index.ts` — entry: CLI dispatch + default-to-server
- `src/log.ts` — pino setup
- `src/errors.ts` — typed error kinds
- `src/id/index.ts` (+ `id.test.ts`) — ID generator
- `src/vault/atomicWrite.ts` (+ `atomicWrite.test.ts`) — temp+rename
- `src/vault/lock.ts` (+ `lock.test.ts`) — proper-lockfile wrapper
- `src/vault/paths.ts` (+ `paths.test.ts`) — vault path resolution + folder layout helpers
- `src/schema/index.ts` (+ `schema.test.ts`) — load + compile JSON Schemas
- `src/config/index.ts` (+ `config.test.ts`) — load + validate `_system/config.yaml`
- `src/audit/index.ts` (+ `audit.test.ts`) — JSONL append + helpers
- `src/index/sqlite.ts` (+ `sqlite.test.ts`) — FTS5 schema + upsert/delete/search
- `src/index/watcher.ts` (+ `watcher.test.ts`) — chokidar wiring
- `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/search.ts`, `src/tools/promote.ts`
- `src/tools/index.ts` — tool registry
- `src/server/index.ts` — MCP SDK wiring (stdio)
- `src/cli/init.ts`, `src/cli/doctor.ts`, `src/cli/reindex.ts`, `src/cli/tail-audit.ts`
- `test/integration/{read,write,search,promote}.test.ts`
- `test/integration/cli/{init,doctor,reindex,tail-audit}.test.ts`
- `test/e2e/server.test.ts`
- `test/helpers/tmpVault.ts` — copy `vault-template/` to a temp dir per test

### Modified files
- `.gitignore` — add `packages/*/dist/`, `*.tsbuildinfo`

---

## Tasks

### Task 1: Repo bootstrap

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write `package.json` (root)**

```json
{
  "name": "frozo-vault-mem",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck"
  },
  "devDependencies": {
    "typescript": "5.6.3"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Append to `.gitignore`**

Add these lines to the existing `.gitignore`:

```
packages/*/dist/
*.tsbuildinfo
```

- [ ] **Step 5: Run `pnpm install` to verify**

```bash
pnpm install
```

Expected: lockfile created, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore pnpm-lock.yaml
git commit -m "chore: bootstrap pnpm monorepo with TypeScript"
```

---

### Task 2: MCP package skeleton

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`
- Create: `packages/mcp/vitest.config.ts`
- Create: `packages/mcp/src/index.ts`
- Create: `packages/mcp/bin/vault-mem-mcp`

- [ ] **Step 1: Write `packages/mcp/package.json`**

```json
{
  "name": "@vault-mem/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "vault-mem-mcp": "bin/vault-mem-mcp"
  },
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.0.4",
    "ajv": "8.17.1",
    "ajv-formats": "3.0.1",
    "better-sqlite3": "11.5.0",
    "chokidar": "4.0.1",
    "commander": "12.1.0",
    "gray-matter": "4.0.3",
    "pino": "9.5.0",
    "proper-lockfile": "4.1.2",
    "ulid": "2.3.0",
    "yaml": "2.6.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "7.6.11",
    "@types/node": "22.9.0",
    "@types/proper-lockfile": "4.1.4",
    "pino-pretty": "13.0.0",
    "tsx": "4.19.2",
    "vitest": "2.1.5"
  }
}
```

- [ ] **Step 2: Write `packages/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist", "node_modules"]
}
```

- [ ] **Step 3: Write `packages/mcp/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 10_000,
    environment: "node",
    pool: "forks",
  },
});
```

- [ ] **Step 4: Write `packages/mcp/src/index.ts` (placeholder)**

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 5: Write `packages/mcp/bin/vault-mem-mcp`**

```sh
#!/usr/bin/env node
import("../dist/index.js");
```

Then: `chmod +x packages/mcp/bin/vault-mem-mcp`

- [ ] **Step 6: Install deps and verify build + test**

```bash
pnpm install
pnpm --filter @vault-mem/mcp build
pnpm --filter @vault-mem/mcp test
```

Expected: build succeeds; vitest reports "No test files found" (exit 0 with `--passWithNoTests`? — if it exits non-zero, add `passWithNoTests: true` to the vitest config).

If tests exit non-zero with "no test files found", update `vitest.config.ts` to add `passWithNoTests: true` to the `test` block.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp pnpm-lock.yaml
git commit -m "feat(mcp): scaffold @vault-mem/mcp package"
```

---

### Task 3: Vault template — folder structure

**Files:**
- Create: `vault-template/{memory,inbox}/{decisions,observations,todos,learnings,summaries,entities,questions}/.gitkeep`
- Create: `vault-template/projects/.gitkeep`
- Create: `vault-template/archive/.gitkeep`
- Create: `vault-template/_system/{schema,templates}/.gitkeep`
- Create: `vault-template/.gitignore`
- Create: `vault-template/README.md`

- [ ] **Step 1: Create folder structure with `.gitkeep` files**

```bash
cd vault-template
for sub in decisions observations todos learnings summaries entities questions; do
  mkdir -p memory/$sub inbox/$sub
  touch memory/$sub/.gitkeep inbox/$sub/.gitkeep
done
mkdir -p projects archive _system/schema _system/templates
touch projects/.gitkeep archive/.gitkeep _system/schema/.gitkeep _system/templates/.gitkeep
cd ..
```

- [ ] **Step 2: Write `vault-template/.gitignore`**

```
# FTS index — rebuildable from .md sources
_system/index.sqlite
_system/index.sqlite-wal
_system/index.sqlite-shm
```

- [ ] **Step 3: Write `vault-template/README.md`**

```markdown
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
```

- [ ] **Step 4: Create empty `_system/audit.log`**

```bash
touch vault-template/_system/audit.log
```

- [ ] **Step 5: Commit**

```bash
git add vault-template
git commit -m "feat(vault): scaffold vault-template folder structure"
```

---

### Task 4: JSON Schema — `_common.json`

**Files:**
- Create: `vault-template/_system/schema/_common.json`
- Create: `packages/mcp/src/schema/schema.test.ts` (initial test)

- [ ] **Step 1: Write `_common.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/_common.json",
  "title": "Vault-Mem common frontmatter",
  "type": "object",
  "additionalProperties": true,
  "required": [
    "id", "type", "title", "agent", "session",
    "created", "updated", "status", "schema_version"
  ],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_\\d{4}-\\d{2}-\\d{2}_[0-9a-f]{6}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "decision", "observation", "todo",
        "learning", "summary", "entity", "question"
      ]
    },
    "title": { "type": "string", "minLength": 1 },
    "agent": { "type": "string", "minLength": 1 },
    "session": { "type": ["string", "null"] },
    "created": { "type": "string", "format": "date-time" },
    "updated": { "type": "string", "format": "date-time" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "sources": { "type": "array", "items": { "type": "string" } },
    "contradicts": { "type": "array", "items": { "type": "string" } },
    "supersedes": { "type": "array", "items": { "type": "string" } },
    "tags": { "type": "array", "items": { "type": "string" } },
    "project": { "type": ["string", "null"] },
    "ttl_days": { "type": ["integer", "null"], "minimum": 0 },
    "status": {
      "type": "string",
      "enum": ["active", "archived", "superseded"]
    },
    "human_reviewed": { "type": "boolean" },
    "human_approved": { "type": ["boolean", "null"] },
    "schema_version": { "type": "string", "pattern": "^\\d+\\.\\d+$" }
  }
}
```

- [ ] **Step 2: Write failing test `packages/mcp/src/schema/schema.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

describe("_common.json schema", () => {
  it("compiles under Ajv draft-07", () => {
    const raw = readFileSync(
      resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
      "utf8",
    );
    const schema = JSON.parse(raw);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(typeof validate).toBe("function");
  });

  it("validates a well-formed common frontmatter object", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    const validate = ajv.compile(schema);
    const ok = validate({
      id: "mem_2026-04-27_a8f3c0",
      type: "decision",
      title: "Use Supabase for KinCare auth",
      agent: "claude-code",
      session: "01HXABCDEFGHJKMNPQRSTVWXYZ",
      created: "2026-04-27T14:32:00.000Z",
      updated: "2026-04-27T14:32:00.000Z",
      status: "active",
      schema_version: "0.1",
    });
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects an id with the wrong format", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    const validate = ajv.compile(schema);
    expect(
      validate({
        id: "not-a-vault-mem-id",
        type: "decision",
        title: "x",
        agent: "x",
        session: null,
        created: "2026-04-27T14:32:00.000Z",
        updated: "2026-04-27T14:32:00.000Z",
        status: "active",
        schema_version: "0.1",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2.5: Run the test to confirm it passes**

```bash
pnpm --filter @vault-mem/mcp test schema/schema.test.ts
```

Expected: 3 passing. (No failing-first step needed here — this task is creating the schema artifact, with tests that assert its shape directly.)

- [ ] **Step 3: Commit**

```bash
git add vault-template/_system/schema/_common.json packages/mcp/src/schema/schema.test.ts
git commit -m "feat(vault): add _common.json frontmatter schema with tests"
```

---

### Task 5: JSON Schemas — 7 type schemas

**Files:**
- Create: `vault-template/_system/schema/{decision,observation,todo,learning,summary,entity,question}.json`
- Modify: `packages/mcp/src/schema/schema.test.ts` (extend coverage)

- [ ] **Step 1: Write `decision.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/decision.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "decision" }
      },
      "required": ["type"]
    }
  ]
}
```

- [ ] **Step 2: Write `observation.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/observation.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "observation" }
      },
      "required": ["type"]
    }
  ]
}
```

- [ ] **Step 3: Write `todo.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/todo.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "todo" },
        "todo_status": {
          "type": "string",
          "enum": ["todo", "doing", "done", "cancelled"]
        }
      },
      "required": ["type", "todo_status"]
    }
  ]
}
```

- [ ] **Step 4: Write `learning.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/learning.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "learning" }
      },
      "required": ["type"]
    }
  ]
}
```

- [ ] **Step 5: Write `summary.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/summary.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "summary" },
        "period": {
          "type": "string",
          "enum": ["daily", "weekly", "monthly"]
        },
        "covers": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["type", "period", "covers"]
    }
  ]
}
```

- [ ] **Step 6: Write `entity.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/entity.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "entity" },
        "entity_kind": {
          "type": "string",
          "enum": ["person", "project", "tool", "concept"]
        }
      },
      "required": ["type", "entity_kind"]
    }
  ]
}
```

- [ ] **Step 7: Write `question.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "vault-mem://schema/question.json",
  "allOf": [
    { "$ref": "_common.json" },
    {
      "type": "object",
      "properties": {
        "type": { "const": "question" },
        "resolved_by": { "type": ["string", "null"] }
      },
      "required": ["type", "resolved_by"]
    }
  ]
}
```

- [ ] **Step 8: Add a parameterised test to `packages/mcp/src/schema/schema.test.ts`**

Append to the end of the file:

```ts
import { describe as describe2 } from "vitest";

describe2("type-specific schemas compile together with _common.json", () => {
  const types = [
    "decision", "observation", "todo",
    "learning", "summary", "entity", "question",
  ] as const;

  it.each(types)("%s schema compiles via $ref into _common.json", (t) => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    ajv.addSchema(common, common.$id);
    const typeSchema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, `_system/schema/${t}.json`),
        "utf8",
      ),
    );
    const validate = ajv.compile(typeSchema);
    expect(typeof validate).toBe("function");
  });
});
```

- [ ] **Step 9: Run tests**

```bash
pnpm --filter @vault-mem/mcp test schema/schema.test.ts
```

Expected: 10 passing (3 from Task 4 + 7 parameterised).

- [ ] **Step 10: Commit**

```bash
git add vault-template/_system/schema/*.json packages/mcp/src/schema/schema.test.ts
git commit -m "feat(vault): add 7 type-specific schemas (decision, observation, todo, learning, summary, entity, question)"
```

---

### Task 6: Markdown templates

**Files:**
- Create: `vault-template/_system/templates/{decision,observation,todo,learning,summary,entity,question}.md`

- [ ] **Step 1: Write `decision.md`**

```markdown
---
id: "{{id}}"
type: decision
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 0.7
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: null
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Rationale

## Considered alternatives

## Constraints
```

- [ ] **Step 2: Write `observation.md`**

```markdown
---
id: "{{id}}"
type: observation
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 0.7
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: 90
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## What was observed

## Where it was seen
```

- [ ] **Step 3: Write `todo.md`**

```markdown
---
id: "{{id}}"
type: todo
todo_status: todo
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 1.0
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: 30
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Why
```

- [ ] **Step 4: Write `learning.md`**

```markdown
---
id: "{{id}}"
type: learning
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 0.6
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: 180
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Pattern

## Evidence (memory ids)
```

- [ ] **Step 5: Write `summary.md`**

```markdown
---
id: "{{id}}"
type: summary
period: daily
covers: []
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 1.0
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: null
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Highlights

## Decisions

## Open questions
```

- [ ] **Step 6: Write `entity.md`**

```markdown
---
id: "{{id}}"
type: entity
entity_kind: project
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 1.0
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: null
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Description

## Related
```

- [ ] **Step 7: Write `question.md`**

```markdown
---
id: "{{id}}"
type: question
resolved_by: null
title: "{{title}}"
agent: "{{agent}}"
session: "{{session}}"
created: "{{created}}"
updated: "{{updated}}"
confidence: 1.0
sources: []
contradicts: []
supersedes: []
tags: []
project: null
ttl_days: null
status: active
human_reviewed: false
human_approved: null
schema_version: "0.1"
---

# {{title}}

## Context

## What an answer would look like
```

- [ ] **Step 8: Commit**

```bash
git add vault-template/_system/templates
git commit -m "feat(vault): add markdown templates for 7 memory types"
```

---

### Task 7: Config example, audit starter, sample memory

**Files:**
- Create: `vault-template/_system/config.yaml.example`
- Create: `vault-template/memory/decisions/sample-decision.md`

- [ ] **Step 1: Write `_system/config.yaml.example`**

```yaml
vault_version: 0.1
schema_version: 0.1
default_agent: human
inbox_routing: always

fts:
  index_path: _system/index.sqlite
  rebuild_on_startup: false

audit:
  log_path: _system/audit.log
```

- [ ] **Step 2: Write `memory/decisions/sample-decision.md`**

```markdown
---
id: mem_2026-04-27_000001
type: decision
title: "Use Supabase for KinCare auth"
agent: human
session: null
created: "2026-04-27T14:32:00.000Z"
updated: "2026-04-27T14:32:00.000Z"
confidence: 0.85
sources:
  - "[[meeting-2026-04-25]]"
  - "[[code-review-pr-142]]"
contradicts: []
supersedes: []
tags: [kincare, auth, architecture]
project: kincare
ttl_days: null
status: active
human_reviewed: true
human_approved: true
schema_version: "0.1"
---

# Use Supabase for KinCare auth

## Rationale

Supabase gives us first-party Postgres, RLS policies, and DPDP-compatible
EU/India hosting. Family-member multi-tenancy maps cleanly onto auth schemas.

## Considered alternatives

- **Clerk** — rejected: harder DPDP story, no first-party DB.
- **Auth0** — rejected: pricing on family-tier multi-tenancy doesn't scale.

## Constraints

- DPDP compliance required
- Family-member multi-tenancy
```

- [ ] **Step 3: Add a test in `packages/mcp/src/schema/schema.test.ts` that the sample memory validates**

Append to the file:

```ts
import matter from "gray-matter";

describe("sample-decision.md", () => {
  it("parses and validates against decision.json", () => {
    const raw = readFileSync(
      resolve(VAULT_TEMPLATE, "memory/decisions/sample-decision.md"),
      "utf8",
    );
    const { data } = matter(raw);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    ajv.addSchema(common, common.$id);
    const decision = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/decision.json"),
        "utf8",
      ),
    );
    const validate = ajv.compile(decision);
    const ok = validate(data);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @vault-mem/mcp test schema/schema.test.ts
```

Expected: 11 passing.

- [ ] **Step 5: Commit**

```bash
git add vault-template/_system/config.yaml.example vault-template/memory/decisions/sample-decision.md packages/mcp/src/schema/schema.test.ts
git commit -m "feat(vault): add config example and sample decision memory"
```

---

### Task 8: `id` module

**Files:**
- Create: `packages/mcp/src/id/index.ts`
- Create: `packages/mcp/src/id/id.test.ts`

- [ ] **Step 1: Write the failing test `packages/mcp/src/id/id.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { generateId, ID_PATTERN } from "./index.js";

describe("generateId", () => {
  it("matches the documented pattern", () => {
    const id = generateId();
    expect(id).toMatch(ID_PATTERN);
  });

  it("uses the supplied date for the YYYY-MM-DD prefix", () => {
    const id = generateId(new Date("2026-04-27T10:00:00Z"));
    expect(id.startsWith("mem_2026-04-27_")).toBe(true);
  });

  it("produces 6 lowercase hex characters in the suffix", () => {
    const id = generateId();
    const suffix = id.split("_").pop()!;
    expect(suffix).toMatch(/^[0-9a-f]{6}$/);
  });

  it("produces unique IDs over 10k generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateId());
    expect(seen.size).toBe(10_000);
  });
});

describe("ID_PATTERN", () => {
  it("accepts a known-good id", () => {
    expect(ID_PATTERN.test("mem_2026-04-27_a8f3c0")).toBe(true);
  });
  it("rejects malformed ids", () => {
    expect(ID_PATTERN.test("mem_2026-4-27_a8f3c0")).toBe(false);
    expect(ID_PATTERN.test("mem_2026-04-27_GHIJKL")).toBe(false);
    expect(ID_PATTERN.test("notamem_2026-04-27_a8f3c0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test id/id.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/id/index.ts`**

```ts
import { randomBytes } from "node:crypto";

export const ID_PATTERN = /^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/;

export function generateId(date: Date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10);
  const rand = randomBytes(3).toString("hex");
  return `mem_${ymd}_${rand}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test id/id.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/id
git commit -m "feat(mcp): add id module (generateId, ID_PATTERN)"
```

---

### Task 9: `vault/atomicWrite` module

**Files:**
- Create: `packages/mcp/src/vault/atomicWrite.ts`
- Create: `packages/mcp/src/vault/atomicWrite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomicWrite.js";

describe("atomicWrite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-aw-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("writes content atomically and leaves no temp files behind", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "hello world");
    expect(readFileSync(path, "utf8")).toBe("hello world");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftover).toHaveLength(0);
  });

  it("overwrites existing content cleanly", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "first");
    atomicWrite(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("supports unicode content", () => {
    const path = join(dir, "memo.md");
    atomicWrite(path, "😀 नमस्ते 你好");
    expect(readFileSync(path, "utf8")).toBe("😀 नमस्ते 你好");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test vault/atomicWrite.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/vault/atomicWrite.ts`**

```ts
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicWrite(absPath: string, contents: string): void {
  const tmp = `${absPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
  fsyncDir(dirname(absPath));
}

function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return; // Some filesystems (e.g., Windows in CI) don't allow dir fds; skip.
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test vault/atomicWrite.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/vault
git commit -m "feat(mcp): add vault/atomicWrite (temp + fsync + rename)"
```

---

### Task 10: `vault/paths` module

**Files:**
- Create: `packages/mcp/src/vault/paths.ts`
- Create: `packages/mcp/src/vault/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveVaultPath, MEMORY_TYPES, type MemoryType, type Location, vaultPaths } from "./paths.js";

describe("resolveVaultPath", () => {
  it("prefers --vault flag over env over default", () => {
    expect(resolveVaultPath({ flag: "/a", env: "/b", home: "/h" })).toBe("/a");
    expect(resolveVaultPath({ flag: undefined, env: "/b", home: "/h" })).toBe("/b");
    expect(resolveVaultPath({ flag: undefined, env: undefined, home: "/h" })).toBe("/h/vault-mem");
  });
});

describe("MEMORY_TYPES", () => {
  it("includes the 7 documented types", () => {
    expect(MEMORY_TYPES).toEqual([
      "decision", "observation", "todo",
      "learning", "summary", "entity", "question",
    ]);
  });
});

describe("vaultPaths", () => {
  it("constructs canonical absolute paths for a given vault", () => {
    const p = vaultPaths("/vault");
    expect(p.root).toBe("/vault");
    expect(p.systemDir).toBe("/vault/_system");
    expect(p.schemaDir).toBe("/vault/_system/schema");
    expect(p.configFile).toBe("/vault/_system/config.yaml");
    expect(p.auditFile).toBe("/vault/_system/audit.log");
    expect(p.indexFile).toBe("/vault/_system/index.sqlite");
    expect(p.memoryDir("decision" as MemoryType)).toBe("/vault/memory/decisions");
    expect(p.inboxDir("decision" as MemoryType)).toBe("/vault/inbox/decisions");
    expect(p.archiveDir).toBe("/vault/archive");
  });

  it("memoryFile returns the right path for a given location", () => {
    const p = vaultPaths("/vault");
    const id = "mem_2026-04-27_a8f3c0";
    expect(p.memoryFile("decision" as MemoryType, id, "inbox" as Location)).toBe(
      "/vault/inbox/decisions/mem_2026-04-27_a8f3c0.md",
    );
    expect(p.memoryFile("decision" as MemoryType, id, "memory" as Location)).toBe(
      "/vault/memory/decisions/mem_2026-04-27_a8f3c0.md",
    );
    expect(p.memoryFile("decision" as MemoryType, id, "archive" as Location)).toBe(
      "/vault/archive/mem_2026-04-27_a8f3c0.md",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test vault/paths.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/vault/paths.ts`**

```ts
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export const MEMORY_TYPES = [
  "decision",
  "observation",
  "todo",
  "learning",
  "summary",
  "entity",
  "question",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const LOCATIONS = ["inbox", "memory", "archive"] as const;
export type Location = (typeof LOCATIONS)[number];

const PLURAL: Record<MemoryType, string> = {
  decision: "decisions",
  observation: "observations",
  todo: "todos",
  learning: "learnings",
  summary: "summaries",
  entity: "entities",
  question: "questions",
};

export interface ResolveInput {
  flag?: string;
  env?: string;
  home?: string;
}

export function resolveVaultPath(input: ResolveInput = {}): string {
  if (input.flag) return resolve(input.flag);
  if (input.env) return resolve(input.env);
  const home = input.home ?? homedir();
  return resolve(home, "vault-mem");
}

export interface VaultPaths {
  root: string;
  systemDir: string;
  schemaDir: string;
  templatesDir: string;
  configFile: string;
  auditFile: string;
  indexFile: string;
  archiveDir: string;
  projectsDir: string;
  memoryDir: (t: MemoryType) => string;
  inboxDir: (t: MemoryType) => string;
  memoryFile: (t: MemoryType, id: string, loc: Location) => string;
}

export function vaultPaths(root: string): VaultPaths {
  const abs = resolve(root);
  const systemDir = join(abs, "_system");
  return {
    root: abs,
    systemDir,
    schemaDir: join(systemDir, "schema"),
    templatesDir: join(systemDir, "templates"),
    configFile: join(systemDir, "config.yaml"),
    auditFile: join(systemDir, "audit.log"),
    indexFile: join(systemDir, "index.sqlite"),
    archiveDir: join(abs, "archive"),
    projectsDir: join(abs, "projects"),
    memoryDir: (t) => join(abs, "memory", PLURAL[t]),
    inboxDir: (t) => join(abs, "inbox", PLURAL[t]),
    memoryFile: (t, id, loc) => {
      switch (loc) {
        case "inbox":
          return join(abs, "inbox", PLURAL[t], `${id}.md`);
        case "memory":
          return join(abs, "memory", PLURAL[t], `${id}.md`);
        case "archive":
          return join(abs, "archive", `${id}.md`);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test vault/paths.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/vault/paths.ts packages/mcp/src/vault/paths.test.ts
git commit -m "feat(mcp): add vault/paths (vault path resolution + canonical layout)"
```

---

### Task 11: `schema` module

**Files:**
- Create: `packages/mcp/src/schema/index.ts`
- Modify: `packages/mcp/src/schema/schema.test.ts` (add tests for the loader)

- [ ] **Step 1: Add failing tests at the bottom of `packages/mcp/src/schema/schema.test.ts`**

```ts
import { loadSchemas, validateFrontmatter } from "./index.js";

describe("loadSchemas", () => {
  it("loads _common + 7 type schemas from the vault", () => {
    const schemas = loadSchemas(VAULT_TEMPLATE);
    expect(Object.keys(schemas).sort()).toEqual([
      "decision", "entity", "learning",
      "observation", "question", "summary", "todo",
    ]);
  });
});

describe("validateFrontmatter", () => {
  const fm = {
    id: "mem_2026-04-27_a8f3c0",
    type: "decision" as const,
    title: "x",
    agent: "human",
    session: null,
    created: "2026-04-27T14:32:00.000Z",
    updated: "2026-04-27T14:32:00.000Z",
    status: "active" as const,
    schema_version: "0.1",
  };
  const schemas = loadSchemas(VAULT_TEMPLATE);

  it("accepts valid frontmatter", () => {
    const result = validateFrontmatter(schemas, "decision", fm);
    expect(result.ok).toBe(true);
  });

  it("rejects frontmatter missing required fields", () => {
    const { id: _omit, ...bad } = fm;
    const result = validateFrontmatter(schemas, "decision", bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message?.includes("required"))).toBe(true);
    }
  });

  it("rejects mismatched type", () => {
    const result = validateFrontmatter(schemas, "decision", { ...fm, type: "observation" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @vault-mem/mcp test schema/schema.test.ts
```

Expected: FAIL — `./index.js` not found.

- [ ] **Step 3: Write `packages/mcp/src/schema/index.ts`**

```ts
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TYPES, type MemoryType, vaultPaths } from "../vault/paths.js";

export interface CompiledSchemas {
  decision: ValidateFunction;
  observation: ValidateFunction;
  todo: ValidateFunction;
  learning: ValidateFunction;
  summary: ValidateFunction;
  entity: ValidateFunction;
  question: ValidateFunction;
}

export function loadSchemas(vaultRoot: string): CompiledSchemas {
  const paths = vaultPaths(vaultRoot);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const common = JSON.parse(
    readFileSync(join(paths.schemaDir, "_common.json"), "utf8"),
  );
  ajv.addSchema(common, common.$id);

  const out: Partial<CompiledSchemas> = {};
  for (const t of MEMORY_TYPES) {
    const raw = JSON.parse(
      readFileSync(join(paths.schemaDir, `${t}.json`), "utf8"),
    );
    out[t] = ajv.compile(raw);
  }
  return out as CompiledSchemas;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ErrorObject[] };

export function validateFrontmatter(
  schemas: CompiledSchemas,
  type: MemoryType,
  data: unknown,
): ValidationResult {
  const fn = schemas[type];
  const ok = fn(data);
  if (ok) return { ok: true };
  return { ok: false, errors: fn.errors ?? [] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @vault-mem/mcp test schema/schema.test.ts
```

Expected: all (14+) passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/schema
git commit -m "feat(mcp): add schema module (loadSchemas, validateFrontmatter)"
```

---

### Task 12: `config` module

**Files:**
- Create: `packages/mcp/src/config/index.ts`
- Create: `packages/mcp/src/config/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-cfg-"));
    mkdirSync(join(dir, "_system"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid config", () => {
    writeFileSync(
      join(dir, "_system/config.yaml"),
      [
        "vault_version: 0.1",
        "schema_version: 0.1",
        "default_agent: human",
        "inbox_routing: always",
        "fts:",
        "  index_path: _system/index.sqlite",
        "  rebuild_on_startup: false",
        "audit:",
        "  log_path: _system/audit.log",
      ].join("\n"),
    );
    const cfg = loadConfig(dir);
    expect(cfg.default_agent).toBe("human");
    expect(cfg.inbox_routing).toBe("always");
    expect(cfg.fts.rebuild_on_startup).toBe(false);
  });

  it("throws when config.yaml is missing", () => {
    expect(() => loadConfig(dir)).toThrow(/config\.yaml/);
  });

  it("throws when required fields are missing", () => {
    writeFileSync(join(dir, "_system/config.yaml"), "vault_version: 0.1\n");
    expect(() => loadConfig(dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test config/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/config/index.ts`**

```ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv from "ajv";
import { vaultPaths } from "../vault/paths.js";

export interface VaultConfig {
  vault_version: string;
  schema_version: string;
  default_agent: string;
  inbox_routing: "always";
  fts: { index_path: string; rebuild_on_startup: boolean };
  audit: { log_path: string };
  vault_id?: string;
}

const CONFIG_SCHEMA = {
  type: "object",
  required: ["vault_version", "schema_version", "default_agent", "inbox_routing", "fts", "audit"],
  properties: {
    vault_version: { type: ["string", "number"] },
    schema_version: { type: ["string", "number"] },
    default_agent: { type: "string", minLength: 1 },
    inbox_routing: { type: "string", enum: ["always"] },
    fts: {
      type: "object",
      required: ["index_path", "rebuild_on_startup"],
      properties: {
        index_path: { type: "string", minLength: 1 },
        rebuild_on_startup: { type: "boolean" },
      },
    },
    audit: {
      type: "object",
      required: ["log_path"],
      properties: { log_path: { type: "string", minLength: 1 } },
    },
    vault_id: { type: "string" },
  },
} as const;

export function loadConfig(vaultRoot: string): VaultConfig {
  const paths = vaultPaths(vaultRoot);
  let raw: string;
  try {
    raw = readFileSync(paths.configFile, "utf8");
  } catch {
    throw new Error(`Missing config.yaml at ${paths.configFile}`);
  }
  const parsed = parse(raw);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(CONFIG_SCHEMA as object);
  if (!validate(parsed)) {
    throw new Error(
      `Invalid config.yaml: ${ajv.errorsText(validate.errors)}`,
    );
  }
  const cfg = parsed as VaultConfig;
  return {
    ...cfg,
    vault_version: String(cfg.vault_version),
    schema_version: String(cfg.schema_version),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test config/config.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/config
git commit -m "feat(mcp): add config module (loadConfig with YAML + schema validation)"
```

---

### Task 13: `audit` module

**Files:**
- Create: `packages/mcp/src/audit/index.ts`
- Create: `packages/mcp/src/audit/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "./index.js";

describe("Auditor", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-audit-"));
    mkdirSync(join(dir, "_system"));
    logPath = join(dir, "_system/audit.log");
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per call", () => {
    const a = new Auditor(logPath);
    a.write({ op: "write", agent: "claude-code", session: "01H", id: "mem_2026-04-27_aaaaaa", type: "decision", path: "x.md", schema_version: "0.1" });
    a.write({ op: "read", agent: "cursor", session: "02H", id: "mem_2026-04-27_aaaaaa" });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.op).toBe("write");
    expect(first.v).toBe(1);
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("hashes search queries instead of storing them raw", () => {
    const a = new Auditor(logPath);
    a.write({ op: "search", agent: "claude-code", session: "01H", query: "kincare auth", result_count: 4 });
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.query).toBeUndefined();
    expect(line.query_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(line.result_count).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test audit/audit.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/audit/index.ts`**

```ts
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AuditWriteOp {
  op: "write";
  agent: string;
  session: string | null;
  id: string;
  type: string;
  path: string;
  schema_version: string;
}

export interface AuditReadOp {
  op: "read";
  agent: string;
  session: string | null;
  id: string;
}

export interface AuditSearchOp {
  op: "search";
  agent: string;
  session: string | null;
  query: string;
  result_count: number;
}

export interface AuditPromoteOp {
  op: "promote";
  agent: string;
  session: string | null;
  id: string;
  from: string;
  to: string;
  reason?: string;
}

export interface AuditFailedOp {
  op: `${"write" | "read" | "search" | "promote"}:failed`;
  agent: string;
  session: string | null;
  correlation_id: string;
  message: string;
}

export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp | AuditFailedOp;

export class Auditor {
  constructor(private readonly logPath: string) {}

  write(entry: AuditEntry): void {
    const line = serialize(entry);
    appendFileSync(this.logPath, line + "\n", { flag: "a" });
  }
}

function serialize(entry: AuditEntry): string {
  const base = { ts: new Date().toISOString(), v: 1 };
  if (entry.op === "search") {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  return JSON.stringify({ ...base, ...entry });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test audit/audit.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/audit
git commit -m "feat(mcp): add audit module (JSONL append, sha256 query hash)"
```

---

### Task 14: `vault/lock` module

**Files:**
- Create: `packages/mcp/src/vault/lock.ts`
- Create: `packages/mcp/src/vault/lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./lock.js";

describe("withLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-lock-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("serializes concurrent calls on the same path", async () => {
    const path = join(dir, "memo.md");
    writeFileSync(path, "init");

    const order: string[] = [];
    const slow = withLock(path, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a:end");
    });
    const fast = withLock(path, async () => {
      order.push("b:start");
      order.push("b:end");
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("releases the lock on error", async () => {
    const path = join(dir, "memo.md");
    writeFileSync(path, "init");
    await expect(
      withLock(path, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    // A second call must succeed
    await withLock(path, async () => { /* ok */ });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test vault/lock.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/vault/lock.ts`**

```ts
import lockfile from "proper-lockfile";

export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(path, {
    retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
    realpath: false,
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test vault/lock.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/vault/lock.ts packages/mcp/src/vault/lock.test.ts
git commit -m "feat(mcp): add vault/lock (per-file advisory locking)"
```

---

### Task 15: `errors` and `log` modules

**Files:**
- Create: `packages/mcp/src/errors.ts`
- Create: `packages/mcp/src/log.ts`

- [ ] **Step 1: Write `packages/mcp/src/errors.ts`**

```ts
export type ErrorKind =
  | "not_found"
  | "invalid_schema"
  | "schema_validation_failed"
  | "vault_error"
  | "not_in_inbox"
  | "promote_failed"
  | "inbox_write_failed"
  | "internal_error";

export class ToolError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toPayload(): { kind: ErrorKind; message: string; details?: unknown } {
    return { kind: this.kind, message: this.message, details: this.details };
  }
}
```

- [ ] **Step 2: Write `packages/mcp/src/log.ts`**

```ts
import pino, { type Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";
const level =
  process.env.VAULT_MEM_LOG_LEVEL ??
  (isDev ? "info" : "info");

export function createLogger(): Logger {
  return pino(
    {
      level,
      base: { pkg: "vault-mem-mcp" },
    },
    pino.destination({ dest: 2, sync: false }), // fd 2 = stderr
  );
}
```

(No tests for these — `errors` is type-level only, `log` is a thin pino wrapper. They are exercised through every other module's integration tests.)

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/errors.ts packages/mcp/src/log.ts
git commit -m "feat(mcp): add errors and log modules"
```

---

### Task 16: `index/sqlite` module

**Files:**
- Create: `packages/mcp/src/index/sqlite.ts`
- Create: `packages/mcp/src/index/sqlite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { openIndex, type IndexRow } from "./sqlite.js";

const sample = (over: Partial<IndexRow> = {}): IndexRow => ({
  id: "mem_2026-04-27_aaaaaa",
  type: "decision",
  title: "Use Supabase for auth",
  body: "Supabase has DPDP-compatible hosting and RLS.",
  tags: ["kincare", "auth"],
  project: "kincare",
  status: "active",
  location: "memory",
  path: "/v/memory/decisions/mem_2026-04-27_aaaaaa.md",
  updated: "2026-04-27T14:32:00.000Z",
  ...over,
});

describe("openIndex (in-memory)", () => {
  it("creates the FTS schema and round-trips an upsert + lookup", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample());
    const row = idx.getById("mem_2026-04-27_aaaaaa");
    expect(row?.title).toBe("Use Supabase for auth");
    expect(row?.location).toBe("memory");
  });

  it("search matches title and body, ranks by BM25", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", title: "Use Supabase for auth", body: "supabase rls" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", title: "Pricing", body: "supabase free tier" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", title: "Other", body: "unrelated" }));

    const r = idx.search({ query: "supabase", limit: 10 });
    expect(r.results.map((x) => x.id).sort()).toEqual([
      "mem_2026-04-27_aaaaaa", "mem_2026-04-27_bbbbbb",
    ]);
  });

  it("filters by type, project, status, location", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample({ id: "mem_2026-04-27_aaaaaa", type: "decision", project: "kincare" }));
    idx.upsert(sample({ id: "mem_2026-04-27_bbbbbb", type: "observation", project: "kincare" }));
    idx.upsert(sample({ id: "mem_2026-04-27_cccccc", type: "decision", project: "frozo" }));

    expect(idx.search({ query: "supabase", type: "decision", limit: 10 }).results).toHaveLength(2);
    expect(idx.search({ query: "supabase", project: "kincare", limit: 10 }).results).toHaveLength(2);
    expect(idx.search({ query: "supabase", type: "decision", project: "kincare", limit: 10 }).results).toHaveLength(1);
  });

  it("delete removes a row", () => {
    const idx = openIndex(":memory:");
    idx.upsert(sample());
    idx.delete("mem_2026-04-27_aaaaaa");
    expect(idx.getById("mem_2026-04-27_aaaaaa")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test index/sqlite.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/index/sqlite.ts`**

```ts
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { Location, MemoryType } from "../vault/paths.js";

const SCHEMA_VERSION = 1;

export interface IndexRow {
  id: string;
  type: MemoryType;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  status: "active" | "archived" | "superseded";
  location: Location;
  path: string;
  updated: string;
}

export interface SearchInput {
  query: string;
  type?: MemoryType | MemoryType[];
  project?: string;
  status?: "active" | "archived" | "superseded";
  location?: Location | "any";
  limit?: number;
}

export interface SearchResult {
  id: string;
  type: MemoryType;
  title: string;
  snippet: string;
  score: number;
  location: Location;
  path: string;
  project: string | null;
  tags: string[];
  updated: string;
}

export interface IndexHandle {
  upsert(row: IndexRow): void;
  delete(id: string): void;
  getById(id: string): IndexRow | null;
  search(input: SearchInput): { results: SearchResult[]; total: number };
  rebuild(rows: Iterable<IndexRow>): void;
  count(): number;
  close(): void;
}

export function openIndex(filePath: string): IndexHandle {
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  return makeHandle(db);
}

function ensureSchema(db: DB): void {
  const v = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (v !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS memories_fts");
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        title,
        body,
        tags,
        project UNINDEXED,
        status UNINDEXED,
        location UNINDEXED,
        path UNINDEXED,
        updated UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function makeHandle(db: DB): IndexHandle {
  const upsert = db.prepare(`
    INSERT INTO memories_fts (id, type, title, body, tags, project, status, location, path, updated)
    VALUES (@id, @type, @title, @body, @tags, @project, @status, @location, @path, @updated)
  `);
  const del = db.prepare("DELETE FROM memories_fts WHERE id = ?");
  const getById = db.prepare(`
    SELECT id, type, title, body, tags, project, status, location, path, updated
    FROM memories_fts WHERE id = ?
  `);

  function rowFromDb(r: Record<string, unknown> | undefined): IndexRow | null {
    if (!r) return null;
    return {
      id: String(r.id),
      type: r.type as MemoryType,
      title: String(r.title),
      body: String(r.body),
      tags: r.tags ? String(r.tags).split("").filter(Boolean) : [],
      project: r.project ? String(r.project) : null,
      status: r.status as IndexRow["status"],
      location: r.location as Location,
      path: String(r.path),
      updated: String(r.updated),
    };
  }

  return {
    upsert(row) {
      const tx = db.transaction((r: IndexRow) => {
        del.run(r.id);
        upsert.run({
          ...r,
          tags: r.tags.join(""),
          project: r.project ?? null,
        });
      });
      tx(row);
    },
    delete(id) { del.run(id); },
    getById(id) {
      return rowFromDb(getById.get(id) as Record<string, unknown> | undefined);
    },
    search(input) {
      const { query } = input;
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const types = input.type
        ? Array.isArray(input.type) ? input.type : [input.type]
        : null;
      const where: string[] = ["memories_fts MATCH @q"];
      const params: Record<string, unknown> = { q: query, limit };

      if (types) {
        where.push(`type IN (${types.map((_, i) => `@t${i}`).join(",")})`);
        types.forEach((t, i) => { params[`t${i}`] = t; });
      }
      if (input.project) { where.push("project = @project"); params.project = input.project; }
      if (input.status) { where.push("status = @status"); params.status = input.status; }
      if (input.location && input.location !== "any") {
        where.push("location = @location");
        params.location = input.location;
      }

      const rows = db.prepare(`
        SELECT id, type, title, project, tags, status, location, path, updated,
               snippet(memories_fts, 3, '<b>', '</b>', '…', 12) AS snippet,
               bm25(memories_fts) AS score
        FROM memories_fts
        WHERE ${where.join(" AND ")}
        ORDER BY score
        LIMIT @limit
      `).all(params) as Array<Record<string, unknown>>;

      const totalRow = db.prepare(`
        SELECT COUNT(*) AS n FROM memories_fts WHERE ${where.join(" AND ")}
      `).get(params) as { n: number };

      return {
        results: rows.map((r) => ({
          id: String(r.id),
          type: r.type as MemoryType,
          title: String(r.title),
          snippet: String(r.snippet ?? ""),
          score: Number(r.score),
          location: r.location as Location,
          path: String(r.path),
          project: r.project ? String(r.project) : null,
          tags: r.tags ? String(r.tags).split("").filter(Boolean) : [],
          updated: String(r.updated),
        })),
        total: totalRow.n,
      };
    },
    rebuild(rows) {
      const tx = db.transaction((iter: IndexRow[]) => {
        db.exec("DELETE FROM memories_fts");
        for (const r of iter) {
          upsert.run({
            ...r,
            tags: r.tags.join(""),
            project: r.project ?? null,
          });
        }
      });
      tx(Array.from(rows));
    },
    count() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get() as { n: number };
      return row.n;
    },
    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test index/sqlite.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/index/sqlite.ts packages/mcp/src/index/sqlite.test.ts
git commit -m "feat(mcp): add index/sqlite module (FTS5 schema + upsert/search/delete)"
```

---

### Task 17: Test helper — `tmpVault`

**Files:**
- Create: `packages/mcp/test/helpers/tmpVault.ts`

- [ ] **Step 1: Write `packages/mcp/test/helpers/tmpVault.ts`**

```ts
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

export interface TmpVault {
  root: string;
  cleanup: () => void;
}

export function makeTmpVault(): TmpVault {
  const root = mkdtempSync(join(tmpdir(), "vault-mem-test-"));
  cpSync(VAULT_TEMPLATE, root, { recursive: true });
  // Materialize config from example
  const cfg = [
    "vault_version: 0.1",
    "schema_version: 0.1",
    "default_agent: human",
    "inbox_routing: always",
    "fts:",
    "  index_path: _system/index.sqlite",
    "  rebuild_on_startup: false",
    "audit:",
    "  log_path: _system/audit.log",
  ].join("\n");
  writeFileSync(join(root, "_system/config.yaml"), cfg);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/test/helpers
git commit -m "test(mcp): add tmpVault helper for integration tests"
```

---

### Task 18: `memory.write` tool

**Files:**
- Create: `packages/mcp/src/tools/write.ts`
- Create: `packages/mcp/test/integration/write.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.write", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("writes a valid decision to inbox/decisions/, audits, and indexes", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
    });

    const result = await tool.handle({
      type: "decision",
      fields: { title: "Test decision", project: "demo", tags: ["x"] },
      content: "## Rationale\n\nbecause",
      agent: "claude-code",
      session: "01HX",
    });

    expect(result.id).toMatch(/^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/);
    const expectedPath = paths.memoryFile("decision", result.id, "inbox");
    expect(result.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const { data, content } = matter(readFileSync(expectedPath, "utf8"));
    expect(data.id).toBe(result.id);
    expect(data.type).toBe("decision");
    expect(data.title).toBe("Test decision");
    expect(data.agent).toBe("claude-code");
    expect(data.status).toBe("active");
    expect(data.schema_version).toBe("0.1");
    expect(content.trim()).toBe("## Rationale\n\nbecause");

    const audit = readFileSync(paths.auditFile, "utf8").trim().split("\n").pop()!;
    const auditEntry = JSON.parse(audit);
    expect(auditEntry.op).toBe("write");
    expect(auditEntry.id).toBe(result.id);
  });

  it("rejects missing required fields without writing anything", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
    });

    await expect(
      tool.handle({
        type: "decision",
        fields: {},  // missing title
        content: "x",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });
  });

  it("requires todo_status for type=todo", async () => {
    const paths = vaultPaths(v.root);
    const tool = createWriteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
      defaultAgent: "human",
    });

    await expect(
      tool.handle({
        type: "todo",
        fields: { title: "ship phase 1" },
        content: "",
      }),
    ).rejects.toMatchObject({ kind: "schema_validation_failed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/write.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/tools/write.ts`**

```ts
import { mkdirSync } from "node:fs";
import matter from "gray-matter";
import { generateId } from "../id/index.js";
import { atomicWrite } from "../vault/atomicWrite.js";
import { withLock } from "../vault/lock.js";
import { vaultPaths, type MemoryType } from "../vault/paths.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import { ToolError } from "../errors.js";

export interface WriteToolInput {
  type: MemoryType;
  fields: Record<string, unknown>;
  content: string;
  agent?: string;
  session?: string | null;
}

export interface WriteToolOutput {
  id: string;
  path: string;
  warnings: string[];
}

export interface WriteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  defaultAgent: string;
}

const DEFAULT_TTL: Record<MemoryType, number | null> = {
  decision: null,
  observation: 90,
  todo: 30,
  learning: 180,
  summary: null,
  entity: null,
  question: null,
};

export function createWriteTool(deps: WriteToolDeps) {
  const paths = vaultPaths(deps.vault);

  return {
    async handle(input: WriteToolInput): Promise<WriteToolOutput> {
      const id = generateId();
      const now = new Date().toISOString();
      const agent = input.agent ?? deps.defaultAgent;
      const session = input.session ?? null;

      const fm: Record<string, unknown> = {
        ...input.fields,
        id,
        type: input.type,
        agent,
        session,
        created: now,
        updated: now,
        status: "active",
        schema_version: "0.1",
      };
      if (fm.ttl_days === undefined) fm.ttl_days = DEFAULT_TTL[input.type];
      if (fm.confidence === undefined) {
        fm.confidence = agent === "human" ? 1.0 : 0.7;
      }
      for (const k of ["sources", "contradicts", "supersedes", "tags"]) {
        if (fm[k] === undefined) fm[k] = [];
      }
      if (fm.project === undefined) fm.project = null;

      const validation = validateFrontmatter(deps.schemas, input.type, fm);
      if (!validation.ok) {
        throw new ToolError(
          "schema_validation_failed",
          "Frontmatter failed schema validation",
          validation.errors,
        );
      }

      const targetPath = paths.memoryFile(input.type, id, "inbox");
      mkdirSync(paths.inboxDir(input.type), { recursive: true });
      const serialized = matter.stringify(input.content, fm);

      await withLock(paths.inboxDir(input.type), async () => {
        atomicWrite(targetPath, serialized);
      });

      deps.auditor.write({
        op: "write",
        agent,
        session,
        id,
        type: input.type,
        path: targetPath,
        schema_version: "0.1",
      });

      deps.index.upsert({
        id,
        type: input.type,
        title: String(fm.title),
        body: input.content,
        tags: (fm.tags as string[]) ?? [],
        project: (fm.project as string | null) ?? null,
        status: "active",
        location: "inbox",
        path: targetPath,
        updated: now,
      });

      return { id, path: targetPath, warnings: [] };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/write.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/write.ts packages/mcp/test/integration/write.test.ts
git commit -m "feat(mcp): implement memory.write tool"
```

---

### Task 19: `memory.read` tool

**Files:**
- Create: `packages/mcp/src/tools/read.ts`
- Create: `packages/mcp/test/integration/read.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createReadTool } from "../../src/tools/read.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.read", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("returns frontmatter, content, path, location for an existing memory", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);

    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const read = createReadTool({ vault: v.root, schemas, auditor, index: idx });

    const written = await write.handle({
      type: "decision",
      fields: { title: "Read test" },
      content: "body text here",
      agent: "human",
    });

    const result = await read.handle({ id: written.id });
    expect(result.id).toBe(written.id);
    expect(result.type).toBe("decision");
    expect(result.frontmatter.title).toBe("Read test");
    expect(result.content.trim()).toBe("body text here");
    expect(result.location).toBe("inbox");
  });

  it("throws not_found for an unknown id", async () => {
    const paths = vaultPaths(v.root);
    const read = createReadTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
    });
    await expect(read.handle({ id: "mem_2026-04-27_zzzzzz" })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns the sample-decision.md from the materialized vault", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    // Manually index the sample (simulates startup populate)
    idx.upsert({
      id: "mem_2026-04-27_000001",
      type: "decision",
      title: "Use Supabase for KinCare auth",
      body: "",
      tags: ["kincare", "auth", "architecture"],
      project: "kincare",
      status: "active",
      location: "memory",
      path: paths.memoryFile("decision", "mem_2026-04-27_000001", "memory"),
      updated: "2026-04-27T14:32:00.000Z",
    });
    const read = createReadTool({
      vault: v.root,
      schemas,
      auditor: new Auditor(paths.auditFile),
      index: idx,
    });
    const result = await read.handle({ id: "mem_2026-04-27_000001" });
    expect(result.frontmatter.title).toBe("Use Supabase for KinCare auth");
    expect(result.location).toBe("memory");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/read.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/tools/read.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { ToolError } from "../errors.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import {
  vaultPaths, type MemoryType, type Location, MEMORY_TYPES, LOCATIONS,
} from "../vault/paths.js";

export interface ReadToolInput { id: string }

export interface ReadToolOutput {
  id: string;
  type: MemoryType;
  frontmatter: Record<string, unknown>;
  content: string;
  path: string;
  location: Location;
}

export interface ReadToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createReadTool(deps: ReadToolDeps) {
  const paths = vaultPaths(deps.vault);

  function findOnDisk(id: string): { path: string; location: Location; type: MemoryType } | null {
    for (const loc of LOCATIONS) {
      if (loc === "archive") {
        const p = paths.memoryFile("decision", id, "archive");
        if (existsSync(p)) {
          // We don't know the type from the path; parse the file to learn
          const { data } = matter(readFileSync(p, "utf8"));
          return { path: p, location: "archive", type: data.type as MemoryType };
        }
        continue;
      }
      for (const t of MEMORY_TYPES) {
        const p = paths.memoryFile(t, id, loc);
        if (existsSync(p)) return { path: p, location: loc, type: t };
      }
    }
    return null;
  }

  return {
    async handle(input: ReadToolInput): Promise<ReadToolOutput> {
      const indexed = deps.index.getById(input.id);
      let path: string, location: Location, type: MemoryType;

      if (indexed) {
        path = indexed.path;
        location = indexed.location;
        type = indexed.type;
      } else {
        const found = findOnDisk(input.id);
        if (!found) {
          throw new ToolError("not_found", `No memory with id ${input.id}`);
        }
        path = found.path;
        location = found.location;
        type = found.type;
      }

      const raw = readFileSync(path, "utf8");
      const { data, content } = matter(raw);
      const validation = validateFrontmatter(deps.schemas, type, data);
      if (!validation.ok) {
        throw new ToolError(
          "invalid_schema",
          `Frontmatter at ${path} failed schema validation`,
          validation.errors,
        );
      }

      deps.auditor.write({
        op: "read",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        id: input.id,
      });

      return { id: input.id, type, frontmatter: data, content, path, location };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/read.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/read.ts packages/mcp/test/integration/read.test.ts
git commit -m "feat(mcp): implement memory.read tool"
```

---

### Task 20: `memory.search` tool

**Files:**
- Create: `packages/mcp/src/tools/search.ts`
- Create: `packages/mcp/test/integration/search.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createSearchTool } from "../../src/tools/search.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths } from "../../src/vault/paths.js";

describe("memory.search", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    return () => v.cleanup();
  });

  it("finds memories matching the query and respects filters", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const search = createSearchTool({ auditor, index: idx });

    await write.handle({ type: "decision", fields: { title: "Use Supabase", project: "kincare" }, content: "supabase has rls", agent: "human" });
    await write.handle({ type: "observation", fields: { title: "Pricing", project: "kincare" }, content: "supabase free tier", agent: "human" });
    await write.handle({ type: "decision", fields: { title: "Other choice", project: "frozo" }, content: "unrelated content", agent: "human" });

    const r1 = await search.handle({ query: "supabase" });
    expect(r1.results.length).toBe(2);

    const r2 = await search.handle({ query: "supabase", type: "decision" });
    expect(r2.results.length).toBe(1);
    expect(r2.results[0]!.title).toBe("Use Supabase");

    const r3 = await search.handle({ query: "supabase", project: "kincare" });
    expect(r3.results.length).toBe(2);
  });

  it("returns empty results, total 0, on no match", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const search = createSearchTool({ auditor, index: idx });
    const r = await search.handle({ query: "nothing-matches" });
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/search.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/tools/search.ts`**

```ts
import { Auditor } from "../audit/index.js";
import { type IndexHandle, type SearchInput } from "../index/sqlite.js";

export interface SearchToolDeps {
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createSearchTool(deps: SearchToolDeps) {
  return {
    async handle(input: SearchInput) {
      const out = deps.index.search(input);
      deps.auditor.write({
        op: "search",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        query: input.query,
        result_count: out.results.length,
      });
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/search.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/search.ts packages/mcp/test/integration/search.test.ts
git commit -m "feat(mcp): implement memory.search tool"
```

---

### Task 21: `memory.promote` tool

**Files:**
- Create: `packages/mcp/src/tools/promote.ts`
- Create: `packages/mcp/test/integration/promote.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { createWriteTool } from "../../src/tools/write.js";
import { createPromoteTool } from "../../src/tools/promote.js";
import { loadSchemas } from "../../src/schema/index.js";
import { Auditor } from "../../src/audit/index.js";
import { openIndex } from "../../src/index/sqlite.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

describe("memory.promote", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    // Ensure all memory subfolders exist
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
    return () => v.cleanup();
  });

  it("moves an inbox memory to memory/<type>/", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx });

    const w = await write.handle({ type: "decision", fields: { title: "Promote me" }, content: "body", agent: "human" });
    expect(existsSync(w.path)).toBe(true);

    const p = await promote.handle({ id: w.id });
    expect(p.from).toBe(paths.memoryFile("decision", w.id, "inbox"));
    expect(p.to).toBe(paths.memoryFile("decision", w.id, "memory"));
    expect(existsSync(p.from)).toBe(false);
    expect(existsSync(p.to)).toBe(true);

    // Index reflects new location after promote (we update synchronously; watcher will also fire)
    const row = idx.getById(w.id);
    expect(row?.location).toBe("memory");
  });

  it("rejects promote for a memory not in inbox", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");
    const auditor = new Auditor(paths.auditFile);
    const write = createWriteTool({ vault: v.root, schemas, auditor, index: idx, defaultAgent: "human" });
    const promote = createPromoteTool({ vault: v.root, schemas, auditor, index: idx });

    const w = await write.handle({ type: "decision", fields: { title: "x" }, content: "x", agent: "human" });
    await promote.handle({ id: w.id });
    await expect(promote.handle({ id: w.id })).rejects.toMatchObject({ kind: "not_in_inbox" });
  });

  it("rejects promote for an unknown id", async () => {
    const paths = vaultPaths(v.root);
    const promote = createPromoteTool({
      vault: v.root,
      schemas: loadSchemas(v.root),
      auditor: new Auditor(paths.auditFile),
      index: openIndex(":memory:"),
    });
    await expect(promote.handle({ id: "mem_2026-04-27_zzzzzz" })).rejects.toMatchObject({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/promote.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/tools/promote.ts`**

```ts
import { existsSync, readFileSync, renameSync } from "node:fs";
import matter from "gray-matter";
import { ToolError } from "../errors.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { Auditor } from "../audit/index.js";
import { type IndexHandle } from "../index/sqlite.js";
import {
  vaultPaths, type MemoryType, MEMORY_TYPES,
} from "../vault/paths.js";

export interface PromoteToolInput {
  id: string;
  reason?: string;
}

export interface PromoteToolOutput {
  id: string;
  from: string;
  to: string;
}

export interface PromoteToolDeps {
  vault: string;
  schemas: CompiledSchemas;
  auditor: Auditor;
  index: IndexHandle;
  agent?: string;
  session?: string | null;
}

export function createPromoteTool(deps: PromoteToolDeps) {
  const paths = vaultPaths(deps.vault);

  function findInbox(id: string): { path: string; type: MemoryType } | null {
    for (const t of MEMORY_TYPES) {
      const p = paths.memoryFile(t, id, "inbox");
      if (existsSync(p)) return { path: p, type: t };
    }
    return null;
  }

  function findAnywhere(id: string): boolean {
    for (const loc of ["inbox", "memory"] as const) {
      for (const t of MEMORY_TYPES) {
        if (existsSync(paths.memoryFile(t, id, loc))) return true;
      }
    }
    return existsSync(paths.memoryFile("decision", id, "archive"));
  }

  return {
    async handle(input: PromoteToolInput): Promise<PromoteToolOutput> {
      const inboxHit = findInbox(input.id);
      if (!inboxHit) {
        if (findAnywhere(input.id)) {
          throw new ToolError(
            "not_in_inbox",
            `Memory ${input.id} exists but is not in inbox/`,
          );
        }
        throw new ToolError("not_found", `No memory with id ${input.id}`);
      }
      const { path: from, type } = inboxHit;
      const { data } = matter(readFileSync(from, "utf8"));
      const validation = validateFrontmatter(deps.schemas, type, data);
      if (!validation.ok) {
        throw new ToolError(
          "invalid_schema",
          `Cannot promote: frontmatter at ${from} is invalid`,
          validation.errors,
        );
      }
      const to = paths.memoryFile(type, input.id, "memory");
      try {
        renameSync(from, to);
      } catch (err) {
        throw new ToolError(
          "promote_failed",
          `Failed to move ${from} → ${to}: ${(err as Error).message}`,
        );
      }
      const idxRow = deps.index.getById(input.id);
      if (idxRow) deps.index.upsert({ ...idxRow, location: "memory", path: to });

      deps.auditor.write({
        op: "promote",
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
        id: input.id,
        from,
        to,
        reason: input.reason,
      });
      return { id: input.id, from, to };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/promote.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/promote.ts packages/mcp/test/integration/promote.test.ts
git commit -m "feat(mcp): implement memory.promote tool"
```

---

### Task 22: `index/watcher` module

**Files:**
- Create: `packages/mcp/src/index/watcher.ts`
- Create: `packages/mcp/src/index/watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex } from "./sqlite.js";
import { startWatcher } from "./watcher.js";
import { loadSchemas } from "../schema/index.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import matter from "gray-matter";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sampleFm = (id: string) => ({
  id,
  type: "decision",
  title: "Watcher test",
  agent: "human",
  session: null,
  created: "2026-04-27T14:32:00.000Z",
  updated: "2026-04-27T14:32:00.000Z",
  status: "active",
  schema_version: "0.1",
  confidence: 1,
  sources: [], contradicts: [], supersedes: [], tags: [],
  project: null, ttl_days: null, human_reviewed: false, human_approved: null,
});

describe("startWatcher", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) mkdirSync(paths.memoryDir(t), { recursive: true });
    return () => v.cleanup();
  });

  it("upserts on file add and removes on unlink", async () => {
    const paths = vaultPaths(v.root);
    const idx = openIndex(":memory:");
    const w = startWatcher({ vault: v.root, index: idx, schemas: loadSchemas(v.root), debounceMs: 50 });
    await sleep(150);

    const id = "mem_2026-04-27_aaaaaa";
    const file = paths.memoryFile("decision", id, "memory");
    writeFileSync(file, matter.stringify("body", sampleFm(id)));
    await sleep(300);
    expect(idx.getById(id)?.title).toBe("Watcher test");

    rmSync(file);
    await sleep(300);
    expect(idx.getById(id)).toBeNull();

    await w.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test index/watcher.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/index/watcher.ts`**

```ts
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import matter from "gray-matter";
import {
  vaultPaths, type MemoryType, type Location, MEMORY_TYPES,
} from "../vault/paths.js";
import { type IndexHandle } from "./sqlite.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";
import { createLogger } from "../log.js";

export interface WatcherDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
  debounceMs?: number;
}

export interface WatcherHandle {
  close(): Promise<void>;
}

const PLURAL_TO_TYPE: Record<string, MemoryType> = {
  decisions: "decision",
  observations: "observation",
  todos: "todo",
  learnings: "learning",
  summaries: "summary",
  entities: "entity",
  questions: "question",
};

export function startWatcher(deps: WatcherDeps): WatcherHandle {
  const log = createLogger().child({ module: "watcher" });
  const paths = vaultPaths(deps.vault);
  const watcher: FSWatcher = chokidar.watch(
    [paths.archiveDir, ...MEMORY_TYPES.flatMap((t) => [paths.memoryDir(t), paths.inboxDir(t)])],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: deps.debounceMs ?? 200, pollInterval: 50 } },
  );

  function locationFor(absPath: string): Location | null {
    const rel = relative(paths.root, absPath);
    const top = rel.split(/[\\/]/)[0];
    if (top === "inbox") return "inbox";
    if (top === "memory") return "memory";
    if (top === "archive") return "archive";
    return null;
  }

  function typeFor(absPath: string, fmType?: string): MemoryType | null {
    const parent = basename(dirname(absPath));
    const t = PLURAL_TO_TYPE[parent];
    if (t) return t;
    if (fmType && (MEMORY_TYPES as readonly string[]).includes(fmType)) {
      return fmType as MemoryType;
    }
    return null;
  }

  async function reconcile(absPath: string): Promise<void> {
    if (!absPath.endsWith(".md")) return;
    const loc = locationFor(absPath);
    if (!loc) return;
    let raw: string;
    try { raw = readFileSync(absPath, "utf8"); }
    catch { return; }
    const { data, content } = matter(raw);
    const type = typeFor(absPath, data.type as string | undefined);
    if (!type) return;
    const validation = validateFrontmatter(deps.schemas, type, data);
    if (!validation.ok) {
      log.warn({ path: absPath, errors: validation.errors }, "skipping invalid frontmatter");
      return;
    }
    const fm = data as Record<string, unknown>;
    const id = String(fm.id);
    deps.index.upsert({
      id,
      type,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as "active" | "archived" | "superseded") ?? "active",
      location: loc,
      path: absPath,
      updated: String(fm.updated),
    });
  }

  function unlinkPath(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const id = basename(absPath, ".md");
    deps.index.delete(id);
  }

  watcher.on("add", reconcile).on("change", reconcile).on("unlink", unlinkPath);

  return { async close() { await watcher.close(); } };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test index/watcher.test.ts
```

Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/index/watcher.ts packages/mcp/src/index/watcher.test.ts
git commit -m "feat(mcp): add index/watcher (chokidar reconciliation)"
```

---

### Task 23: Tool registry + populate-from-vault helper

**Files:**
- Create: `packages/mcp/src/tools/index.ts`
- Create: `packages/mcp/src/index/populate.ts`
- Create: `packages/mcp/src/index/populate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import matter from "gray-matter";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { openIndex } from "./sqlite.js";
import { populateIndex } from "./populate.js";
import { loadSchemas } from "../schema/index.js";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";

const fm = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: "decision", title: "Pop test " + id, agent: "human", session: null,
  created: "2026-04-27T14:32:00.000Z", updated: "2026-04-27T14:32:00.000Z",
  status: "active", schema_version: "0.1", confidence: 1,
  sources: [], contradicts: [], supersedes: [], tags: [],
  project: null, ttl_days: null, human_reviewed: false, human_approved: null,
  ...over,
});

describe("populateIndex", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) {
      mkdirSync(paths.memoryDir(t), { recursive: true });
      mkdirSync(paths.inboxDir(t), { recursive: true });
    }
    return () => v.cleanup();
  });

  it("walks the vault and indexes all .md files", async () => {
    const paths = vaultPaths(v.root);
    const schemas = loadSchemas(v.root);
    const idx = openIndex(":memory:");

    writeFileSync(paths.memoryFile("decision", "mem_2026-04-27_aaaaaa", "memory"),
      matter.stringify("body a", fm("mem_2026-04-27_aaaaaa")));
    writeFileSync(paths.memoryFile("decision", "mem_2026-04-27_bbbbbb", "inbox"),
      matter.stringify("body b", fm("mem_2026-04-27_bbbbbb")));

    await populateIndex({ vault: v.root, index: idx, schemas });

    expect(idx.getById("mem_2026-04-27_aaaaaa")?.location).toBe("memory");
    expect(idx.getById("mem_2026-04-27_bbbbbb")?.location).toBe("inbox");
    // sample-decision.md should also have been indexed
    expect(idx.getById("mem_2026-04-27_000001")?.title).toBe("Use Supabase for KinCare auth");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test index/populate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/index/populate.ts`**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import matter from "gray-matter";
import {
  vaultPaths, MEMORY_TYPES, type MemoryType, type Location,
} from "../vault/paths.js";
import { type IndexHandle, type IndexRow } from "./sqlite.js";
import { type CompiledSchemas, validateFrontmatter } from "../schema/index.js";

const PLURAL_TO_TYPE: Record<string, MemoryType> = {
  decisions: "decision", observations: "observation", todos: "todo",
  learnings: "learning", summaries: "summary", entities: "entity", questions: "question",
};

export interface PopulateDeps {
  vault: string;
  index: IndexHandle;
  schemas: CompiledSchemas;
}

export async function populateIndex(deps: PopulateDeps): Promise<{ count: number }> {
  const paths = vaultPaths(deps.vault);
  const rows: IndexRow[] = [];

  for (const loc of ["memory", "inbox"] as const) {
    for (const t of MEMORY_TYPES) {
      const dir = loc === "memory" ? paths.memoryDir(t) : paths.inboxDir(t);
      collectFromDir(dir, t, loc, rows, deps.schemas);
    }
  }
  collectArchive(paths.archiveDir, rows, deps.schemas);

  deps.index.rebuild(rows);
  return { count: rows.length };
}

function collectFromDir(
  dir: string,
  type: MemoryType,
  loc: Location,
  rows: IndexRow[],
  schemas: CompiledSchemas,
): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const { data, content } = matter(readFileSync(path, "utf8"));
    const v = validateFrontmatter(schemas, type, data);
    if (!v.ok) continue;
    const fm = data as Record<string, unknown>;
    rows.push({
      id: String(fm.id),
      type,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as IndexRow["status"]) ?? "active",
      location: loc,
      path,
      updated: String(fm.updated),
    });
  }
}

function collectArchive(dir: string, rows: IndexRow[], schemas: CompiledSchemas): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const { data, content } = matter(readFileSync(path, "utf8"));
    const t = data.type as MemoryType | undefined;
    if (!t || !(MEMORY_TYPES as readonly string[]).includes(t)) continue;
    const v = validateFrontmatter(schemas, t, data);
    if (!v.ok) continue;
    const fm = data as Record<string, unknown>;
    rows.push({
      id: String(fm.id),
      type: t,
      title: String(fm.title),
      body: content,
      tags: (fm.tags as string[] | undefined) ?? [],
      project: (fm.project as string | null | undefined) ?? null,
      status: (fm.status as IndexRow["status"]) ?? "archived",
      location: "archive",
      path,
      updated: String(fm.updated),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test index/populate.test.ts
```

Expected: 1 passing.

- [ ] **Step 5: Write `packages/mcp/src/tools/index.ts`**

```ts
export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";
export { createSearchTool } from "./search.js";
export { createPromoteTool } from "./promote.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/index/populate.ts packages/mcp/src/index/populate.test.ts packages/mcp/src/tools/index.ts
git commit -m "feat(mcp): add populateIndex helper and tools registry"
```

---

### Task 24: MCP server (stdio wiring)

**Files:**
- Create: `packages/mcp/src/server/index.ts`
- Create: `packages/mcp/test/e2e/server.test.ts`

- [ ] **Step 1: Write the failing E2E test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { buildServer } from "../../src/server/index.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

describe("MCP server (in-memory transport)", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) {
      mkdirSync(paths.memoryDir(t), { recursive: true });
      mkdirSync(paths.inboxDir(t), { recursive: true });
    }
    return () => v.cleanup();
  });

  it("happy-path round-trip: write, read, search, promote", async () => {
    const built = await buildServer({ vault: v.root });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await built.server.connect(a);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(b);

    const wrote = await client.callTool({
      name: "memory.write",
      arguments: {
        type: "decision",
        fields: { title: "E2E test", project: "demo" },
        content: "we did this",
        agent: "test-client",
      },
    });
    const writeOut = JSON.parse((wrote.content as Array<{ text: string }>)[0]!.text);
    expect(writeOut.id).toMatch(/^mem_/);

    const read = await client.callTool({
      name: "memory.read",
      arguments: { id: writeOut.id },
    });
    const readOut = JSON.parse((read.content as Array<{ text: string }>)[0]!.text);
    expect(readOut.frontmatter.title).toBe("E2E test");

    const search = await client.callTool({
      name: "memory.search",
      arguments: { query: "E2E" },
    });
    const searchOut = JSON.parse((search.content as Array<{ text: string }>)[0]!.text);
    expect(searchOut.results.some((r: { id: string }) => r.id === writeOut.id)).toBe(true);

    const promote = await client.callTool({
      name: "memory.promote",
      arguments: { id: writeOut.id },
    });
    const promoteOut = JSON.parse((promote.content as Array<{ text: string }>)[0]!.text);
    expect(promoteOut.to).toContain("/memory/decisions/");

    await client.close();
    await built.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/e2e/server.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/server/index.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ulid } from "ulid";
import { loadSchemas } from "../schema/index.js";
import { loadConfig } from "../config/index.js";
import { Auditor } from "../audit/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";
import { startWatcher, type WatcherHandle } from "../index/watcher.js";
import { vaultPaths } from "../vault/paths.js";
import { createReadTool, createWriteTool, createSearchTool, createPromoteTool } from "../tools/index.js";
import { ToolError } from "../errors.js";
import { createLogger } from "../log.js";

export interface BuildServerOpts { vault: string }

export interface BuiltServer {
  server: Server;
  shutdown: () => Promise<void>;
}

const TOOL_DEFS = [
  {
    name: "memory.write",
    description: "Create a new memory in the vault inbox.",
    inputSchema: {
      type: "object",
      required: ["type", "fields", "content"],
      properties: {
        type: { type: "string", enum: ["decision", "observation", "todo", "learning", "summary", "entity", "question"] },
        fields: { type: "object" },
        content: { type: "string" },
        agent: { type: "string" },
      },
    },
  },
  {
    name: "memory.read",
    description: "Read a memory by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "memory.search",
    description: "Full-text search the vault.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        project: { type: "string" },
        status: { type: "string", enum: ["active", "archived", "superseded"] },
        location: { type: "string", enum: ["inbox", "memory", "archive", "any"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "memory.promote",
    description: "Move a memory from inbox/ to memory/.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, reason: { type: "string" } },
    },
  },
] as const;

export async function buildServer(opts: BuildServerOpts): Promise<BuiltServer> {
  const log = createLogger().child({ module: "server" });
  const paths = vaultPaths(opts.vault);
  const config = loadConfig(opts.vault);
  const schemas = loadSchemas(opts.vault);
  const auditor = new Auditor(paths.auditFile);
  const index = openIndex(paths.indexFile);

  if (config.fts.rebuild_on_startup || index.count() === 0) {
    await populateIndex({ vault: opts.vault, index, schemas });
  }

  const watcher: WatcherHandle = startWatcher({ vault: opts.vault, index, schemas });
  const session = ulid();
  const sessionAgent = config.default_agent;

  const writeTool = createWriteTool({
    vault: opts.vault, schemas, auditor, index, defaultAgent: sessionAgent,
  });
  const readTool = createReadTool({
    vault: opts.vault, schemas, auditor, index, agent: sessionAgent, session,
  });
  const searchTool = createSearchTool({ auditor, index, agent: sessionAgent, session });
  const promoteTool = createPromoteTool({
    vault: opts.vault, schemas, auditor, index, agent: sessionAgent, session,
  });

  const server = new Server(
    { name: "vault-mem-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let out: unknown;
      const a = (args ?? {}) as Record<string, unknown>;
      switch (name) {
        case "memory.write":   out = await writeTool.handle(a as never); break;
        case "memory.read":    out = await readTool.handle(a as never); break;
        case "memory.search":  out = await searchTool.handle(a as never); break;
        case "memory.promote": out = await promoteTool.handle(a as never); break;
        default: throw new ToolError("internal_error", `Unknown tool: ${name}`);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
    } catch (err) {
      const corr = ulid();
      if (err instanceof ToolError) {
        log.debug({ corr, kind: err.kind, message: err.message }, "tool error");
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(err.toPayload()) }],
        };
      }
      log.error({ corr, err }, "uncaught tool error");
      auditor.write({
        op: `${name.replace("memory.", "")}:failed` as never,
        agent: sessionAgent,
        session,
        correlation_id: corr,
        message: (err as Error).message,
      });
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({ kind: "internal_error", correlation_id: corr }),
        }],
      };
    }
  });

  return {
    server,
    async shutdown() {
      await watcher.close();
      index.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/e2e/server.test.ts
```

Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/server packages/mcp/test/e2e
git commit -m "feat(mcp): wire MCP server (stdio + 4 tools)"
```

---

### Task 25: CLI — `init`

**Files:**
- Create: `packages/mcp/src/cli/init.ts`
- Create: `packages/mcp/test/integration/cli/init.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/init.js";

describe("init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-init-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("materializes a vault from the template", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    expect(existsSync(join(target, "_system/schema/_common.json"))).toBe(true);
    expect(existsSync(join(target, "_system/config.yaml"))).toBe(true);
    expect(existsSync(join(target, "memory/decisions/sample-decision.md"))).toBe(true);
    const cfg = readFileSync(join(target, "_system/config.yaml"), "utf8");
    expect(cfg).toMatch(/vault_id:/);
  });

  it("refuses to overwrite a non-empty target", async () => {
    const target = join(dir, "vault");
    writeFileSync(join(dir, "vault"), "");  // file in the way
    await expect(runInit({ target })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/init.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/cli/init.ts`**

```ts
import { cpSync, existsSync, readdirSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { vaultPaths } from "../vault/paths.js";

const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

export interface InitOpts {
  target: string;
  git?: boolean;
}

export async function runInit(opts: InitOpts): Promise<{ target: string }> {
  const target = resolve(opts.target);
  if (existsSync(target)) {
    const stat = statSync(target);
    if (!stat.isDirectory()) throw new Error(`Target exists and is not a directory: ${target}`);
    if (readdirSync(target).length > 0) {
      throw new Error(`Refusing to init: target is non-empty: ${target}`);
    }
  }
  cpSync(VAULT_TEMPLATE, target, { recursive: true });

  const paths = vaultPaths(target);
  const examplePath = `${paths.configFile}.example`;
  const altExample = paths.configFile + ".example"; // belt-and-suspenders
  const sourceCfg = existsSync(examplePath) ? examplePath : altExample;
  if (existsSync(sourceCfg) && !existsSync(paths.configFile)) {
    renameSync(sourceCfg, paths.configFile);
  }

  // Stamp vault_id
  const cfgRaw = readFileSync(paths.configFile, "utf8");
  if (!/^vault_id:/m.test(cfgRaw)) {
    writeFileSync(paths.configFile, cfgRaw.trimEnd() + `\nvault_id: ${ulid()}\n`);
  }

  if (opts.git) {
    const { execSync } = await import("node:child_process");
    execSync("git init -q && git add -A && git commit -q -m 'init: scaffold vault-mem'", {
      cwd: target,
      stdio: "ignore",
    });
  }

  return { target };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/init.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/cli/init.ts packages/mcp/test/integration/cli/init.test.ts
git commit -m "feat(mcp): add CLI init subcommand"
```

---

### Task 26: CLI — `doctor`

**Files:**
- Create: `packages/mcp/src/cli/doctor.ts`
- Create: `packages/mcp/test/integration/cli/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/init.js";
import { runDoctor } from "../../../src/cli/doctor.js";

describe("doctor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-doctor-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("reports all-pass on a freshly initialized vault", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const result = await runDoctor({ vault: target });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it("fails when config.yaml is missing", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    rmSync(join(target, "_system/config.yaml"));
    const result = await runDoctor({ vault: target });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "config")?.pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/doctor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/mcp/src/cli/doctor.ts`**

```ts
import { existsSync, statSync } from "node:fs";
import { vaultPaths, MEMORY_TYPES } from "../vault/paths.js";
import { loadConfig } from "../config/index.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";

export interface DoctorOpts { vault: string }

export interface CheckResult { name: string; pass: boolean; detail?: string }
export interface DoctorResult { ok: boolean; checks: CheckResult[] }

export async function runDoctor(opts: DoctorOpts): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  const paths = vaultPaths(opts.vault);

  checks.push({
    name: "vault_root",
    pass: existsSync(paths.root) && statSync(paths.root).isDirectory(),
  });

  const folders = [
    paths.systemDir, paths.schemaDir, paths.archiveDir,
    ...MEMORY_TYPES.flatMap((t) => [paths.memoryDir(t), paths.inboxDir(t)]),
  ];
  checks.push({
    name: "folders",
    pass: folders.every((f) => existsSync(f)),
    detail: folders.filter((f) => !existsSync(f)).join(", ") || undefined,
  });

  let schemasOk = true;
  try { loadSchemas(opts.vault); } catch (e) { schemasOk = false; }
  checks.push({ name: "schemas", pass: schemasOk });

  let configOk = true;
  try { loadConfig(opts.vault); } catch (e) {
    configOk = false;
    checks.push({ name: "config", pass: false, detail: (e as Error).message });
  }
  if (configOk) checks.push({ name: "config", pass: true });

  let indexOk = true;
  try {
    const idx = openIndex(paths.indexFile);
    idx.search({ query: "x", limit: 1 });
    idx.close();
  } catch { indexOk = false; }
  checks.push({ name: "index", pass: indexOk });

  checks.push({ name: "audit_log", pass: existsSync(paths.auditFile) });

  return { ok: checks.every((c) => c.pass), checks };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/doctor.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/cli/doctor.ts packages/mcp/test/integration/cli/doctor.test.ts
git commit -m "feat(mcp): add CLI doctor subcommand"
```

---

### Task 27: CLI — `reindex` and `tail-audit`

**Files:**
- Create: `packages/mcp/src/cli/reindex.ts`
- Create: `packages/mcp/src/cli/tail-audit.ts`
- Create: `packages/mcp/test/integration/cli/reindex.test.ts`
- Create: `packages/mcp/test/integration/cli/tail-audit.test.ts`

- [ ] **Step 1: Write `packages/mcp/src/cli/reindex.ts`**

```ts
import { existsSync, rmSync } from "node:fs";
import { vaultPaths } from "../vault/paths.js";
import { loadSchemas } from "../schema/index.js";
import { openIndex } from "../index/sqlite.js";
import { populateIndex } from "../index/populate.js";

export interface ReindexOpts { vault: string }
export interface ReindexResult { count: number; ms: number }

export async function runReindex(opts: ReindexOpts): Promise<ReindexResult> {
  const paths = vaultPaths(opts.vault);
  if (existsSync(paths.indexFile)) rmSync(paths.indexFile);
  if (existsSync(paths.indexFile + "-wal")) rmSync(paths.indexFile + "-wal");
  if (existsSync(paths.indexFile + "-shm")) rmSync(paths.indexFile + "-shm");

  const schemas = loadSchemas(opts.vault);
  const idx = openIndex(paths.indexFile);
  const t0 = Date.now();
  const { count } = await populateIndex({ vault: opts.vault, index: idx, schemas });
  idx.close();
  return { count, ms: Date.now() - t0 };
}
```

- [ ] **Step 2: Write `packages/mcp/src/cli/tail-audit.ts`**

```ts
import { createReadStream, statSync, watchFile, unwatchFile } from "node:fs";
import { createInterface } from "node:readline";
import { vaultPaths } from "../vault/paths.js";

export interface TailAuditOpts {
  vault: string;
  n?: number;
  follow?: boolean;
  out?: NodeJS.WritableStream;
}

export async function runTailAudit(opts: TailAuditOpts): Promise<void> {
  const out = opts.out ?? process.stdout;
  const paths = vaultPaths(opts.vault);
  const { auditFile } = paths;
  const lines = await readLastN(auditFile, opts.n ?? 50);
  for (const ln of lines) out.write(formatLine(ln) + "\n");
  if (!opts.follow) return;

  let lastSize = statSync(auditFile).size;
  await new Promise<void>((resolve) => {
    watchFile(auditFile, { interval: 250 }, async (curr) => {
      if (curr.size > lastSize) {
        const chunk = await readFromOffset(auditFile, lastSize, curr.size);
        for (const ln of chunk.split("\n")) {
          if (ln.trim()) out.write(formatLine(ln) + "\n");
        }
        lastSize = curr.size;
      }
    });
    process.once("SIGINT", () => { unwatchFile(auditFile); resolve(); });
  });
}

async function readLastN(path: string, n: number): Promise<string[]> {
  const all: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path) });
    rl.on("line", (ln) => { if (ln.trim()) all.push(ln); });
    rl.on("close", () => resolve());
    rl.on("error", reject);
  });
  return all.slice(-n);
}

async function readFromOffset(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
    let buf = "";
    stream.on("data", (c) => { buf += c; });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

function formatLine(raw: string): string {
  try {
    const j = JSON.parse(raw);
    return `${j.ts} ${j.op.padEnd(16)} ${j.agent ?? "-"}  ${j.id ?? j.query_hash ?? ""}`;
  } catch {
    return raw;
  }
}
```

- [ ] **Step 3: Write `packages/mcp/test/integration/cli/reindex.test.ts`**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { runInit } from "../../../src/cli/init.js";
import { runReindex } from "../../../src/cli/reindex.js";
import { vaultPaths } from "../../../src/vault/paths.js";

describe("reindex", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-reidx-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds the FTS index from disk", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    mkdirSync(paths.memoryDir("decision"), { recursive: true });
    writeFileSync(
      paths.memoryFile("decision", "mem_2026-04-27_zzzzzz", "memory"),
      matter.stringify("body", {
        id: "mem_2026-04-27_zzzzzz",
        type: "decision",
        title: "rebuilt",
        agent: "human",
        session: null,
        created: "2026-04-27T14:32:00.000Z",
        updated: "2026-04-27T14:32:00.000Z",
        status: "active",
        schema_version: "0.1",
        confidence: 1, sources: [], contradicts: [], supersedes: [], tags: [],
        project: null, ttl_days: null, human_reviewed: false, human_approved: null,
      }),
    );
    const result = await runReindex({ vault: target });
    expect(result.count).toBeGreaterThanOrEqual(2); // sample + the new one
  });
});
```

- [ ] **Step 4: Write `packages/mcp/test/integration/cli/tail-audit.test.ts`**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runInit } from "../../../src/cli/init.js";
import { runTailAudit } from "../../../src/cli/tail-audit.js";
import { vaultPaths } from "../../../src/vault/paths.js";

describe("tail-audit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-mem-tail-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it("prints the last N audit lines", async () => {
    const target = join(dir, "vault");
    await runInit({ target });
    const paths = vaultPaths(target);
    for (let i = 0; i < 10; i++) {
      appendFileSync(paths.auditFile, JSON.stringify({ ts: "2026-04-27T0:00:0Z", v: 1, op: "write", id: `mem_2026-04-27_aaaa${i}` }) + "\n");
    }
    let captured = "";
    const out = new Writable({
      write(chunk, _enc, cb) { captured += chunk.toString(); cb(); },
    });
    await runTailAudit({ vault: target, n: 3, out });
    const lines = captured.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("mem_2026-04-27_aaaa9");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail then pass**

```bash
pnpm --filter @vault-mem/mcp test test/integration/cli/reindex.test.ts test/integration/cli/tail-audit.test.ts
```

Expected: 2 passing total after Steps 1–4 are complete.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/cli/reindex.ts packages/mcp/src/cli/tail-audit.ts packages/mcp/test/integration/cli/reindex.test.ts packages/mcp/test/integration/cli/tail-audit.test.ts
git commit -m "feat(mcp): add CLI reindex and tail-audit subcommands"
```

---

### Task 28: Top-level CLI dispatch + server entry

**Files:**
- Modify: `packages/mcp/src/index.ts`

- [ ] **Step 1: Replace `packages/mcp/src/index.ts` content**

```ts
import { Command } from "commander";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server/index.js";
import { runInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { runReindex } from "./cli/reindex.js";
import { runTailAudit } from "./cli/tail-audit.js";
import { resolveVaultPath } from "./vault/paths.js";
import { createLogger } from "./log.js";

export const VERSION = "0.1.0";

async function runServer(vault: string): Promise<void> {
  const log = createLogger();
  const built = await buildServer({ vault });
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  log.info({ vault }, "vault-mem-mcp ready (stdio)");
  process.once("SIGINT", async () => { await built.shutdown(); process.exit(0); });
  process.once("SIGTERM", async () => { await built.shutdown(); process.exit(0); });
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("vault-mem-mcp").version(VERSION);

  program
    .command("init")
    .description("Materialize a new vault from the bundled template")
    .option("--target <path>", "Target directory", `${homedir()}/vault-mem`)
    .option("--git", "git init the new vault and make an initial commit")
    .action(async (opts: { target: string; git?: boolean }) => {
      const out = await runInit({ target: opts.target, git: opts.git });
      console.log(`Initialized vault at ${out.target}`);
    });

  program
    .command("doctor")
    .description("Validate vault structure and config")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const result = await runDoctor({ vault });
      for (const c of result.checks) {
        console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
      }
      process.exit(result.ok ? 0 : 1);
    });

  program
    .command("reindex")
    .description("Drop and rebuild the FTS index")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      const r = await runReindex({ vault });
      console.log(`Indexed ${r.count} memories in ${r.ms}ms`);
    });

  program
    .command("tail-audit")
    .description("Print recent audit lines")
    .option("--vault <path>", "Vault root", undefined)
    .option("-n <count>", "Number of lines", "50")
    .option("--follow", "Follow new lines", false)
    .action(async (opts: { vault?: string; n: string; follow: boolean }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      await runTailAudit({ vault, n: parseInt(opts.n, 10), follow: opts.follow });
    });

  program
    .command("serve", { isDefault: true })
    .description("Run the MCP server over stdio (default)")
    .option("--vault <path>", "Vault root", undefined)
    .action(async (opts: { vault?: string }) => {
      const vault = resolveVaultPath({ flag: opts.vault, env: process.env.VAULT_MEM_PATH });
      await runServer(vault);
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify build**

```bash
pnpm --filter @vault-mem/mcp build
```

Expected: success, `dist/index.js` exists.

- [ ] **Step 3: Verify the binary runs `init` end-to-end against a real temp directory**

```bash
TMP=$(mktemp -d) && node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault" && node packages/mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"; rm -rf "$TMP"
```

Expected: "Initialized vault at …" then six PASS lines, exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/index.ts
git commit -m "feat(mcp): add top-level CLI dispatch with commander"
```

---

### Task 29: Documentation + final verification

**Files:**
- Create: `README.md` (repo root)
- Modify: `CLAUDE.md` (add the run/test/build sections that were stubbed out)

- [ ] **Step 1: Write `README.md` (repo root)**

```markdown
# Vault-Mem

Personal-use, local-first shared memory layer for an agent stack (Claude Code, Cursor, Frozo Founder OS). See [`vault-mem-prd.md`](vault-mem-prd.md) for context and [`docs/superpowers/specs/`](docs/superpowers/specs/) for current designs.

## Requirements

- Node 20+
- pnpm 9+
- macOS or Linux

## Quick start

```bash
pnpm install
pnpm --filter @vault-mem/mcp build
node packages/mcp/bin/vault-mem-mcp init                 # creates ~/vault-mem/
node packages/mcp/bin/vault-mem-mcp doctor               # health check
node packages/mcp/bin/vault-mem-mcp                       # run MCP server (stdio)
```

## Register with Claude Code

Add to `~/.config/claude-code/mcp.json`:

```json
{
  "mcpServers": {
    "vault-mem": {
      "command": "node",
      "args": ["/absolute/path/to/frozo-vault-mem/packages/mcp/bin/vault-mem-mcp"],
      "env": { "VAULT_MEM_PATH": "/Users/<you>/vault-mem" }
    }
  }
}
```

## Tools

- `memory.read` · `memory.write` · `memory.search` · `memory.promote`

## CLI

- `init` · `doctor` · `reindex` · `tail-audit`

## Development

```bash
pnpm test            # all tests
pnpm typecheck
pnpm --filter @vault-mem/mcp dev    # tsx-run during dev
```
```

- [ ] **Step 2: Update `CLAUDE.md` "Things to do early when code lands" section**

In `CLAUDE.md`, replace the final section ("Things to do early when code lands") with:

```markdown
## Running and developing

- **Server (default mode):** `node packages/mcp/bin/vault-mem-mcp` — runs MCP over stdio. Vault path resolves from `--vault` flag → `VAULT_MEM_PATH` env → `~/vault-mem/`.
- **Bootstrap a vault:** `node packages/mcp/bin/vault-mem-mcp init [--target PATH] [--git]`
- **Health check:** `node packages/mcp/bin/vault-mem-mcp doctor [--vault PATH]`
- **Rebuild FTS index:** `node packages/mcp/bin/vault-mem-mcp reindex [--vault PATH]`
- **Tail audit log:** `node packages/mcp/bin/vault-mem-mcp tail-audit [--vault PATH] [-n 50] [--follow]`
- **Tests:** `pnpm test` (root) or `pnpm --filter @vault-mem/mcp test`
- **Single test file:** `pnpm --filter @vault-mem/mcp test path/to/file.test.ts`
- **Type check:** `pnpm typecheck`
- **Dev (TS without build):** `pnpm --filter @vault-mem/mcp dev`

## Where things live

- `vault-template/` — the canonical scaffolding `init` copies from. Schemas, templates, and the sample memory live here. Edit only when adding/changing schema artifacts.
- `packages/mcp/src/` — server source, organized by responsibility (`config/`, `schema/`, `vault/`, `id/`, `audit/`, `index/`, `tools/`, `cli/`, `server/`). Tests are co-located (`*.test.ts`) for unit work; integration and e2e tests live under `packages/mcp/test/`.
- `_system/index.sqlite` (inside any materialized vault) — gitignored. Always rebuildable via `reindex`. The `.md` files are the source of truth.
```

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
pnpm typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 4: Verify acceptance criteria from the spec**

Run through Section 12 of the spec:

```bash
# 1. pnpm install works
pnpm install

# 2. Build succeeds
pnpm --filter @vault-mem/mcp build

# 3. Tests pass
pnpm --filter @vault-mem/mcp test

# 4. init produces a valid vault
TMP=$(mktemp -d)
node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault" --git

# 5. doctor reports all-pass
node packages/mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"

# 6+7: register the server in Claude Code's MCP config and run a manual session
#       (Manual step — see README "Register with Claude Code" and try the
#       happy-path round-trip described in the spec §12.6)

# Cleanup
rm -rf "$TMP"
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add README and update CLAUDE.md with run/test commands"
```

---

## Self-review

This section was completed during plan authoring; preserved here as a record:

**Spec coverage:** Every requirement in the spec maps to at least one task —
- §3.1 monorepo layout → Task 1, 2, 3
- §3.2 runtime → Task 1, 2
- §3.3 vault path resolution → Task 10
- §3.4 module boundaries → Tasks 8–22 collectively
- §4 vault scaffolding → Tasks 3, 4, 5, 6, 7
- §4.2 schema additivity rule → documented in Task 3 (vault README) and Task 29 (CLAUDE.md)
- §5.1–5.5 tool API → Tasks 18, 19, 20, 21
- §6.1–6.4 CLI subcommands → Tasks 25, 26, 27
- §7 data flow → Tasks 18, 19, 20, 21, 22
- §8 storage (atomic write, locks, audit JSONL, FTS) → Tasks 9, 14, 13, 16
- §9 config + startup → Task 12, 24, 26
- §10 error handling → Task 15 (errors), Tasks 18–24 use ToolError
- §11 testing → unit tests in Tasks 8–16; integration in 18–21, 25–27; e2e in 24
- §12 acceptance criteria → Task 29 verification step

**Placeholder scan:** No "TBD/TODO/implement later" left. Every code block contains the actual code an executor needs.

**Type consistency:** `IndexRow`, `IndexHandle`, `MemoryType`, `Location`, `CompiledSchemas`, `ValidationResult`, `WriteToolInput/Output`, `ReadToolInput/Output`, `PromoteToolInput/Output`, `AuditEntry`, `ToolError` are defined exactly once and reused with matching shapes across tasks.
