"""CLI entry: `python -m vault_mem_keeper {run|status|doctor}`."""

import argparse
import json
import os
import sys
from pathlib import Path

from .cli.review import cmd_review
from .config import load_keeper_config
from .frontmatter import load_schemas
from .logging import configure as configure_logging
from .paths import resolve_vault_path, vault_paths
from .runner import RunOpts, run_pass


def _vault_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--vault", default=None,
                        help="Vault root (default: $VAULT_MEM_PATH or ~/vault-mem)")


def _resolve_vault(arg_value: str | None) -> str:
    return resolve_vault_path(flag=arg_value, env=os.environ.get("VAULT_MEM_PATH"))


def cmd_run(args: argparse.Namespace) -> int:
    configure_logging()
    vault = _resolve_vault(args.vault)
    opts = RunOpts(
        vault=vault,
        dry_run=args.dry_run,
        ops=args.ops.split(",") if args.ops else None,
    )
    report = run_pass(opts)

    prefix = "[dry-run] " if args.dry_run else ""
    sys.stdout.write(
        f"{prefix}keeper run {report.run_id}  started {report.started_at}  vault={vault}\n"
    )
    for name, op in report.ops.items():
        if op.skipped:
            sys.stdout.write(f"  {name}: skipped ({op.skip_reason})\n")
            continue
        if op.error:
            sys.stdout.write(f"  {name}: ERROR {op.error}\n")
            continue
        if name == "triage":
            sys.stdout.write(f"  triage  : promoted {op.promoted}\n")
        elif name == "link":
            sys.stdout.write(f"  link    : {op.link_count} rows across {op.from_count} memories\n")
        elif name == "decay":
            sys.stdout.write(f"  decay   : decayed {op.decayed}\n")
        elif name == "archive":
            sys.stdout.write(f"  archive : archived {op.archived}\n")
        elif name == "contradict":
            sys.stdout.write(
                f"  contradict: proposals {op.proposals_written}  "
                f"pairs judged {op.pairs_judged}  cost ${op.cost_usd:.4f}\n"
            )
        elif name == "summarize":
            sys.stdout.write(
                f"  summarize : wrote {op.summaries_written}  "
                f"cost ${op.cost_usd:.4f}\n"
            )
    sys.stdout.write(f"  total   : {report.duration_ms} ms\n")
    return 0


def cmd_review_cli(args: argparse.Namespace) -> int:
    configure_logging()
    vault = _resolve_vault(args.vault)
    return cmd_review(
        vault,
        filter_kind=args.filter,
        filter_severity=args.severity,
        filter_project=args.project,
    )


def cmd_status(args: argparse.Namespace) -> int:
    """Print the last keeper_run audit entry."""
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)
    if not Path(paths.audit_file).is_file():
        sys.stderr.write(f"no audit log at {paths.audit_file}\n")
        return 1
    last_run = None
    with open(paths.audit_file) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("op") == "keeper_run":
                last_run = rec
    if last_run is None:
        sys.stdout.write("no keeper_run entries yet\n")
        return 0
    sys.stdout.write(json.dumps(last_run, indent=2) + "\n")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Quick health check from the keeper's perspective."""
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)

    checks: list[tuple[str, bool, str]] = []

    checks.append(("vault_root", Path(vault).is_dir(), vault))
    checks.append(("config_file", Path(paths.config_file).is_file(), paths.config_file))
    schema_ok = True
    schema_msg = ""
    try:
        load_schemas(vault)
    except Exception as e:
        schema_ok = False
        schema_msg = str(e)
    checks.append(("schemas_load", schema_ok, schema_msg))
    keeper_cfg_ok = True
    keeper_cfg_msg = ""
    try:
        load_keeper_config(vault)
    except Exception as e:
        keeper_cfg_ok = False
        keeper_cfg_msg = str(e)
    checks.append(("keeper_config", keeper_cfg_ok, keeper_cfg_msg))

    all_ok = True
    for name, ok, detail in checks:
        prefix = "PASS" if ok else "FAIL"
        suffix = ""
        if detail:
            suffix = f"  — {detail}" if not ok else f"  ({detail})"
        sys.stdout.write(f"{prefix}  {name}{suffix}\n")
        if not ok:
            all_ok = False
    return 0 if all_ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vault-mem-keeper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="Run a keeper pass")
    _vault_arg(p_run)
    p_run.add_argument("--dry-run", action="store_true")
    p_run.add_argument(
        "--ops", default=None, help="Comma-separated op subset (e.g. 'triage,decay')"
    )
    p_run.set_defaults(func=cmd_run)

    p_status = sub.add_parser("status", help="Show last keeper_run summary")
    _vault_arg(p_status)
    p_status.set_defaults(func=cmd_status)

    p_doctor = sub.add_parser("doctor", help="Health check")
    _vault_arg(p_doctor)
    p_doctor.set_defaults(func=cmd_doctor)

    p_review = sub.add_parser("review", help="Walk pending contradiction proposals interactively")
    _vault_arg(p_review)
    p_review.add_argument("--filter", default=None,
                          help="Filter by proposal kind (e.g. 'contradict')")
    p_review.add_argument("--severity", default=None,
                          choices=["low", "medium", "high"],
                          help="Filter by severity")
    p_review.add_argument("--project", default=None,
                          help="Filter by source memory's project slug")
    p_review.set_defaults(func=cmd_review_cli)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
