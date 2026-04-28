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
