"""structlog setup. Output to stderr (stdout is reserved if we ever pipe)."""

import logging
import os
import sys

import structlog


def configure(level: str | None = None) -> None:
    lvl_name = (level or os.environ.get("VAULT_MEM_KEEPER_LOG_LEVEL", "info")).upper()
    lvl = getattr(logging, lvl_name, logging.INFO)
    is_dev = os.environ.get("ENV", "dev") != "production"

    processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
    ]
    if is_dev:
        processors.append(structlog.dev.ConsoleRenderer(colors=False))
    else:
        processors.append(structlog.processors.JSONRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(lvl),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "keeper") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
