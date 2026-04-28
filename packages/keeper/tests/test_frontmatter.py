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
