"""Per-vault keeper state. Tracks last-run timestamps for incremental ops.

JSON file at _system/state.json. Defensively returns defaults when missing
or corrupt. Writes are atomic (temp+rename) via atomic_write."""

import json
from pathlib import Path
from typing import Any

from .atomic_write import atomic_write
from .logging import get_logger

log = get_logger(__name__)

_DEFAULTS: dict[str, Any] = {
    "last_contradict_at": None,
    "summaries": {},   # {project: {period: iso_ts}}
}


def read_state(path: str) -> dict[str, Any]:
    if not Path(path).is_file():
        return dict(_DEFAULTS)
    try:
        raw = Path(path).read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (json.JSONDecodeError, OSError) as e:
        log.warn("state: corrupt file, returning defaults", path=path, err=str(e))
        return dict(_DEFAULTS)
    merged = dict(_DEFAULTS)
    merged.update(parsed)
    if not isinstance(merged.get("summaries"), dict):
        merged["summaries"] = {}
    return merged


def write_state(path: str, state: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(state, indent=2, ensure_ascii=False) + "\n")
