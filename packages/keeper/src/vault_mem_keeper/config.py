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


class _SummaryPeriodConfig(BaseModel):
    enabled: bool = True
    min_new_memories: int


class ContradictConfig(BaseModel):
    enabled: bool = True
    top_k: int = 5
    min_severity: str = "medium"
    types_to_scan: list[str] = Field(default_factory=lambda: [
        "decision", "observation", "learning", "question",
    ])
    haiku_model: str = "claude-haiku-4-5"
    sonnet_model: str = "claude-sonnet-4-7"


class SummarizeConfig(BaseModel):
    enabled: bool = True
    daily: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=5))
    weekly: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=20))
    monthly: _SummaryPeriodConfig = Field(default_factory=lambda: _SummaryPeriodConfig(min_new_memories=80))
    max_input_memories: int = 50
    max_input_tokens: int = 6000
    archive_predecessors: bool = False


class BudgetConfig(BaseModel):
    enabled: bool = True
    monthly_usd_cap: float = 5.00
    log_path: str = "_system/budget.jsonl"


class KeeperConfig(BaseModel):
    triage: TriageConfig = Field(default_factory=TriageConfig)
    link: LinkConfig = Field(default_factory=LinkConfig)
    decay: DecayConfig = Field(default_factory=DecayConfig)
    archive: ArchiveConfig = Field(default_factory=ArchiveConfig)
    contradict: ContradictConfig = Field(default_factory=ContradictConfig)
    summarize: SummarizeConfig = Field(default_factory=SummarizeConfig)
    budget: BudgetConfig = Field(default_factory=BudgetConfig)
    state_path: str = "_system/state.json"


def load_keeper_config(vault_root: str) -> KeeperConfig:
    cfg_path = Path(vault_root, "_system", "config.yaml")
    if not cfg_path.is_file():
        raise FileNotFoundError(f"missing config.yaml at {cfg_path}")
    raw: Any = yaml.safe_load(cfg_path.read_text()) or {}
    keeper_raw = raw.get("keeper") or {}
    return KeeperConfig.model_validate(keeper_raw)
