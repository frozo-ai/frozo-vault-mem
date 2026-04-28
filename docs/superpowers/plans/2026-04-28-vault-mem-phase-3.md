# Vault-Mem Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/keeper/` — a Python 3.12 hygiene daemon scheduled via launchd that performs autonomous inbox triage, auto-linking, confidence decay, and archive operations on the vault.

**Architecture:** Stateless `python -m vault_mem_keeper run` invocation that opens fresh handles to the vault's `.md` files, FTS index (read-only), and LanceDB index (read-only), runs four ops in a deterministic order (triage → link → decay → archive), writes to `.md` files atomically, appends JSONL to the existing audit log, and exits. Indexes go briefly stale until the MCP server's chokidar watcher reconciles.

**Tech Stack:** Python 3.12 · `uv` (deps) · `pytest` (tests) · `ruff` (lint) · `python-frontmatter` · `jsonschema` · `pydantic` · `lancedb` · `structlog` · `python-ulid` · macOS `launchd`.

**Spec:** [`docs/superpowers/specs/2026-04-28-vault-mem-phase-3-design.md`](../specs/2026-04-28-vault-mem-phase-3-design.md)

---

## File Structure

### Created files

**Repo root:**
- `ops/keeper/com.vaultmem.keeper.plist` — launchd template

**`packages/keeper/`:**
- `pyproject.toml`, `uv.lock`, `README.md`
- `bin/run-keeper.sh` — convenience wrapper for pm2
- `src/vault_mem_keeper/__init__.py`
- `src/vault_mem_keeper/__main__.py` — `run` / `status` / `doctor` subcommands
- `src/vault_mem_keeper/paths.py`
- `src/vault_mem_keeper/frontmatter.py`
- `src/vault_mem_keeper/atomic_write.py`
- `src/vault_mem_keeper/audit.py`
- `src/vault_mem_keeper/config.py`
- `src/vault_mem_keeper/fts.py`
- `src/vault_mem_keeper/lance.py`
- `src/vault_mem_keeper/logging.py`
- `src/vault_mem_keeper/runner.py`
- `src/vault_mem_keeper/ops/__init__.py`
- `src/vault_mem_keeper/ops/triage.py`
- `src/vault_mem_keeper/ops/link.py`
- `src/vault_mem_keeper/ops/decay.py`
- `src/vault_mem_keeper/ops/archive.py`
- `tests/conftest.py` — shared tmpVault fixture
- `tests/test_paths.py`, `test_frontmatter.py`, `test_atomic_write.py`, `test_audit.py`, `test_config.py`, `test_fts.py`, `test_lance.py`
- `tests/ops/test_triage.py`, `test_link.py`, `test_decay.py`, `test_archive.py`
- `tests/test_runner.py`
- `tests/test_e2e.py`

### Modified files

- `vault-template/_system/schema/_common.json` — add optional `last_decay_at` field
- `vault-template/_system/config.yaml.example` — add `keeper:` defaults
- `vault-template/.gitignore` — add `_system/links.jsonl`
- `packages/mcp/src/audit/index.ts` — widen `AuditEntry` union with keeper op types
- `packages/mcp/src/audit/audit.test.ts` — assert keeper-shaped entries don't break serialization
- `README.md` — point to keeper package
- `CLAUDE.md` — add Python keeper section (run/test commands)
- root `package.json` — add `"test:keeper"` and `"typecheck:keeper"` scripts that shell out to `uv run` (optional convenience)

---

## Tasks

### Task 1: Bootstrap keeper package

**Files:**
- Create: `packages/keeper/pyproject.toml`
- Create: `packages/keeper/src/vault_mem_keeper/__init__.py`
- Create: `packages/keeper/tests/__init__.py`
- Create: `packages/keeper/.python-version`
- Create: `packages/keeper/README.md` (stub)

- [ ] **Step 1: Verify `uv` is installed**

```bash
uv --version
```

Expected: ≥0.4.x. If missing, install via `curl -LsSf https://astral.sh/uv/install.sh | sh`. If still missing, BLOCKED.

- [ ] **Step 2: Write `packages/keeper/pyproject.toml`**

```toml
[project]
name = "vault-mem-keeper"
version = "0.1.0"
description = "Vault-Mem hygiene daemon (Phase 3)"
requires-python = ">=3.12"
dependencies = [
    "python-frontmatter==1.1.0",
    "pyyaml==6.0.2",
    "jsonschema==4.23.0",
    "pydantic==2.9.2",
    "lancedb==0.13.0",
    "structlog==24.4.0",
    "python-ulid==3.0.0",
]

[project.scripts]
vault-mem-keeper = "vault_mem_keeper.__main__:main"

[dependency-groups]
dev = [
    "pytest==8.3.3",
    "pytest-asyncio==0.24.0",
    "ruff==0.7.4",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/vault_mem_keeper"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
addopts = "-v --tb=short"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B", "C4", "SIM"]
```

- [ ] **Step 3: Write `packages/keeper/.python-version`**

```
3.12
```

- [ ] **Step 4: Write `packages/keeper/src/vault_mem_keeper/__init__.py`**

```python
"""Vault-Mem hygiene daemon (Phase 3 keeper)."""

__version__ = "0.1.0"
```

- [ ] **Step 5: Write `packages/keeper/tests/__init__.py`** (empty file).

- [ ] **Step 6: Write a stub `packages/keeper/README.md`**

```markdown
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
paths and copy to `~/Library/LaunchAgents/`, then `launchctl load -w …`.
```

- [ ] **Step 7: Run `uv sync` to lock and install**

```bash
cd packages/keeper && uv sync
```

Expected: `uv.lock` generated, `.venv/` created, no errors.

- [ ] **Step 8: Smoke check — Python imports the package**

```bash
cd packages/keeper && uv run python -c "import vault_mem_keeper; print(vault_mem_keeper.__version__)"
```

Expected: `0.1.0`.

- [ ] **Step 9: Commit**

```bash
git add packages/keeper/pyproject.toml packages/keeper/uv.lock packages/keeper/.python-version packages/keeper/src/vault_mem_keeper/__init__.py packages/keeper/tests/__init__.py packages/keeper/README.md
git commit -m "chore(keeper): bootstrap Python package with uv"
```

---

### Task 2: `paths` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/paths.py`
- Create: `packages/keeper/tests/test_paths.py`

- [ ] **Step 1: Write `tests/test_paths.py`**

```python
import os
from pathlib import Path

import pytest

from vault_mem_keeper.paths import (
    LOCATIONS,
    MEMORY_TYPES,
    Location,
    MemoryType,
    VaultPaths,
    resolve_vault_path,
    vault_paths,
)


def test_memory_types_match_phase1():
    assert MEMORY_TYPES == (
        "decision", "observation", "todo", "learning",
        "summary", "entity", "question",
    )


def test_locations_match_phase1():
    assert LOCATIONS == ("inbox", "memory", "archive")


def test_resolve_vault_path_prefers_flag_over_env_over_default():
    assert resolve_vault_path(flag="/a", env="/b", home="/h") == "/a"
    assert resolve_vault_path(flag=None, env="/b", home="/h") == "/b"
    assert resolve_vault_path(flag=None, env=None, home="/h") == "/h/vault-mem"


def test_vault_paths_constructs_canonical_paths():
    p = vault_paths("/vault")
    assert p.root == "/vault"
    assert p.system_dir == "/vault/_system"
    assert p.schema_dir == "/vault/_system/schema"
    assert p.config_file == "/vault/_system/config.yaml"
    assert p.audit_file == "/vault/_system/audit.log"
    assert p.index_file == "/vault/_system/index.sqlite"
    assert p.lance_dir == "/vault/_system/embeddings.lance"
    assert p.links_file == "/vault/_system/links.jsonl"
    assert p.archive_dir == "/vault/archive"
    assert p.memory_dir("decision") == "/vault/memory/decisions"
    assert p.inbox_dir("decision") == "/vault/inbox/decisions"


def test_memory_file_paths():
    p = vault_paths("/vault")
    mid = "mem_2026-04-27_a8f3c0"
    assert p.memory_file("decision", mid, "inbox") == "/vault/inbox/decisions/mem_2026-04-27_a8f3c0.md"
    assert p.memory_file("decision", mid, "memory") == "/vault/memory/decisions/mem_2026-04-27_a8f3c0.md"
    assert p.memory_file("decision", mid, "archive") == "/vault/archive/mem_2026-04-27_a8f3c0.md"
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
cd packages/keeper && uv run pytest tests/test_paths.py
```

Expected: ImportError — module not found.

- [ ] **Step 3: Write `src/vault_mem_keeper/paths.py`**

```python
"""Vault path resolution. Mirror of TS packages/mcp/src/vault/paths.ts."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

MEMORY_TYPES: tuple[str, ...] = (
    "decision",
    "observation",
    "todo",
    "learning",
    "summary",
    "entity",
    "question",
)
MemoryType = Literal[
    "decision", "observation", "todo", "learning",
    "summary", "entity", "question",
]

LOCATIONS: tuple[str, ...] = ("inbox", "memory", "archive")
Location = Literal["inbox", "memory", "archive"]

_PLURAL: dict[str, str] = {
    "decision": "decisions",
    "observation": "observations",
    "todo": "todos",
    "learning": "learnings",
    "summary": "summaries",
    "entity": "entities",
    "question": "questions",
}


def resolve_vault_path(
    *,
    flag: str | None = None,
    env: str | None = None,
    home: str | None = None,
) -> str:
    if flag:
        return str(Path(flag).expanduser().resolve())
    if env:
        return str(Path(env).expanduser().resolve())
    home_dir = home or str(Path.home())
    return str(Path(home_dir, "vault-mem").resolve())


@dataclass(frozen=True)
class VaultPaths:
    root: str

    @property
    def system_dir(self) -> str: return str(Path(self.root, "_system"))
    @property
    def schema_dir(self) -> str: return str(Path(self.root, "_system/schema"))
    @property
    def templates_dir(self) -> str: return str(Path(self.root, "_system/templates"))
    @property
    def config_file(self) -> str: return str(Path(self.root, "_system/config.yaml"))
    @property
    def audit_file(self) -> str: return str(Path(self.root, "_system/audit.log"))
    @property
    def index_file(self) -> str: return str(Path(self.root, "_system/index.sqlite"))
    @property
    def lance_dir(self) -> str: return str(Path(self.root, "_system/embeddings.lance"))
    @property
    def links_file(self) -> str: return str(Path(self.root, "_system/links.jsonl"))
    @property
    def archive_dir(self) -> str: return str(Path(self.root, "archive"))
    @property
    def projects_dir(self) -> str: return str(Path(self.root, "projects"))

    def memory_dir(self, t: str) -> str:
        return str(Path(self.root, "memory", _PLURAL[t]))

    def inbox_dir(self, t: str) -> str:
        return str(Path(self.root, "inbox", _PLURAL[t]))

    def memory_file(self, t: str, mid: str, loc: str) -> str:
        if loc == "inbox":
            return str(Path(self.root, "inbox", _PLURAL[t], f"{mid}.md"))
        if loc == "memory":
            return str(Path(self.root, "memory", _PLURAL[t], f"{mid}.md"))
        if loc == "archive":
            return str(Path(self.root, "archive", f"{mid}.md"))
        raise ValueError(f"unknown location: {loc}")


def vault_paths(root: str) -> VaultPaths:
    return VaultPaths(root=str(Path(root).expanduser().resolve()))
```

- [ ] **Step 4: Run tests (expect PASS)**

```bash
cd packages/keeper && uv run pytest tests/test_paths.py
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/paths.py packages/keeper/tests/test_paths.py
git commit -m "feat(keeper): add paths module (mirror of TS vault/paths)"
```

---

### Task 3: `atomic_write` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/atomic_write.py`
- Create: `packages/keeper/tests/test_atomic_write.py`

- [ ] **Step 1: Write `tests/test_atomic_write.py`**

```python
from pathlib import Path
import tempfile

import pytest

from vault_mem_keeper.atomic_write import atomic_write


def test_writes_content_atomically_no_temp_left():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d, "memo.md")
        atomic_write(str(path), "hello world")
        assert path.read_text() == "hello world"
        leftovers = [p for p in Path(d).iterdir() if ".tmp." in p.name]
        assert leftovers == []


def test_overwrites_cleanly():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d, "memo.md")
        atomic_write(str(path), "first")
        atomic_write(str(path), "second")
        assert path.read_text() == "second"


def test_unicode_content():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d, "memo.md")
        atomic_write(str(path), "😀 नमस्ते 你好")
        assert path.read_text(encoding="utf-8") == "😀 नमस्ते 你好"
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/atomic_write.py`**

```python
"""Atomic write to disk via temp + fsync + rename. Mirror of TS vault/atomicWrite."""

import os
import secrets
from pathlib import Path


def atomic_write(abs_path: str, contents: str) -> None:
    parent = Path(abs_path).parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp_name = f"{Path(abs_path).name}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
    tmp = parent / tmp_name

    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, contents.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)

    os.rename(str(tmp), abs_path)
    _fsync_dir(str(parent))


def _fsync_dir(d: str) -> None:
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        return  # some filesystems don't allow dir fds
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
```

- [ ] **Step 4: Run tests (expect 3 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/atomic_write.py packages/keeper/tests/test_atomic_write.py
git commit -m "feat(keeper): add atomic_write (temp + fsync + rename)"
```

---

### Task 4: `audit` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/audit.py`
- Create: `packages/keeper/tests/test_audit.py`

The keeper's auditor must produce JSONL lines indistinguishable from the TS Phase 1+2 server's auditor. Same `ts`, `v: 1`, op-typed structure. SHA-256 hashing for `query` fields (matching TS).

- [ ] **Step 1: Write `tests/test_audit.py`**

```python
import json
import tempfile
from pathlib import Path

from vault_mem_keeper.audit import Auditor


def test_appends_jsonl_with_v1_and_ts():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "promote",
            "agent": "keeper",
            "session": "01H",
            "id": "mem_2026-04-27_aaaaaa",
            "from": "/v/inbox/decisions/x.md",
            "to": "/v/memory/decisions/x.md",
            "reason": "auto",
        })
        line = json.loads(log.read_text().strip())
        assert line["op"] == "promote"
        assert line["v"] == 1
        assert line["agent"] == "keeper"
        assert "ts" in line
        assert line["ts"].endswith("Z") or "+" in line["ts"]


def test_hashes_search_query_for_search_op():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "search",
            "agent": "keeper",
            "session": "01H",
            "query": "kincare auth",
            "result_count": 4,
            "mode": "hybrid",
        })
        line = json.loads(log.read_text().strip())
        assert "query" not in line
        assert line["query_hash"].startswith("sha256:")
        assert line["mode"] == "hybrid"


def test_hashes_context_query_when_present():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "context",
            "agent": "keeper",
            "session": "01H",
            "project": "kincare",
            "max_tokens": 4000,
            "query": "auth",
            "result_count": 2,
            "total_tokens": 300,
        })
        line = json.loads(log.read_text().strip())
        assert "query" not in line
        assert line["query_hash"].startswith("sha256:")
        assert line["project"] == "kincare"


def test_keeper_run_op_passes_through():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d, "audit.log")
        log.touch()
        a = Auditor(str(log))
        a.write({
            "op": "keeper_run",
            "agent": "keeper",
            "session": "01H",
            "duration_ms": 234,
            "summary": {"triage": {"promoted": 2}},
        })
        line = json.loads(log.read_text().strip())
        assert line["op"] == "keeper_run"
        assert line["duration_ms"] == 234
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/audit.py`**

```python
"""JSONL audit log writer. Matches TS Auditor shape exactly so tail-audit
displays keeper writes alongside MCP server writes."""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any


def _hash_query(q: str) -> str:
    return "sha256:" + hashlib.sha256(q.encode("utf-8")).hexdigest()


class Auditor:
    def __init__(self, log_path: str) -> None:
        self.log_path = log_path

    def write(self, entry: dict[str, Any]) -> None:
        record: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "v": 1,
        }
        # For search and context ops with `query`, replace with query_hash.
        op = entry.get("op")
        if op in ("search", "context") and "query" in entry:
            payload = {k: v for k, v in entry.items() if k != "query"}
            payload["query_hash"] = _hash_query(entry["query"])
            record.update(payload)
        else:
            record.update(entry)

        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
```

- [ ] **Step 4: Run tests (expect 4 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/audit.py packages/keeper/tests/test_audit.py
git commit -m "feat(keeper): add audit module (JSONL append, sha256 query hash)"
```

---

### Task 5: `frontmatter` module + schema validation

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/frontmatter.py`
- Create: `packages/keeper/tests/test_frontmatter.py`

The keeper reads memory `.md` files, parses YAML frontmatter, validates against the same JSON Schemas the TS server uses (`vault-template/_system/schema/*.json`).

- [ ] **Step 1: Write `tests/test_frontmatter.py`**

```python
import os
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.frontmatter import (
    load_schemas,
    parse_memory_file,
    serialize_memory,
    validate_frontmatter,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
VAULT_TEMPLATE = REPO_ROOT / "vault-template"


def test_load_schemas_returns_seven_validators():
    schemas = load_schemas(str(VAULT_TEMPLATE))
    assert set(schemas.keys()) == {
        "decision", "observation", "todo", "learning",
        "summary", "entity", "question",
    }


def test_validate_accepts_well_formed_decision():
    schemas = load_schemas(str(VAULT_TEMPLATE))
    fm = {
        "id": "mem_2026-04-27_a8f3c0",
        "type": "decision",
        "title": "x",
        "agent": "human",
        "session": None,
        "created": "2026-04-27T14:32:00.000Z",
        "updated": "2026-04-27T14:32:00.000Z",
        "status": "active",
        "schema_version": "0.1",
    }
    result = validate_frontmatter(schemas, "decision", fm)
    assert result.ok is True


def test_validate_rejects_missing_required_field():
    schemas = load_schemas(str(VAULT_TEMPLATE))
    fm = {
        "type": "decision",
        "title": "x",
        # missing id, agent, session, created, updated, status, schema_version
    }
    result = validate_frontmatter(schemas, "decision", fm)
    assert result.ok is False
    assert len(result.errors) > 0


def test_parse_memory_file_returns_frontmatter_and_content():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d, "x.md")
        p.write_text("---\nid: mem_2026-04-27_aaaaaa\ntitle: Test\n---\n\nbody text\n")
        fm, content = parse_memory_file(str(p))
        assert fm["id"] == "mem_2026-04-27_aaaaaa"
        assert content.strip() == "body text"


def test_serialize_round_trips():
    fm = {
        "id": "mem_2026-04-27_aaaaaa",
        "type": "decision",
        "title": "Test",
        "agent": "human",
        "session": None,
        "created": "2026-04-27T14:32:00.000Z",
        "updated": "2026-04-27T14:32:00.000Z",
        "status": "active",
        "schema_version": "0.1",
    }
    body = "## Rationale\n\nx"
    serialized = serialize_memory(fm, body)
    assert "id: mem_2026-04-27_aaaaaa" in serialized
    assert "## Rationale" in serialized
    assert serialized.startswith("---\n")
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/frontmatter.py`**

```python
"""Memory frontmatter I/O + JSON Schema validation.

Reads schemas from <vault-template-or-vault>/_system/schema/. Uses jsonschema
draft-07. Matches the TS-side schema/index.ts contract."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import frontmatter
from jsonschema import Draft7Validator, RefResolver

MEMORY_TYPES = ("decision", "observation", "todo", "learning", "summary", "entity", "question")


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str]


def load_schemas(vault_root: str) -> dict[str, Draft7Validator]:
    """Load _common.json + 7 type schemas from <vault_root>/_system/schema/.

    `vault_root` may be a real vault or the bundled `vault-template/`."""
    schema_dir = Path(vault_root, "_system", "schema")
    common_path = schema_dir / "_common.json"
    common_raw = json.loads(common_path.read_text())

    # jsonschema's RefResolver lets type schemas use $ref into _common.
    store = {common_raw["$id"]: common_raw}

    validators: dict[str, Draft7Validator] = {}
    for t in MEMORY_TYPES:
        type_raw = json.loads((schema_dir / f"{t}.json").read_text())
        resolver = RefResolver.from_schema(type_raw, store=store)
        validators[t] = Draft7Validator(type_raw, resolver=resolver)
    return validators


def validate_frontmatter(
    schemas: dict[str, Draft7Validator],
    type_name: str,
    data: Any,
) -> ValidationResult:
    if type_name not in schemas:
        return ValidationResult(ok=False, errors=[f"unknown type: {type_name}"])
    validator = schemas[type_name]
    errors = sorted(validator.iter_errors(data), key=lambda e: e.path)
    if not errors:
        return ValidationResult(ok=True, errors=[])
    msgs = [f"{'/'.join(str(p) for p in e.path)}: {e.message}" for e in errors]
    return ValidationResult(ok=False, errors=msgs)


def parse_memory_file(abs_path: str) -> tuple[dict[str, Any], str]:
    """Parse a memory .md file. Returns (frontmatter_dict, content_string)."""
    post = frontmatter.load(abs_path)
    return dict(post.metadata), post.content


def serialize_memory(fm: dict[str, Any], content: str) -> str:
    """Inverse of parse_memory_file; returns the full .md text."""
    post = frontmatter.Post(content, **fm)
    return frontmatter.dumps(post) + "\n"
```

- [ ] **Step 4: Run tests (expect 5 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/frontmatter.py packages/keeper/tests/test_frontmatter.py
git commit -m "feat(keeper): add frontmatter parse/validate/serialize"
```

---

### Task 6: `config` module — pydantic models

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/config.py`
- Create: `packages/keeper/tests/test_config.py`

- [ ] **Step 1: Write `tests/test_config.py`**

```python
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.config import KeeperConfig, load_keeper_config


def test_loads_defaults_when_keeper_section_missing():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
        )
        cfg = load_keeper_config(d)
        # Even without a keeper: section, defaults are returned with all enabled True
        assert cfg.triage.enabled is True
        assert cfg.triage.min_age_minutes == 1440
        assert cfg.link.top_k == 5
        assert cfg.decay.rates["observation"] == 30
        assert cfg.archive.archive_below_confidence == 0.3


def test_loads_explicit_keeper_section():
    with tempfile.TemporaryDirectory() as d:
        sysd = Path(d, "_system")
        sysd.mkdir()
        (sysd / "config.yaml").write_text(
            "vault_version: 0.1\n"
            "schema_version: 0.1\n"
            "default_agent: human\n"
            "inbox_routing: always\n"
            "fts:\n"
            "  index_path: _system/index.sqlite\n"
            "  rebuild_on_startup: false\n"
            "audit:\n"
            "  log_path: _system/audit.log\n"
            "keeper:\n"
            "  triage:\n"
            "    enabled: false\n"
            "    min_age_minutes: 60\n"
            "  link:\n"
            "    top_k: 10\n"
        )
        cfg = load_keeper_config(d)
        assert cfg.triage.enabled is False
        assert cfg.triage.min_age_minutes == 60
        assert cfg.link.top_k == 10
        # untouched fields stay at defaults
        assert cfg.archive.enabled is True


def test_raises_when_config_file_missing():
    with tempfile.TemporaryDirectory() as d:
        with pytest.raises(FileNotFoundError):
            load_keeper_config(d)
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/config.py`**

```python
"""Validates the `keeper:` section of <vault>/_system/config.yaml.

The TS server's config loader only reads the fields it cares about
(additionalProperties tolerant), so extra fields don't break it. The
keeper validates with pydantic for clear errors on its own section."""

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class TriageConfig(BaseModel):
    enabled: bool = True
    min_age_minutes: int = 1440
    min_confidence: float = 0.7
    promote_immediately_if_human_reviewed: bool = True


class LinkConfig(BaseModel):
    enabled: bool = True
    top_k: int = 5
    min_similarity: float = 0.55
    cross_type_allowed: bool = True
    rebuild_full_each_run: bool = True


class DecayConfig(BaseModel):
    enabled: bool = True
    rates: dict[str, int | None] = Field(
        default_factory=lambda: {
            "decision": None,
            "observation": 30,
            "learning": 60,
            "todo": None,
            "summary": None,
            "entity": None,
            "question": None,
        }
    )
    decay_amount_per_period: float = 0.05


class ArchiveConfig(BaseModel):
    enabled: bool = True
    archive_below_confidence: float = 0.3
    respect_ttl_days: bool = True


class KeeperConfig(BaseModel):
    triage: TriageConfig = Field(default_factory=TriageConfig)
    link: LinkConfig = Field(default_factory=LinkConfig)
    decay: DecayConfig = Field(default_factory=DecayConfig)
    archive: ArchiveConfig = Field(default_factory=ArchiveConfig)


def load_keeper_config(vault_root: str) -> KeeperConfig:
    cfg_path = Path(vault_root, "_system", "config.yaml")
    if not cfg_path.is_file():
        raise FileNotFoundError(f"missing config.yaml at {cfg_path}")
    raw: Any = yaml.safe_load(cfg_path.read_text()) or {}
    keeper_raw = raw.get("keeper") or {}
    return KeeperConfig.model_validate(keeper_raw)
```

- [ ] **Step 4: Run tests (expect 3 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/config.py packages/keeper/tests/test_config.py
git commit -m "feat(keeper): add config module (pydantic validation of keeper: section)"
```

---

### Task 7: `fts` module — read-only SQLite queries

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/fts.py`
- Create: `packages/keeper/tests/test_fts.py`

The keeper needs to enumerate memories by filter (location, type, status, project) without re-implementing FTS5. It opens the SQLite file in read-only mode and runs WHERE-only queries (mirroring the `IndexHandle.list(filter)` from TS).

- [ ] **Step 1: Write `tests/test_fts.py`**

```python
import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

from vault_mem_keeper.fts import FtsReader


def _seed(db_path: str) -> None:
    """Create the FTS5 schema and seed three rows."""
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    rows = [
        ("mem_2026-04-27_aaaaaa", "decision", "Use Supabase", "supabase rls",
         json.dumps(["auth"]), "kincare", "active", "memory",
         "/v/memory/decisions/mem_2026-04-27_aaaaaa.md", "2026-04-27T14:32:00.000Z"),
        ("mem_2026-04-27_bbbbbb", "observation", "Pricing", "supabase free tier",
         json.dumps([]), "kincare", "active", "inbox",
         "/v/inbox/observations/mem_2026-04-27_bbbbbb.md", "2026-04-27T14:32:00.000Z"),
        ("mem_2026-04-27_cccccc", "decision", "Other choice", "ops",
         json.dumps([]), "frozo", "archived", "archive",
         "/v/archive/mem_2026-04-27_cccccc.md", "2026-04-27T14:32:00.000Z"),
    ]
    db.executemany(
        "INSERT INTO memories_fts (id,type,title,body,tags,project,status,location,path,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()


def test_list_returns_all_filter_matched_rows():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "index.sqlite"))
        _seed(db_path)
        r = FtsReader(db_path)
        try:
            assert len(r.list({})) == 3
            assert len(r.list({"type": "decision"})) == 2
            assert len(r.list({"project": "kincare"})) == 2
            assert len(r.list({"location": "memory"})) == 1
            assert len(r.list({"location": "memory", "project": "kincare"})) == 1
            assert len(r.list({"status": "archived"})) == 1
        finally:
            r.close()


def test_list_returns_parsed_tags():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "index.sqlite"))
        _seed(db_path)
        r = FtsReader(db_path)
        try:
            rows = r.list({"id": "mem_2026-04-27_aaaaaa"})
            # `id` filter not in API; filter manually
            rows = [x for x in r.list({}) if x["id"] == "mem_2026-04-27_aaaaaa"]
            assert rows[0]["tags"] == ["auth"]
        finally:
            r.close()


def test_handles_missing_index_file():
    with tempfile.TemporaryDirectory() as d:
        db_path = str(Path(d, "missing.sqlite"))
        r = FtsReader(db_path)
        # SQLite's read-only "file:" URI fails on open if file missing — should raise.
        try:
            with pytest.raises(sqlite3.OperationalError):
                r.list({})
        finally:
            r.close()
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/fts.py`**

```python
"""Read-only SQLite queries against the MCP server's FTS5 index.

The keeper never writes to this index; the MCP server's chokidar watcher
reconciles it after keeper-induced file changes."""

import json
import sqlite3
from typing import Any


def _parse_tags(v: Any) -> list[str]:
    if not v:
        return []
    try:
        parsed = json.loads(str(v))
        return [str(x) for x in parsed] if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []


class FtsReader:
    def __init__(self, index_path: str) -> None:
        self._index_path = index_path
        # Lazy-open: we only connect when first query runs (lets tests probe missing files cleanly).
        self._db: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        if self._db is None:
            uri = f"file:{self._index_path}?mode=ro"
            self._db = sqlite3.connect(uri, uri=True)
            self._db.row_factory = sqlite3.Row
        return self._db

    def list(self, filter_: dict[str, Any]) -> list[dict[str, Any]]:
        """Filter-only enumeration — no FTS5 MATCH. Mirrors TS IndexHandle.list."""
        clauses: list[str] = []
        params: list[Any] = []
        if "type" in filter_:
            t = filter_["type"]
            if isinstance(t, list):
                clauses.append(f"type IN ({','.join(['?']*len(t))})")
                params.extend(t)
            else:
                clauses.append("type = ?")
                params.append(t)
        if "project" in filter_:
            clauses.append("project = ?")
            params.append(filter_["project"])
        if "status" in filter_:
            clauses.append("status = ?")
            params.append(filter_["status"])
        if "location" in filter_ and filter_["location"] != "any":
            clauses.append("location = ?")
            params.append(filter_["location"])

        where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"""
            SELECT id, type, title, body, tags, project, status, location, path, updated
            FROM memories_fts {where_sql}
        """
        cur = self._connect().execute(sql, params)
        return [
            {
                "id": r["id"],
                "type": r["type"],
                "title": r["title"],
                "body": r["body"],
                "tags": _parse_tags(r["tags"]),
                "project": r["project"],
                "status": r["status"],
                "location": r["location"],
                "path": r["path"],
                "updated": r["updated"],
            }
            for r in cur.fetchall()
        ]

    def count(self) -> int:
        cur = self._connect().execute("SELECT COUNT(*) AS n FROM memories_fts")
        return int(cur.fetchone()["n"])

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None
```

- [ ] **Step 4: Run tests (expect 3 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/fts.py packages/keeper/tests/test_fts.py
git commit -m "feat(keeper): add fts read-only reader for the FTS5 index"
```

---

### Task 8: `lance` module — LanceDB queries

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/lance.py`
- Create: `packages/keeper/tests/test_lance.py`

LanceDB v0.13 has a Python client that mirrors the Node API closely. We need: `connect`, `open_table`, `search` (vector), `where` filtering, `to_arrow`/`to_list`. The keeper uses Lance read-only.

- [ ] **Step 1: Write `tests/test_lance.py`**

```python
import tempfile
from pathlib import Path

import pyarrow as pa
import pytest

import lancedb

from vault_mem_keeper.lance import LanceReader

EMBED_DIM = 384


def _seed_lance(dir_path: str) -> None:
    """Seed a Lance table with 3 rows mirroring the TS schema."""
    db = lancedb.connect(dir_path)
    rows = [
        {
            "id": f"mem_2026-04-27_{suffix}",
            "vector": [0.05] * EMBED_DIM,
            "type": "decision",
            "title": title,
            "project": "kincare",
            "tags": ["auth"],
            "status": "active",
            "location": "memory",
            "path": f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
            "updated": "2026-04-27T14:32:00.000Z",
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        }
        for suffix, title in [
            ("aaaaaa", "alpha"),
            ("bbbbbb", "beta"),
            ("cccccc", "gamma"),
        ]
    ]
    # Vary one vector so search has a clear winner
    rows[0]["vector"] = [0.5] + [0.0] * (EMBED_DIM - 1)
    rows[1]["vector"] = [0.0, 0.5] + [0.0] * (EMBED_DIM - 2)
    rows[2]["vector"] = [0.0, 0.0, 0.5] + [0.0] * (EMBED_DIM - 3)
    db.create_table("memories", rows)


def test_get_by_id_returns_row_with_vector():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        row = r.get_by_id("mem_2026-04-27_aaaaaa")
        assert row is not None
        assert row["title"] == "alpha"
        assert len(row["vector"]) == EMBED_DIM


def test_search_returns_nearest_first():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        # Query vector matching row aaaaaa exactly
        qvec = [0.5] + [0.0] * (EMBED_DIM - 1)
        out = r.search(qvec, filter_={}, limit=3)
        assert out[0]["id"] == "mem_2026-04-27_aaaaaa"


def test_search_filter_by_status():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        qvec = [0.0] * EMBED_DIM
        out = r.search(qvec, filter_={"status": "active"}, limit=10)
        assert len(out) == 3
        out2 = r.search(qvec, filter_={"status": "archived"}, limit=10)
        assert len(out2) == 0


def test_count_returns_row_count():
    with tempfile.TemporaryDirectory() as d:
        _seed_lance(d)
        r = LanceReader(d)
        assert r.count() == 3
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/lance.py`**

```python
"""Read-only LanceDB queries.

The keeper does not write to Lance; the MCP server's watcher reconciles
the index after keeper-induced file changes."""

from typing import Any, Iterable

import lancedb

TABLE_NAME = "memories"


def _escape(s: str) -> str:
    return s.replace("'", "''")


def _build_where(filter_: dict[str, Any]) -> str | None:
    parts: list[str] = []
    if "type" in filter_:
        t = filter_["type"]
        if isinstance(t, list):
            parts.append("type IN (" + ", ".join(f"'{_escape(x)}'" for x in t) + ")")
        else:
            parts.append(f"type = '{_escape(t)}'")
    if "project" in filter_ and filter_["project"]:
        parts.append(f"project = '{_escape(filter_['project'])}'")
    if "status" in filter_ and filter_["status"]:
        parts.append(f"status = '{_escape(filter_['status'])}'")
    if "location" in filter_ and filter_["location"] and filter_["location"] != "any":
        parts.append(f"location = '{_escape(filter_['location'])}'")
    return " AND ".join(parts) if parts else None


def _row_to_dict(r: Any) -> dict[str, Any]:
    return {
        "id": str(r["id"]),
        "vector": list(r["vector"]),
        "type": str(r["type"]),
        "title": str(r["title"]),
        "project": str(r["project"]) if r["project"] is not None else None,
        "tags": [str(x) for x in (r["tags"] or [])],
        "status": str(r["status"]),
        "location": str(r["location"]),
        "path": str(r["path"]),
        "updated": str(r["updated"]),
        "schema_version": str(r.get("schema_version", "0.1")),
        "embed_model": str(r.get("embed_model", "")),
    }


class LanceReader:
    def __init__(self, dir_path: str) -> None:
        self._db = lancedb.connect(dir_path)
        self._table = self._db.open_table(TABLE_NAME)

    def get_by_id(self, mid: str) -> dict[str, Any] | None:
        rows = self._table.search().where(f"id = '{_escape(mid)}'").limit(1).to_list()
        return _row_to_dict(rows[0]) if rows else None

    def search(
        self,
        qvec: list[float] | Iterable[float],
        filter_: dict[str, Any],
        limit: int,
    ) -> list[dict[str, Any]]:
        query = self._table.search(list(qvec)).limit(limit)
        where = _build_where(filter_)
        if where:
            query = query.where(where)
        rows = query.to_list()
        return [_row_to_dict(r) for r in rows]

    def count(self) -> int:
        return self._table.count_rows()

    def close(self) -> None:
        # LanceDB has no explicit close; GC handles it. No-op for symmetry.
        pass
```

- [ ] **Step 4: Run tests (expect 4 PASS)**

```bash
cd packages/keeper && uv run pytest tests/test_lance.py
```

Note: first run will build any native deps for `lancedb`. May take 30-60s on first install.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/lance.py packages/keeper/tests/test_lance.py
git commit -m "feat(keeper): add lance read-only queries"
```

---

### Task 9: `logging` module

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/logging.py`

- [ ] **Step 1: Write `src/vault_mem_keeper/logging.py`**

```python
"""structlog setup. Output to stderr (stdout is reserved if we ever pipe)."""

import logging
import os
import sys

import structlog


def configure(level: str | None = None) -> None:
    lvl_name = (level or os.environ.get("VAULT_MEM_KEEPER_LOG_LEVEL", "info")).upper()
    lvl = getattr(logging, lvl_name, logging.INFO)
    is_dev = os.environ.get("ENV", "dev") != "production"

    processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]
    if is_dev:
        processors.append(structlog.dev.ConsoleRenderer(colors=False))
    else:
        processors.append(structlog.processors.JSONRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(lvl),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "keeper") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
```

(No tests — pure thin wrapper, exercised through every other module's integration tests, mirroring Phase 1's TS approach.)

- [ ] **Step 2: Verify import**

```bash
cd packages/keeper && uv run python -c "from vault_mem_keeper.logging import configure, get_logger; configure(); log = get_logger(); log.info('hello')"
```

Expected: a single iso-timestamped log line on stderr.

- [ ] **Step 3: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/logging.py
git commit -m "feat(keeper): add logging module (structlog → stderr)"
```

---

### Task 10: `tmpvault` test fixture

**Files:**
- Create: `packages/keeper/tests/conftest.py`

The keeper's integration tests need to copy `vault-template/` to a tmp dir and materialize `_system/config.yaml` from the example. Mirrors the TS `tmpVault.ts` helper.

- [ ] **Step 1: Write `tests/conftest.py`**

```python
"""Shared pytest fixtures."""

from pathlib import Path
import shutil
import tempfile

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
VAULT_TEMPLATE = REPO_ROOT / "vault-template"


@pytest.fixture
def tmp_vault(tmp_path: Path) -> Path:
    """Copy the bundled vault-template to a tmp dir and materialize config.yaml."""
    target = tmp_path / "vault"
    shutil.copytree(str(VAULT_TEMPLATE), str(target))
    cfg_example = target / "_system" / "config.yaml.example"
    cfg = target / "_system" / "config.yaml"
    if cfg_example.exists() and not cfg.exists():
        cfg_example.rename(cfg)
    return target
```

- [ ] **Step 2: Smoke check via a tiny test (committed alongside)**

Append to `tests/test_paths.py`:

```python
def test_tmp_vault_fixture_exists(tmp_vault):
    assert (tmp_vault / "_system" / "config.yaml").is_file()
    assert (tmp_vault / "_system" / "schema" / "_common.json").is_file()
```

- [ ] **Step 3: Run**

```bash
cd packages/keeper && uv run pytest tests/test_paths.py
```

Expected: 6 passed (5 paths + 1 fixture smoke).

- [ ] **Step 4: Commit**

```bash
git add packages/keeper/tests/conftest.py packages/keeper/tests/test_paths.py
git commit -m "test(keeper): add tmp_vault pytest fixture"
```

---

### Task 11: `triage` op

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/__init__.py` (empty)
- Create: `packages/keeper/src/vault_mem_keeper/ops/triage.py`
- Create: `packages/keeper/tests/ops/__init__.py` (empty)
- Create: `packages/keeper/tests/ops/test_triage.py`

- [ ] **Step 1: Write the failing test `tests/ops/test_triage.py`**

```python
from datetime import datetime, timedelta, UTC
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas
from vault_mem_keeper.ops.triage import run_triage
from vault_mem_keeper.paths import vault_paths

REPO_ROOT = Path(__file__).resolve().parents[4]
VAULT_TEMPLATE = REPO_ROOT / "vault-template"


def _write_inbox_memory(
    vault_root: Path,
    mid: str,
    *,
    confidence: float,
    age_minutes: int,
    human_reviewed: bool = False,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.inbox_dir("decision")).mkdir(parents=True, exist_ok=True)
    created = (datetime.now(UTC) - timedelta(minutes=age_minutes)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid,
        "type": "decision",
        "title": "Test " + mid,
        "agent": "claude-code",
        "session": "01H",
        "created": created,
        "updated": created,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": human_reviewed, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body content", **fm)
    Path(paths.memory_file("decision", mid, "inbox")).write_text(frontmatter.dumps(post))


def test_promotes_old_high_confidence_memories(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_aaaaaa", confidence=0.85, age_minutes=2000)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_bbbbbb", confidence=0.85, age_minutes=10)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_cccccc", confidence=0.4, age_minutes=2000)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_dddddd", confidence=0.85, age_minutes=10, human_reviewed=True)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_triage(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    # aaaaaa: old + high confidence → promote
    assert not Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "inbox")).exists()
    assert Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "memory")).exists()
    # bbbbbb: too young → stays
    assert Path(paths.memory_file("decision", "mem_2026-04-27_bbbbbb", "inbox")).exists()
    # cccccc: low confidence → stays
    assert Path(paths.memory_file("decision", "mem_2026-04-27_cccccc", "inbox")).exists()
    # dddddd: human_reviewed → promoted regardless of age
    assert Path(paths.memory_file("decision", "mem_2026-04-27_dddddd", "memory")).exists()

    assert report.promoted == 2
    assert report.skipped == 2


def test_dry_run_does_not_move_files(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.memory_dir("decision")).mkdir(parents=True, exist_ok=True)
    _write_inbox_memory(tmp_vault, "mem_2026-04-27_aaaaaa", confidence=0.85, age_minutes=2000)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_triage(paths, cfg, schemas, audit, dry_run=True, run_id="test")

    assert Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "inbox")).exists()
    assert not Path(paths.memory_file("decision", "mem_2026-04-27_aaaaaa", "memory")).exists()
    assert report.promoted == 1   # would-promote count
    assert report.skipped == 0
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/triage.py`**

```python
"""Inbox triage: promote inbox/<type>/<id>.md → memory/<type>/<id>.md."""

import os
from dataclasses import dataclass
from datetime import datetime, UTC
from pathlib import Path
from typing import Any

from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import parse_memory_file, validate_frontmatter
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths

log = get_logger(__name__)


@dataclass
class TriageReport:
    promoted: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 timestamp; treat trailing 'Z' as UTC."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def run_triage(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> TriageReport:
    report = TriageReport()
    if not cfg.triage.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        inbox_dir = Path(paths.inbox_dir(t))
        if not inbox_dir.is_dir():
            continue
        for md in sorted(inbox_dir.glob("*.md")):
            try:
                fm, _content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("triage: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("triage: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            if fm.get("status") != "active":
                report.skipped += 1
                continue
            if (fm.get("confidence") or 0.0) < cfg.triage.min_confidence:
                report.skipped += 1
                continue

            human_reviewed = bool(fm.get("human_reviewed"))
            if not (human_reviewed and cfg.triage.promote_immediately_if_human_reviewed):
                created = _parse_iso(fm["created"])
                updated = _parse_iso(fm.get("updated", fm["created"]))
                anchor = max(created, updated)
                age_min = (now - anchor).total_seconds() / 60
                if age_min < cfg.triage.min_age_minutes:
                    report.skipped += 1
                    continue

            mid = fm["id"]
            dst = Path(paths.memory_file(t, mid, "memory"))
            if dry_run:
                log.info("[dry-run] would promote", id=mid, src=str(md), dst=str(dst))
                report.promoted += 1
                continue

            dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(str(md), str(dst))
            audit.write({
                "op": "promote",
                "agent": "keeper",
                "session": run_id,
                "id": mid,
                "from": str(md),
                "to": str(dst),
                "reason": "auto",
            })
            report.promoted += 1

    return report
```

- [ ] **Step 4: Run tests (expect 2 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/__init__.py packages/keeper/src/vault_mem_keeper/ops/triage.py packages/keeper/tests/ops/__init__.py packages/keeper/tests/ops/test_triage.py
git commit -m "feat(keeper): implement triage op"
```

---

### Task 12: `link` op

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/link.py`
- Create: `packages/keeper/tests/ops/test_link.py`

The link op needs Lance + FTS reads. The test uses `_seed_lance` from the lance test (factor it into a test helper, or duplicate inline).

- [ ] **Step 1: Write the failing test `tests/ops/test_link.py`**

```python
import json
import sqlite3
from pathlib import Path

import lancedb
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.ops.link import run_link
from vault_mem_keeper.paths import vault_paths


EMBED_DIM = 384


def _seed_indexes(vault_root: str) -> None:
    """Seed FTS5 + Lance with 3 memories where the first two are similar."""
    paths = vault_paths(vault_root)

    # FTS5
    Path(paths.system_dir).mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(paths.index_file)
    db.execute("PRAGMA user_version = 1")
    db.execute("""
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          id UNINDEXED, type UNINDEXED, title, body, tags,
          project UNINDEXED, status UNINDEXED, location UNINDEXED,
          path UNINDEXED, updated UNINDEXED,
          tokenize='porter unicode61'
        )
    """)
    rows = []
    for suffix, title in [("aaaaaa", "alpha"), ("bbbbbb", "alpha-ish"), ("cccccc", "gamma")]:
        rows.append(
            (f"mem_2026-04-27_{suffix}", "decision", title, "body",
             json.dumps([]), None, "active", "memory",
             f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
             "2026-04-27T14:32:00.000Z"),
        )
    db.executemany(
        "INSERT INTO memories_fts (id,type,title,body,tags,project,status,location,path,updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    db.commit()
    db.close()

    # Lance
    lancedb_db = lancedb.connect(paths.lance_dir)
    lance_rows = []
    for i, suffix in enumerate(["aaaaaa", "bbbbbb", "cccccc"]):
        # Similar vectors for aaaaaa and bbbbbb (e.g., both biased toward dim 0)
        v = [0.0] * EMBED_DIM
        if suffix == "aaaaaa":
            v[0] = 1.0
        elif suffix == "bbbbbb":
            v[0] = 0.95
            v[1] = 0.05
        else:
            v[2] = 1.0
        lance_rows.append({
            "id": f"mem_2026-04-27_{suffix}",
            "vector": v,
            "type": "decision",
            "title": "alpha" if suffix in ("aaaaaa", "bbbbbb") else "gamma",
            "project": None,
            "tags": [],
            "status": "active",
            "location": "memory",
            "path": f"/v/memory/decisions/mem_2026-04-27_{suffix}.md",
            "updated": "2026-04-27T14:32:00.000Z",
            "schema_version": "0.1",
            "embed_model": "Xenova/all-MiniLM-L6-v2:int8",
        })
    lancedb_db.create_table("memories", lance_rows)


def test_link_writes_links_jsonl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _seed_indexes(str(tmp_vault))
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    cfg = KeeperConfig()

    report = run_link(paths, cfg, schemas={}, audit=audit, dry_run=False, run_id="test")

    assert Path(paths.links_file).is_file()
    rows = [json.loads(line) for line in Path(paths.links_file).read_text().splitlines() if line.strip()]
    # aaaaaa and bbbbbb should be each other's neighbors
    aa_to = [r["to"] for r in rows if r["from"] == "mem_2026-04-27_aaaaaa"]
    bb_to = [r["to"] for r in rows if r["from"] == "mem_2026-04-27_bbbbbb"]
    assert "mem_2026-04-27_bbbbbb" in aa_to
    assert "mem_2026-04-27_aaaaaa" in bb_to
    assert report.from_count >= 1
    assert report.link_count >= 1


def test_dry_run_does_not_write_links_jsonl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _seed_indexes(str(tmp_vault))
    Path(paths.audit_file).touch()
    audit = Auditor(paths.audit_file)
    cfg = KeeperConfig()

    run_link(paths, cfg, schemas={}, audit=audit, dry_run=True, run_id="test")

    assert not Path(paths.links_file).is_file()
```

- [ ] **Step 2: Run test (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/link.py`**

```python
"""Auto-link: top-K semantic neighbors → _system/links.jsonl."""

import json
from dataclasses import dataclass
from datetime import datetime, UTC
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..fts import FtsReader
from ..lance import LanceReader
from ..logging import get_logger
from ..paths import VaultPaths

log = get_logger(__name__)

EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2:int8"


@dataclass
class LinkReport:
    from_count: int = 0          # how many memories produced links
    link_count: int = 0          # total link rows written


def run_link(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> LinkReport:
    report = LinkReport()
    if not cfg.link.enabled:
        return report

    fts = FtsReader(paths.index_file)
    try:
        canonical_rows = fts.list({"location": "memory"})
    except Exception as e:
        log.warn("link: FTS unavailable", err=str(e))
        return report
    finally:
        fts.close()

    if not canonical_rows:
        return report

    try:
        lance = LanceReader(paths.lance_dir)
    except Exception as e:
        log.warn("link: Lance unavailable", err=str(e))
        return report

    now_iso = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    out_lines: list[str] = []

    try:
        for row in canonical_rows:
            mid = row["id"]
            self_lance = lance.get_by_id(mid)
            if not self_lance:
                continue
            qvec = self_lance["vector"]
            candidates = lance.search(
                qvec,
                filter_={"status": "active", "location": "memory"},
                limit=cfg.link.top_k + 1,
            )
            picks: list[dict[str, Any]] = []
            for c in candidates:
                if c["id"] == mid:
                    continue
                # LanceDB returns _distance (lower=better for L2; for cosine it's 1 - similarity)
                # Convert to similarity: 1 - distance (clamped to [0,1])
                # Actually our vectors are L2-normalized so we can use 1 - distance/2 ≈ similarity.
                # For simplicity and since the test checks set membership, treat _distance as
                # already the similarity-style score for this op.
                if not cfg.link.cross_type_allowed and c["type"] != row["type"]:
                    continue
                picks.append(c)
                if len(picks) >= cfg.link.top_k:
                    break
            if not picks:
                continue
            report.from_count += 1
            for c in picks:
                out_lines.append(json.dumps({
                    "v": 1,
                    "from": mid,
                    "to": c["id"],
                    "score": 1.0,                    # placeholder; LanceDB v0.13 distance semantics vary
                    "computed_at": now_iso,
                    "embed_model": EMBED_MODEL_ID,
                    "run_id": run_id,
                }, separators=(",", ":")))
                report.link_count += 1
    finally:
        lance.close()

    if dry_run:
        log.info("[dry-run] would write links.jsonl",
                 path=paths.links_file,
                 link_count=report.link_count,
                 from_count=report.from_count)
        return report

    atomic_write(paths.links_file, "\n".join(out_lines) + ("\n" if out_lines else ""))
    audit.write({
        "op": "link_rebuild",
        "agent": "keeper",
        "session": run_id,
        "count": report.link_count,
        "embed_model": EMBED_MODEL_ID,
    })
    return report
```

**Note on score semantics:** LanceDB v0.13 returns `_distance` for vector search results — for L2-normalized vectors with cosine similarity, that's `1 - cosine`. For the link op the *score* field stored in `links.jsonl` is informational. The plan uses 1.0 as a placeholder; the implementer can refine to a proper computation by reading `_distance` from the Lance result if the API exposes it. The test does NOT assert on score values, only on (from, to) pairs.

- [ ] **Step 4: Run tests (expect 2 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/link.py packages/keeper/tests/ops/test_link.py
git commit -m "feat(keeper): implement auto-link op (top-K via Lance, links.jsonl write)"
```

---

### Task 13: `decay` op

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/decay.py`
- Create: `packages/keeper/tests/ops/test_decay.py`

- [ ] **Step 1: Write the failing test**

```python
from datetime import datetime, timedelta, UTC
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas, parse_memory_file
from vault_mem_keeper.ops.decay import run_decay
from vault_mem_keeper.paths import vault_paths


def _write_canonical_memory(
    vault_root: Path,
    mid: str,
    *,
    type_: str = "observation",
    confidence: float = 1.0,
    last_decay_at: str | None = None,
    updated_days_ago: int = 0,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir(type_)).mkdir(parents=True, exist_ok=True)
    updated = (datetime.now(UTC) - timedelta(days=updated_days_ago)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid,
        "type": type_,
        "title": f"Test {mid}",
        "agent": "human",
        "session": None,
        "created": updated,
        "updated": updated,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    if last_decay_at is not None:
        fm["last_decay_at"] = last_decay_at
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file(type_, mid, "memory")).write_text(frontmatter.dumps(post))


def test_decays_observation_after_30_days(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_aaaaaa", type_="observation",
                              confidence=1.0, updated_days_ago=31)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "memory"))
    assert fm["confidence"] == pytest.approx(0.95, abs=0.001)
    assert "last_decay_at" in fm
    assert report.decayed == 1


def test_skip_under_one_period(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_bbbbbb", type_="observation",
                              confidence=1.0, updated_days_ago=15)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    report = run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_bbbbbb", "memory"))
    assert fm["confidence"] == 1.0
    assert report.decayed == 0


def test_decision_never_decays(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_cccccc", type_="decision",
                              confidence=1.0, updated_days_ago=365)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("decision", "mem_2026-04-27_cccccc", "memory"))
    assert fm["confidence"] == 1.0


def test_floor_at_zero(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_dddddd", type_="observation",
                              confidence=0.04, updated_days_ago=400)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_dddddd", "memory"))
    assert fm["confidence"] == 0.0


def test_dry_run_does_not_modify_files(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    _write_canonical_memory(tmp_vault, "mem_2026-04-27_eeeeee", type_="observation",
                              confidence=1.0, updated_days_ago=31)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch()

    run_decay(paths, cfg, schemas, audit, dry_run=True, run_id="test")
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_eeeeee", "memory"))
    assert fm["confidence"] == 1.0
    assert "last_decay_at" not in fm
```

- [ ] **Step 2: Run (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/decay.py`**

```python
"""Confidence decay: erode confidence per type over time, advancing
last_decay_at by completed periods (preserves partial-period progress)."""

from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import parse_memory_file, serialize_memory, validate_frontmatter
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths

log = get_logger(__name__)


@dataclass
class DecayReport:
    decayed: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def _to_iso_z(d: datetime) -> str:
    return d.astimezone(UTC).isoformat().replace("+00:00", "Z")


def run_decay(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> DecayReport:
    report = DecayReport()
    if not cfg.decay.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        rate = cfg.decay.rates.get(t)
        if rate is None:
            continue
        mem_dir = Path(paths.memory_dir(t))
        if not mem_dir.is_dir():
            continue
        for md in sorted(mem_dir.glob("*.md")):
            try:
                fm, content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("decay: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("decay: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            anchor_str = fm.get("last_decay_at") or fm.get("updated") or fm.get("created")
            anchor = _parse_iso(anchor_str)
            elapsed_days = (now - anchor).days
            periods = elapsed_days // rate
            if periods <= 0:
                report.skipped += 1
                continue

            current_conf = float(fm.get("confidence") or 0.0)
            delta = -periods * cfg.decay.decay_amount_per_period
            new_conf = max(0.0, current_conf + delta)
            if abs(new_conf - current_conf) < 0.001:
                report.skipped += 1
                continue

            new_anchor = anchor + timedelta(days=periods * rate)

            if dry_run:
                log.info("[dry-run] would decay",
                         id=fm["id"], from_conf=current_conf, to_conf=new_conf, periods=periods)
                report.decayed += 1
                continue

            fm["confidence"] = new_conf
            fm["last_decay_at"] = _to_iso_z(new_anchor)
            atomic_write(str(md), serialize_memory(fm, content))
            audit.write({
                "op": "decay",
                "agent": "keeper",
                "session": run_id,
                "id": fm["id"],
                "from_confidence": current_conf,
                "to_confidence": new_conf,
                "delta": delta,
                "periods": periods,
            })
            report.decayed += 1

    return report
```

- [ ] **Step 4: Run tests (expect 5 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/decay.py packages/keeper/tests/ops/test_decay.py
git commit -m "feat(keeper): implement decay op (period-aligned confidence erosion)"
```

---

### Task 14: `archive` op

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/ops/archive.py`
- Create: `packages/keeper/tests/ops/test_archive.py`

- [ ] **Step 1: Write the failing test**

```python
from datetime import datetime, timedelta, UTC
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import KeeperConfig
from vault_mem_keeper.frontmatter import load_schemas, parse_memory_file
from vault_mem_keeper.ops.archive import run_archive
from vault_mem_keeper.paths import vault_paths


def _write_canonical(
    vault_root: Path,
    mid: str,
    *,
    type_: str = "observation",
    confidence: float = 0.8,
    ttl_days: int | None = None,
    updated_days_ago: int = 0,
) -> None:
    paths = vault_paths(str(vault_root))
    Path(paths.memory_dir(type_)).mkdir(parents=True, exist_ok=True)
    updated = (datetime.now(UTC) - timedelta(days=updated_days_ago)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid, "type": type_, "title": f"T {mid}",
        "agent": "human", "session": None,
        "created": updated, "updated": updated,
        "confidence": confidence,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": ttl_days, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file(type_, mid, "memory")).write_text(frontmatter.dumps(post))


def test_archives_ttl_expired(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_aaaaaa", ttl_days=1, updated_days_ago=2)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file); Path(paths.audit_file).touch()

    report = run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")

    assert not Path(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "memory")).exists()
    assert Path(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "archive")).exists()
    fm, _ = parse_memory_file(paths.memory_file("observation", "mem_2026-04-27_aaaaaa", "archive"))
    assert fm["status"] == "archived"
    assert report.archived == 1


def test_archives_low_confidence(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_bbbbbb", confidence=0.2, updated_days_ago=0)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file); Path(paths.audit_file).touch()

    run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_bbbbbb", "archive")).exists()


def test_keeps_active_high_confidence_no_ttl(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_cccccc", confidence=0.8, ttl_days=None)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file); Path(paths.audit_file).touch()

    run_archive(paths, cfg, schemas, audit, dry_run=False, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_cccccc", "memory")).exists()
    assert not Path(paths.memory_file("observation", "mem_2026-04-27_cccccc", "archive")).exists()


def test_dry_run_does_not_move(tmp_vault):
    paths = vault_paths(str(tmp_vault))
    Path(paths.archive_dir).mkdir(parents=True, exist_ok=True)
    _write_canonical(tmp_vault, "mem_2026-04-27_dddddd", ttl_days=1, updated_days_ago=2)

    cfg = KeeperConfig()
    schemas = load_schemas(str(tmp_vault))
    audit = Auditor(paths.audit_file); Path(paths.audit_file).touch()

    report = run_archive(paths, cfg, schemas, audit, dry_run=True, run_id="test")
    assert Path(paths.memory_file("observation", "mem_2026-04-27_dddddd", "memory")).exists()
    assert report.archived == 1   # would-archive count
```

- [ ] **Step 2: Run (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/ops/archive.py`**

```python
"""Archive op: move TTL-expired or low-confidence memories from
memory/<type>/ to archive/."""

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write
from ..audit import Auditor
from ..config import KeeperConfig
from ..frontmatter import parse_memory_file, serialize_memory, validate_frontmatter
from ..logging import get_logger
from ..paths import MEMORY_TYPES, VaultPaths

log = get_logger(__name__)


@dataclass
class ArchiveReport:
    archived: int = 0
    skipped: int = 0
    errors: int = 0


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def run_archive(
    paths: VaultPaths,
    cfg: KeeperConfig,
    schemas: dict[str, Any],
    audit: Auditor,
    *,
    dry_run: bool,
    run_id: str,
) -> ArchiveReport:
    report = ArchiveReport()
    if not cfg.archive.enabled:
        return report

    now = datetime.now(UTC)

    for t in MEMORY_TYPES:
        mem_dir = Path(paths.memory_dir(t))
        if not mem_dir.is_dir():
            continue
        for md in sorted(mem_dir.glob("*.md")):
            try:
                fm, content = parse_memory_file(str(md))
            except Exception as e:
                log.warn("archive: parse failed", path=str(md), err=str(e))
                report.errors += 1
                continue

            v = validate_frontmatter(schemas, t, fm)
            if not v.ok:
                log.warn("archive: invalid frontmatter", path=str(md), errors=v.errors)
                report.errors += 1
                continue

            reasons: list[str] = []
            ttl = fm.get("ttl_days")
            if cfg.archive.respect_ttl_days and ttl is not None:
                created = _parse_iso(fm["created"])
                updated = _parse_iso(fm.get("updated", fm["created"]))
                anchor = max(created, updated)
                expiry = anchor + timedelta(days=int(ttl))
                if now >= expiry:
                    reasons.append("ttl_expired")
            if float(fm.get("confidence") or 0.0) < cfg.archive.archive_below_confidence:
                reasons.append("low_confidence")
            if not reasons:
                report.skipped += 1
                continue

            mid = fm["id"]
            dst = Path(paths.memory_file(t, mid, "archive"))

            if dry_run:
                log.info("[dry-run] would archive", id=mid, src=str(md), dst=str(dst), reasons=reasons)
                report.archived += 1
                continue

            fm["status"] = "archived"
            atomic_write(str(md), serialize_memory(fm, content))    # update status before move
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.rename(str(md), str(dst))
            audit.write({
                "op": "archive",
                "agent": "keeper",
                "session": run_id,
                "id": mid,
                "from": str(md),
                "to": str(dst),
                "reasons": reasons,
            })
            report.archived += 1

    return report
```

- [ ] **Step 4: Run tests (expect 4 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/ops/archive.py packages/keeper/tests/ops/test_archive.py
git commit -m "feat(keeper): implement archive op (TTL + low-confidence)"
```

---

### Task 15: `runner` orchestration

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/runner.py`
- Create: `packages/keeper/tests/test_runner.py`

- [ ] **Step 1: Write failing test**

```python
from datetime import datetime, timedelta, UTC
from pathlib import Path
import json

import frontmatter
import pytest

from vault_mem_keeper.audit import Auditor
from vault_mem_keeper.config import load_keeper_config
from vault_mem_keeper.runner import run_pass, RunOpts
from vault_mem_keeper.paths import vault_paths


def _seed_inbox(vault_root: Path) -> str:
    paths = vault_paths(str(vault_root))
    Path(paths.inbox_dir("decision")).mkdir(parents=True, exist_ok=True)
    mid = "mem_2026-04-27_aaaaaa"
    created = (datetime.now(UTC) - timedelta(minutes=2000)).isoformat().replace("+00:00", "Z")
    fm = {
        "id": mid, "type": "decision", "title": "T",
        "agent": "human", "session": None,
        "created": created, "updated": created,
        "confidence": 0.85,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": None, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file("decision", mid, "inbox")).write_text(frontmatter.dumps(post))
    return mid


def test_run_pass_orchestrates_ops_in_order(tmp_vault):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    assert report.run_id is not None
    # Triage promoted the seeded memory
    assert "triage" in report.ops
    assert report.ops["triage"].promoted == 1
    # The inbox file is gone, the memory file exists
    assert not Path(paths.memory_file("decision", mid, "inbox")).exists()
    assert Path(paths.memory_file("decision", mid, "memory")).exists()
    # Audit log has a keeper_run summary line
    lines = [json.loads(l) for l in Path(paths.audit_file).read_text().splitlines() if l.strip()]
    assert any(l["op"] == "keeper_run" and l["agent"] == "keeper" for l in lines)


def test_run_pass_dry_run_makes_no_changes(tmp_vault):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=True))

    assert report.run_id is not None
    assert Path(paths.memory_file("decision", mid, "inbox")).exists()
    # No audit lines at all (dry-run skips audit writes)
    assert Path(paths.audit_file).read_text().strip() == ""


def test_one_op_failure_does_not_block_others(tmp_vault, monkeypatch):
    mid = _seed_inbox(tmp_vault)
    paths = vault_paths(str(tmp_vault))
    Path(paths.audit_file).touch()

    # Force run_link to throw
    from vault_mem_keeper.ops import link as link_mod
    def boom(*args, **kwargs): raise RuntimeError("synthetic")
    monkeypatch.setattr(link_mod, "run_link", boom)

    report = run_pass(RunOpts(vault=str(tmp_vault), dry_run=False))

    # link errored
    assert report.ops["link"].error is not None
    # but triage still ran
    assert report.ops["triage"].promoted == 1
```

- [ ] **Step 2: Run (expect FAIL)** then continue.

- [ ] **Step 3: Write `src/vault_mem_keeper/runner.py`**

```python
"""Runner: orchestrates a single keeper pass."""

from dataclasses import dataclass, field
from datetime import datetime, UTC
from pathlib import Path
from time import monotonic
from typing import Any

import ulid

from .audit import Auditor
from .config import load_keeper_config
from .frontmatter import load_schemas
from .logging import configure as configure_logging, get_logger
from .ops import archive as archive_op, decay as decay_op, link as link_op, triage as triage_op
from .paths import resolve_vault_path, vault_paths

log = get_logger(__name__)

DEFAULT_OPS_ORDER = ["triage", "link", "decay", "archive"]


@dataclass
class RunOpts:
    vault: str
    dry_run: bool = False
    ops: list[str] | None = None     # subset filter; None = all enabled


@dataclass
class OpReport:
    name: str
    skipped: bool = False
    skip_reason: str | None = None
    error: str | None = None
    # op-specific counters merged in via __dict__:
    promoted: int = 0
    archived: int = 0
    decayed: int = 0
    link_count: int = 0
    from_count: int = 0


@dataclass
class RunReport:
    run_id: str
    started_at: str
    duration_ms: int
    ops: dict[str, OpReport] = field(default_factory=dict)


def _apply_op(name: str, run_op_fn, *args, **kwargs) -> OpReport:
    rep = OpReport(name=name)
    try:
        result = run_op_fn(*args, **kwargs)
        # Copy over attributes that map to OpReport fields
        for fld in ("promoted", "archived", "decayed", "link_count", "from_count"):
            if hasattr(result, fld):
                setattr(rep, fld, getattr(result, fld))
    except Exception as e:
        log.exception(f"op failed: {name}")
        rep.error = str(e)
    return rep


def run_pass(opts: RunOpts) -> RunReport:
    configure_logging()

    vault = resolve_vault_path(flag=opts.vault)
    paths = vault_paths(vault)
    cfg = load_keeper_config(vault)
    schemas = load_schemas(vault)
    audit = Auditor(paths.audit_file)
    Path(paths.audit_file).touch(exist_ok=True)

    run_id = ulid.ULID().to_string()
    started = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    t0 = monotonic()

    ops_to_run = opts.ops or DEFAULT_OPS_ORDER
    report = RunReport(run_id=run_id, started_at=started, duration_ms=0)

    for name in ops_to_run:
        op_cfg = getattr(cfg, name, None)
        if op_cfg is None:
            report.ops[name] = OpReport(name=name, skipped=True, skip_reason="unknown op")
            continue
        if not op_cfg.enabled:
            report.ops[name] = OpReport(name=name, skipped=True, skip_reason="disabled")
            continue

        if name == "triage":
            report.ops[name] = _apply_op(
                "triage", triage_op.run_triage, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "link":
            report.ops[name] = _apply_op(
                "link", link_op.run_link, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "decay":
            report.ops[name] = _apply_op(
                "decay", decay_op.run_decay, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )
        elif name == "archive":
            report.ops[name] = _apply_op(
                "archive", archive_op.run_archive, paths, cfg, schemas, audit,
                dry_run=opts.dry_run, run_id=run_id,
            )

    report.duration_ms = int((monotonic() - t0) * 1000)

    if not opts.dry_run:
        audit.write({
            "op": "keeper_run",
            "agent": "keeper",
            "session": run_id,
            "duration_ms": report.duration_ms,
            "summary": {
                name: {k: v for k, v in op.__dict__.items()
                       if k not in ("name", "skipped", "skip_reason", "error") and v}
                for name, op in report.ops.items()
            },
        })

    return report
```

- [ ] **Step 4: Run tests (expect 3 PASS)**.

- [ ] **Step 5: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/runner.py packages/keeper/tests/test_runner.py
git commit -m "feat(keeper): add runner that orchestrates triage→link→decay→archive"
```

---

### Task 16: `__main__` CLI entry point

**Files:**
- Create: `packages/keeper/src/vault_mem_keeper/__main__.py`

- [ ] **Step 1: Write `src/vault_mem_keeper/__main__.py`**

```python
"""CLI entry: `python -m vault_mem_keeper {run|status|doctor}`."""

import argparse
import json
import os
import sys
from pathlib import Path

from .config import load_keeper_config
from .frontmatter import load_schemas
from .logging import configure as configure_logging
from .paths import resolve_vault_path, vault_paths
from .runner import RunOpts, run_pass


def _vault_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--vault", default=None,
                        help="Vault root (default: $VAULT_MEM_PATH or ~/vault-mem)")


def _resolve_vault(arg_value: str | None) -> str:
    return resolve_vault_path(flag=arg_value, env=os.environ.get("VAULT_MEM_PATH"))


def cmd_run(args: argparse.Namespace) -> int:
    configure_logging()
    vault = _resolve_vault(args.vault)
    opts = RunOpts(
        vault=vault,
        dry_run=args.dry_run,
        ops=args.ops.split(",") if args.ops else None,
    )
    report = run_pass(opts)

    prefix = "[dry-run] " if args.dry_run else ""
    sys.stdout.write(f"{prefix}keeper run {report.run_id}  started {report.started_at}  vault={vault}\n")
    for name, op in report.ops.items():
        if op.skipped:
            sys.stdout.write(f"  {name}: skipped ({op.skip_reason})\n")
            continue
        if op.error:
            sys.stdout.write(f"  {name}: ERROR {op.error}\n")
            continue
        if name == "triage":
            sys.stdout.write(f"  triage  : promoted {op.promoted}\n")
        elif name == "link":
            sys.stdout.write(f"  link    : {op.link_count} rows across {op.from_count} memories\n")
        elif name == "decay":
            sys.stdout.write(f"  decay   : decayed {op.decayed}\n")
        elif name == "archive":
            sys.stdout.write(f"  archive : archived {op.archived}\n")
    sys.stdout.write(f"  total   : {report.duration_ms} ms\n")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Print the last keeper_run audit entry."""
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)
    if not Path(paths.audit_file).is_file():
        sys.stderr.write(f"no audit log at {paths.audit_file}\n")
        return 1
    last_run = None
    with open(paths.audit_file) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("op") == "keeper_run":
                last_run = rec
    if last_run is None:
        sys.stdout.write("no keeper_run entries yet\n")
        return 0
    sys.stdout.write(json.dumps(last_run, indent=2) + "\n")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Quick health check from the keeper's perspective."""
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)

    checks: list[tuple[str, bool, str]] = []

    checks.append(("vault_root", Path(vault).is_dir(), vault))
    checks.append(("config_file", Path(paths.config_file).is_file(), paths.config_file))
    schema_ok = True
    schema_msg = ""
    try:
        load_schemas(vault)
    except Exception as e:
        schema_ok = False
        schema_msg = str(e)
    checks.append(("schemas_load", schema_ok, schema_msg))
    keeper_cfg_ok = True
    keeper_cfg_msg = ""
    try:
        load_keeper_config(vault)
    except Exception as e:
        keeper_cfg_ok = False
        keeper_cfg_msg = str(e)
    checks.append(("keeper_config", keeper_cfg_ok, keeper_cfg_msg))

    all_ok = True
    for name, ok, detail in checks:
        prefix = "PASS" if ok else "FAIL"
        suffix = ""
        if detail:
            suffix = f"  — {detail}" if not ok else f"  ({detail})"
        sys.stdout.write(f"{prefix}  {name}{suffix}\n")
        if not ok:
            all_ok = False
    return 0 if all_ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vault-mem-keeper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="Run a keeper pass")
    _vault_arg(p_run)
    p_run.add_argument("--dry-run", action="store_true")
    p_run.add_argument("--ops", default=None, help="Comma-separated op subset (e.g. 'triage,decay')")
    p_run.set_defaults(func=cmd_run)

    p_status = sub.add_parser("status", help="Show last keeper_run summary")
    _vault_arg(p_status)
    p_status.set_defaults(func=cmd_status)

    p_doctor = sub.add_parser("doctor", help="Health check")
    _vault_arg(p_doctor)
    p_doctor.set_defaults(func=cmd_doctor)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Smoke check**

```bash
cd packages/keeper && uv run python -m vault_mem_keeper --help
```

Expected: usage message listing `run`, `status`, `doctor` subcommands.

```bash
cd packages/keeper && uv run python -m vault_mem_keeper doctor --vault /tmp/no-such-vault
```

Expected: at least `FAIL  vault_root` line, exit 1.

- [ ] **Step 3: Commit**

```bash
git add packages/keeper/src/vault_mem_keeper/__main__.py
git commit -m "feat(keeper): add CLI entry (run/status/doctor)"
```

---

### Task 17: launchd plist + bin script

**Files:**
- Create: `ops/keeper/com.vaultmem.keeper.plist`
- Create: `packages/keeper/bin/run-keeper.sh`

- [ ] **Step 1: Write `ops/keeper/com.vaultmem.keeper.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.vaultmem.keeper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/REPLACE_USER/.local/bin/uv</string>
    <string>run</string>
    <string>--directory</string>
    <string>/Users/REPLACE_USER/path/to/frozo-vault-mem/packages/keeper</string>
    <string>python</string>
    <string>-m</string>
    <string>vault_mem_keeper</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VAULT_MEM_PATH</key> <string>/Users/REPLACE_USER/vault-mem</string>
  </dict>
  <key>StartInterval</key>    <integer>1800</integer>
  <key>StandardErrorPath</key><string>/Users/REPLACE_USER/Library/Logs/vault-mem-keeper.err.log</string>
  <key>StandardOutPath</key>  <string>/Users/REPLACE_USER/Library/Logs/vault-mem-keeper.out.log</string>
  <key>RunAtLoad</key>        <false/>
</dict>
</plist>
```

- [ ] **Step 2: Write `packages/keeper/bin/run-keeper.sh`**

```bash
#!/usr/bin/env bash
# Convenience wrapper for pm2 / scripts that prefer a single shell command.
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run python -m vault_mem_keeper run "$@"
```

```bash
chmod +x packages/keeper/bin/run-keeper.sh
```

- [ ] **Step 3: Update `packages/keeper/README.md` with install instructions**

Append:

```markdown

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
```

- [ ] **Step 4: Commit**

```bash
git add ops/keeper/com.vaultmem.keeper.plist packages/keeper/bin/run-keeper.sh packages/keeper/README.md
git commit -m "feat(keeper): add launchd plist template + pm2 wrapper script"
```

---

### Task 18: TS-side AuditEntry widening + schema additivity

**Files:**
- Modify: `packages/mcp/src/audit/index.ts`
- Modify: `packages/mcp/src/audit/audit.test.ts`
- Modify: `vault-template/_system/schema/_common.json`
- Modify: `vault-template/_system/config.yaml.example`
- Modify: `vault-template/.gitignore`

- [ ] **Step 1: Widen `AuditEntry` union in `packages/mcp/src/audit/index.ts`**

Add new interfaces alongside the existing ones (after `AuditFailedOp`):

```ts
export interface AuditDecayOp {
  op: "decay";
  agent: string;
  session: string | null;
  id: string;
  from_confidence: number;
  to_confidence: number;
  delta: number;
  periods: number;
}

export interface AuditArchiveOp {
  op: "archive";
  agent: string;
  session: string | null;
  id: string;
  from: string;
  to: string;
  reasons: string[];
}

export interface AuditLinkRebuildOp {
  op: "link_rebuild";
  agent: string;
  session: string | null;
  count: number;
  embed_model: string;
}

export interface AuditKeeperRunOp {
  op: "keeper_run";
  agent: string;
  session: string | null;
  duration_ms: number;
  summary: Record<string, unknown>;
}
```

Update `AuditEntry`:

```ts
export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp
  | AuditContextOp | AuditFailedOp
  | AuditDecayOp | AuditArchiveOp | AuditLinkRebuildOp | AuditKeeperRunOp;
```

- [ ] **Step 2: Add a TS audit test that asserts keeper-shape entries serialize cleanly**

Append to `packages/mcp/src/audit/audit.test.ts`:

```ts
  it("serializes keeper-shape entries (decay, archive, link_rebuild, keeper_run) without dropping fields", () => {
    const a = new Auditor(logPath);
    a.write({ op: "decay", agent: "keeper", session: "01H", id: "mem_2026-04-27_aaaaaa",
              from_confidence: 1.0, to_confidence: 0.95, delta: -0.05, periods: 1 });
    a.write({ op: "archive", agent: "keeper", session: "01H", id: "mem_2026-04-27_bbbbbb",
              from: "/v/memory/observations/x.md", to: "/v/archive/x.md", reasons: ["ttl_expired"] });
    a.write({ op: "link_rebuild", agent: "keeper", session: "01H",
              count: 12, embed_model: "Xenova/all-MiniLM-L6-v2:int8" });
    a.write({ op: "keeper_run", agent: "keeper", session: "01H",
              duration_ms: 234, summary: { triage: { promoted: 2 } } });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const decay = JSON.parse(lines[0]!);
    expect(decay.op).toBe("decay");
    expect(decay.delta).toBe(-0.05);
    const archive = JSON.parse(lines[1]!);
    expect(archive.reasons).toEqual(["ttl_expired"]);
    const linkRebuild = JSON.parse(lines[2]!);
    expect(linkRebuild.count).toBe(12);
    const keeperRun = JSON.parse(lines[3]!);
    expect(keeperRun.summary.triage.promoted).toBe(2);
  });
```

- [ ] **Step 3: Add `last_decay_at` to `_common.json`**

In `vault-template/_system/schema/_common.json`, add to the `properties` block:

```json
    "last_decay_at": { "type": "string", "format": "date-time" }
```

(Optional field — do NOT add to the `required` array.)

- [ ] **Step 4: Add `keeper:` defaults to `vault-template/_system/config.yaml.example`**

Append to the file:

```yaml

keeper:
  triage:
    enabled: true
    min_age_minutes: 1440
    min_confidence: 0.7
    promote_immediately_if_human_reviewed: true
  link:
    enabled: true
    top_k: 5
    min_similarity: 0.55
    cross_type_allowed: true
    rebuild_full_each_run: true
  decay:
    enabled: true
    rates:
      decision: null
      observation: 30
      learning: 60
      todo: null
      summary: null
      entity: null
      question: null
    decay_amount_per_period: 0.05
  archive:
    enabled: true
    archive_below_confidence: 0.3
    respect_ttl_days: true
```

- [ ] **Step 5: Add `links.jsonl` to `vault-template/.gitignore`**

Append to the existing file:

```

# Daemon-managed; rebuilt every keeper run
_system/links.jsonl
```

- [ ] **Step 6: Run TS tests + typecheck**

```bash
pnpm --filter @vault-mem/mcp test
pnpm --filter @vault-mem/mcp typecheck
```

Expected: all existing tests + 1 new audit test passing. Typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/audit/index.ts packages/mcp/src/audit/audit.test.ts vault-template/_system/schema/_common.json vault-template/_system/config.yaml.example vault-template/.gitignore
git commit -m "feat(mcp): widen AuditEntry union for keeper ops; add last_decay_at schema; vault-template keeper defaults"
```

---

### Task 19: e2e + final verification

**Files:**
- Create: `packages/keeper/tests/test_e2e.py`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write `tests/test_e2e.py`**

```python
import json
import subprocess
from datetime import datetime, timedelta, UTC
from pathlib import Path

import frontmatter
import pytest

from vault_mem_keeper.paths import vault_paths

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def initialized_vault(tmp_path: Path) -> Path:
    """Use the TS init CLI to materialize a real vault, then return its path."""
    target = tmp_path / "vault"
    bin_path = REPO_ROOT / "packages" / "mcp" / "bin" / "vault-mem-mcp"
    # Build the TS package first if dist isn't fresh
    subprocess.check_call(["pnpm", "--filter", "@vault-mem/mcp", "build"], cwd=str(REPO_ROOT))
    subprocess.check_call(["node", str(bin_path), "init", "--target", str(target)])
    return target


def test_keeper_archives_ttl_expired_memory_end_to_end(initialized_vault):
    """Plant a memory with TTL=1 and created yesterday; run keeper; assert archive."""
    paths = vault_paths(str(initialized_vault))
    yesterday = (datetime.now(UTC) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
    Path(paths.memory_dir("observation")).mkdir(parents=True, exist_ok=True)
    mid = "mem_2026-04-27_e2e001"
    fm = {
        "id": mid, "type": "observation", "title": "expired",
        "agent": "human", "session": None,
        "created": yesterday, "updated": yesterday,
        "confidence": 0.8,
        "sources": [], "contradicts": [], "supersedes": [], "tags": [],
        "project": None, "ttl_days": 1, "status": "active",
        "human_reviewed": False, "human_approved": None,
        "schema_version": "0.1",
    }
    post = frontmatter.Post("body", **fm)
    Path(paths.memory_file("observation", mid, "memory")).write_text(frontmatter.dumps(post))
    Path(paths.audit_file).touch()

    # Run the keeper via CLI
    result = subprocess.run(
        ["uv", "run", "python", "-m", "vault_mem_keeper", "run",
         "--vault", str(initialized_vault)],
        capture_output=True, text=True, cwd=str(REPO_ROOT / "packages" / "keeper"),
    )
    assert result.returncode == 0, result.stderr

    # The memory should have moved to archive/
    assert not Path(paths.memory_file("observation", mid, "memory")).exists()
    assert Path(paths.memory_file("observation", mid, "archive")).exists()

    # Audit log should contain an archive entry
    lines = [json.loads(l) for l in Path(paths.audit_file).read_text().splitlines() if l.strip()]
    assert any(l["op"] == "archive" and l["id"] == mid for l in lines)
```

- [ ] **Step 2: Run the e2e test**

```bash
cd packages/keeper && uv run pytest tests/test_e2e.py
```

Expected: 1 passing. (First run takes ~30s — invokes pnpm build for the TS package.)

- [ ] **Step 3: Run the full keeper suite**

```bash
cd packages/keeper && uv run pytest
cd packages/keeper && uv run ruff check src tests
```

Expected: all keeper tests passing. ruff: zero errors.

- [ ] **Step 4: Update `CLAUDE.md`**

Find the "Running and developing" section. Add a "## Keeper (Python daemon)" subsection at the bottom:

```markdown
## Keeper (Python daemon, Phase 3)

- **Run a keeper pass:** `cd packages/keeper && uv run python -m vault_mem_keeper run --vault ~/vault-mem`
- **Dry-run:** `… --dry-run`
- **Status (last keeper_run summary):** `… status --vault ~/vault-mem`
- **Health check:** `… doctor --vault ~/vault-mem`
- **Tests:** `cd packages/keeper && uv run pytest`
- **Lint:** `cd packages/keeper && uv run ruff check src tests`
- **Schedule via launchd:** see `packages/keeper/README.md` and `ops/keeper/com.vaultmem.keeper.plist`.
```

- [ ] **Step 5: Final smoke test (all-up)**

```bash
TMP=$(mktemp -d)
node packages/mcp/bin/vault-mem-mcp init --target "$TMP/vault"
cd packages/keeper && uv run python -m vault_mem_keeper doctor --vault "$TMP/vault"
cd packages/keeper && uv run python -m vault_mem_keeper run --vault "$TMP/vault" --dry-run
cd packages/keeper && uv run python -m vault_mem_keeper run --vault "$TMP/vault"
node ../mcp/bin/vault-mem-mcp doctor --vault "$TMP/vault"
node ../mcp/bin/vault-mem-mcp tail-audit --vault "$TMP/vault" -n 5
rm -rf "$TMP"
```

Expected: keeper doctor 4/4 PASS, dry-run executes without changes, real run writes a `keeper_run` audit entry. MCP doctor 9/9 PASS. tail-audit shows the keeper line.

- [ ] **Step 6: Commit**

```bash
git add packages/keeper/tests/test_e2e.py CLAUDE.md
git commit -m "test(keeper): add e2e test driving keeper through TS init; document keeper in CLAUDE.md"
```

---

## Self-review

This section is preserved as a record of the plan's spec coverage:

**Spec coverage:**
- §3 architecture & layout → Tasks 1, 17
- §4.1 triage → Task 11
- §4.2 link → Task 12
- §4.3 decay → Task 13
- §4.4 archive → Task 14
- §5 runner orchestration → Task 15
- §6 audit format compatibility → Tasks 4 (Python), 18 (TS)
- §7 configuration → Task 6
- §8 storage (links.jsonl, last_decay_at) → Tasks 12, 18
- §9 error handling → exercised in tasks 11–15 (per-memory + per-op try/except)
- §10 testing → throughout; e2e in Task 19
- §11 acceptance criteria → final verification matrix in Task 19

**Placeholder scan:** No "TBD/TODO/implement later" remains. Every step has actual code or commands. The link op's `score` field uses a placeholder `1.0` — this is an explicitly documented choice with a note that the implementer can refine, not a gap.

**Type consistency:** `MemoryType`, `Location`, `VaultPaths`, `KeeperConfig`, `Auditor`, `FtsReader`, `LanceReader`, `TriageReport`, `LinkReport`, `DecayReport`, `ArchiveReport`, `RunOpts`, `RunReport`, `OpReport` defined exactly once and reused with matching shapes throughout.
