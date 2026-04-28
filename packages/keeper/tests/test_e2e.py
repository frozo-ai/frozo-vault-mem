import json
import subprocess
from datetime import UTC, datetime, timedelta
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
    audit_lines = [
        json.loads(line)
        for line in Path(paths.audit_file).read_text().splitlines()
        if line.strip()
    ]
    assert any(entry["op"] == "archive" and entry["id"] == mid for entry in audit_lines)
