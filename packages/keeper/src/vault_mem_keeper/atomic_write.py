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
