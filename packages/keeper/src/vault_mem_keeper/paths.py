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
    def proposals_file(self) -> str: return str(Path(self.root, "_system/proposals.jsonl"))
    @property
    def budget_file(self) -> str: return str(Path(self.root, "_system/budget.jsonl"))
    @property
    def state_file(self) -> str: return str(Path(self.root, "_system/state.json"))
    @property
    def subjects_db(self) -> str: return str(Path(self.root, "_system/subjects.sqlite"))
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
