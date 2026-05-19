"""CLI entry: `python -m vault_mem_keeper {run|status|doctor}`."""

import argparse
import json
import os
import sys
from pathlib import Path

from .audit import Auditor
from .cli.review import cmd_review
from .config import load_keeper_config
from .frontmatter import load_schemas
from .logging import configure as configure_logging
from .ops.audit_subject import run_audit_subject, status_to_exit_code
from .ops.erase_subject import _record_erasure_request, run_erase_subject
from .ops.reindex_subjects import run_reindex_subjects
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


def cmd_erase_subject(args: argparse.Namespace) -> int:
    """Cascade per spec §4 — full_delete or scrub each memory that
    references the subject, prune the subject from the index, emit
    audit-log entries. Hard delete (no soft-grace), --reason required."""
    configure_logging()
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)

    if not args.dry_run:
        if not args.reason:
            sys.stderr.write("ERROR: --reason is required for non-dry-run erasures.\n")
            return 1
        # TTY confirm fallback per Q5 (no gatekeeper in OSS keeper yet).
        if not args.no_confirm:
            sys.stderr.write(
                f"\nAbout to erase subject: {args.subject_id}\n"
                f"Reason: {args.reason}\n"
                f"Vault: {vault}\n"
                "This is UNRECOVERABLE. Type the subject id to confirm: "
            )
            try:
                typed = input().strip()
            except EOFError:
                sys.stderr.write("\nAborted (no input).\n")
                return 1
            if typed != args.subject_id:
                sys.stderr.write("Subject id did not match. Aborted.\n")
                return 1

    auditor: Auditor | None = None
    if not args.dry_run:
        auditor = Auditor(paths.audit_file)
        _record_erasure_request(
            paths,
            args.subject_id,
            args.reason,
            __import__("datetime").datetime.now(__import__("datetime").UTC)
            .isoformat()
            .replace("+00:00", "Z"),
        )

    report = run_erase_subject(
        paths,
        args.subject_id,
        args.reason or "",
        dry_run=args.dry_run,
        auditor=auditor,
    )

    prefix = "[dry-run] " if args.dry_run else ""
    sys.stdout.write(
        f"{prefix}erase-subject  subject_hash={report.subject_id_hash[:23]}…  "
        f"full_delete={report.full_deletes}  scrub={report.scrubs}  "
        f"manual_review={report.manual_review_required}  "
        f"missing={report.skipped_missing_file}  "
        f"index_pruned={report.index_rows_pruned}  "
        f"fts_dropped={report.fts_rows_dropped}  "
        f"lance_dropped={report.lance_rows_dropped}  "
        f"duration={report.duration_ms}ms\n"
    )

    # Spec §6.1 exit-code map for the CLI itself.
    if report.manual_review_required > 0:
        return 2  # partial success — structured cascade complete, prose needs review
    return 0


def cmd_audit_subject(args: argparse.Namespace) -> int:
    """Verify the subject is mechanically gone (spec §5). Maps the
    result to exit codes 0/1/2/3 per spec §5."""
    configure_logging()
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)
    result = run_audit_subject(paths, args.subject_id)

    sys.stdout.write(
        f"audit-subject  status={result.status}  "
        f"scanned={result.md_files_scanned}  "
        f"structured_leaks={len(result.md_structured_leaks)}  "
        f"body_mentions={len(result.md_body_mentions)}  "
        f"subject_index={result.subject_index_rows}  "
        f"erased={len(result.erased_memory_ids)}  "
        f"fts={result.fts_status}(drift={result.fts_drift_rows})  "
        f"lance={result.lance_status}(drift={result.lance_drift_rows})\n"
    )
    if args.json:
        sys.stdout.write(
            json.dumps(
                {
                    "subject_id": result.subject_id,
                    "status": result.status,
                    "md_structured_leaks": result.md_structured_leaks,
                    "md_body_mentions": result.md_body_mentions,
                    "subject_index_rows": result.subject_index_rows,
                    "erased_memory_ids": result.erased_memory_ids,
                    "fts_status": result.fts_status,
                    "fts_drift_rows": result.fts_drift_rows,
                    "lance_status": result.lance_status,
                    "lance_drift_rows": result.lance_drift_rows,
                    "md_files_scanned": result.md_files_scanned,
                },
                indent=2,
            )
            + "\n"
        )
    return status_to_exit_code(result.status)


def cmd_reindex_subjects(args: argparse.Namespace) -> int:
    """Backfill `_system/subjects.sqlite` from current frontmatter
    (DPDP Phase 1 — see docs/superpowers/specs/2026-05-19-dpdp-erasure
    -cascade-design.md §3 + §10). Idempotent; safe to re-run."""
    configure_logging()
    vault = _resolve_vault(args.vault)
    paths = vault_paths(vault)
    report = run_reindex_subjects(paths, dry_run=args.dry_run)
    prefix = "[dry-run] " if args.dry_run else ""
    sys.stdout.write(
        f"{prefix}reindex-subjects  scanned={report.scanned}  "
        f"unreadable={report.skipped_unreadable}  "
        f"mentions={report.mentions_written}  "
        f"subjects={report.distinct_subjects}  "
        f"db={paths.subjects_db}\n"
    )
    return 0


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

    p_reindex_subj = sub.add_parser(
        "reindex-subjects",
        help="Backfill _system/subjects.sqlite from current frontmatter (DPDP Phase 1)",
    )
    _vault_arg(p_reindex_subj)
    p_reindex_subj.add_argument(
        "--dry-run",
        action="store_true",
        help="Count what would be written without touching the db file",
    )
    p_reindex_subj.set_defaults(func=cmd_reindex_subjects)

    p_erase = sub.add_parser(
        "erase-subject",
        help="DPDP/GDPR per-subject erasure cascade (spec §4). Hard delete + scrub.",
    )
    _vault_arg(p_erase)
    p_erase.add_argument("subject_id",
                         help="Canonical subject id (e.g. email:foo@bar.com)")
    p_erase.add_argument("--reason", default=None,
                         help="Free-text reason (required for non-dry-run; hashed in audit log)")
    p_erase.add_argument("--dry-run", action="store_true",
                         help="Classify + count; don't touch any files or the index")
    p_erase.add_argument("--no-confirm", action="store_true",
                         help="Skip TTY confirm prompt (scripts only — unrecoverable)")
    p_erase.set_defaults(func=cmd_erase_subject)

    p_audit_subj = sub.add_parser(
        "audit-subject",
        help="Verify a subject is mechanically erased (spec §5). Exit code maps to status.",
    )
    _vault_arg(p_audit_subj)
    p_audit_subj.add_argument("subject_id")
    p_audit_subj.add_argument("--json", action="store_true",
                              help="Print the full result as JSON to stdout")
    p_audit_subj.set_defaults(func=cmd_audit_subject)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
