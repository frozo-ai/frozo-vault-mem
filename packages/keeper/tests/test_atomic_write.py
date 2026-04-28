import tempfile
from pathlib import Path

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
