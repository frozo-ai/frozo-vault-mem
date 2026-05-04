from vault_mem_keeper.paths import (
    LOCATIONS,
    MEMORY_TYPES,
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
    assert p.proposals_file == "/vault/_system/proposals.jsonl"
    assert p.budget_file == "/vault/_system/budget.jsonl"
    assert p.state_file == "/vault/_system/state.json"
    assert p.archive_dir == "/vault/archive"
    assert p.memory_dir("decision") == "/vault/memory/decisions"
    assert p.inbox_dir("decision") == "/vault/inbox/decisions"


def test_memory_file_paths():
    p = vault_paths("/vault")
    mid = "mem_2026-04-27_a8f3c0"
    inbox_path = "/vault/inbox/decisions/mem_2026-04-27_a8f3c0.md"
    memory_path = "/vault/memory/decisions/mem_2026-04-27_a8f3c0.md"
    archive_path = "/vault/archive/mem_2026-04-27_a8f3c0.md"
    assert p.memory_file("decision", mid, "inbox") == inbox_path
    assert p.memory_file("decision", mid, "memory") == memory_path
    assert p.memory_file("decision", mid, "archive") == archive_path


def test_tmp_vault_fixture_exists(tmp_vault):
    assert (tmp_vault / "_system" / "config.yaml").is_file()
    assert (tmp_vault / "_system" / "schema" / "_common.json").is_file()
