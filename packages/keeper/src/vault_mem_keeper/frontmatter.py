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
    # Store both the absolute $id and the relative key since schemas use $ref: "_common.json"
    # which resolves relative to the type schema's $id base URI.
    store = {
        common_raw["$id"]: common_raw,
        "_common.json": common_raw,
    }

    validators: dict[str, Draft7Validator] = {}
    for t in MEMORY_TYPES:
        type_raw = json.loads((schema_dir / f"{t}.json").read_text())
        # Use the type schema's $id as base URI so relative $refs resolve correctly
        base_uri = type_raw.get("$id", f"vault-mem://schema/{t}.json")
        resolver = RefResolver(base_uri=base_uri, referrer=type_raw, store=store)
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
