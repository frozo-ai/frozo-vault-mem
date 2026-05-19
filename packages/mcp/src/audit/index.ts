import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AuditWriteOp {
  op: "write";
  agent: string;
  session: string | null;
  id: string;
  type: string;
  path: string;
  schema_version: string;
}

export interface AuditReadOp {
  op: "read";
  agent: string;
  session: string | null;
  id: string;
}

export interface AuditSearchOp {
  op: "search";
  agent: string;
  session: string | null;
  query: string;
  result_count: number;
  mode: "fts" | "semantic" | "hybrid";
}

export interface AuditPromoteOp {
  op: "promote";
  agent: string;
  session: string | null;
  id: string;
  from: string;
  to: string;
  reason?: string;
}

export interface AuditFailedOp {
  op: `${"write" | "read" | "search" | "promote"}:failed`;
  agent: string;
  session: string | null;
  correlation_id: string;
  message: string;
}

export interface AuditContextOp {
  op: "context";
  agent: string;
  session: string | null;
  project: string;
  max_tokens: number;
  query?: string;
  result_count: number;
  total_tokens: number;
}

export interface AuditDecayOp {
  op: "decay";
  agent: string;
  session: string | null;
  id: string;
  from_confidence: number;
  to_confidence: number;
  delta: number;
  periods: number;
}

export interface AuditArchiveOp {
  op: "archive";
  agent: string;
  session: string | null;
  id: string;
  from: string;
  to: string;
  reasons: string[];
}

export interface AuditLinkRebuildOp {
  op: "link_rebuild";
  agent: string;
  session: string | null;
  count: number;
  embed_model: string;
}

export interface AuditKeeperRunOp {
  op: "keeper_run";
  agent: string;
  session: string | null;
  duration_ms: number;
  summary: Record<string, unknown>;
  pending_proposals?: number;
  budget_mtd_usd?: number;
}

export interface AuditSupersedeOp {
  op: "supersede";
  agent: string;
  session: string | null;
  winner_id: string;
  loser_id: string;
  loser_from: string;
  loser_to: string;
  reason?: string;
}

export interface AuditContradictScanOp {
  op: "contradict_scan";
  agent: string;
  session: string | null;
  memories_scanned: number;
  pairs_judged: number;
  proposals_written: number;
  cost_usd: number;
}

export interface AuditSummarizeOp {
  op: "summarize";
  agent: string;
  session: string | null;
  project: string;
  period: "daily" | "weekly" | "monthly";
  memory_id: string;
  covers_count: number;
  cost_usd: number;
}

export interface AuditBudgetExceededOp {
  op: "budget_exceeded";
  agent: string;
  session: string | null;
  during?: string;
  monthly_total_usd?: number;
  cap_usd?: number;
}

export interface AuditProposalAppliedOp {
  op: "proposal_applied";
  agent: string;
  session: string | null;
  proposal_id: string;
  kind: string;
  source_id: string;
  target_id: string;
  action_taken: string;
}

export interface AuditProposalRejectedOp {
  op: "proposal_rejected";
  agent: string;
  session: string | null;
  proposal_id: string;
  reason?: string;
}

export interface AuditProposalNoteOp {
  op: "proposal_note";
  agent: string;
  session: string | null;
  proposal_id: string;
  note: string;
}

export interface AuditProposalApplyFailedOp {
  op: "proposal_apply_failed";
  agent: string;
  session: string | null;
  proposal_id: string;
  stage: string;
  err: string;
}

// ---- DPDP/GDPR per-subject erasure ops (see specs/2026-05-19-dpdp-erasure-cascade-design.md) ----
// All subject-related ops use hashed identifiers — `subject_id_hash` and
// `reason_hash` are sha256:... — never plaintext. Plaintext reason lives
// in the controller-private `_system/erasure_requests.jsonl` instead.

/** Index-write trail emitted on initial subject-mentions backfill. */
export interface AuditSubjectIndexBuildOp {
  op: "subject_index_build";
  subject_id_hash?: string;
  mention_count: number;
  mention_kinds?: string[];
}

/** A subject mention added at memory_write time or by the keeper link op. */
export interface AuditSubjectMentionAddedOp {
  op: "subject_mention_added";
  subject_id_hash: string;
  memory_id: string;
  kind: string; // "primary_subject" | "source_author" | "tag" | "body_match"
  field_path?: string;
}

/** A subject mention removed (cascade or manual cleanup). */
export interface AuditSubjectMentionRemovedOp {
  op: "subject_mention_removed";
  subject_id_hash: string;
  memory_id: string;
}

/** Agent-initiated erasure REQUEST (pre-approval). Records that an
 *  agent asked for erasure; the cascade hasn't run yet. */
export interface AuditSubjectEraseRequestedOp {
  op: "subject_erase_requested";
  subject_id_hash: string;
  proposal_id: string;
  agent: string;
  session: string | null;
}

/** Per-memory cascade event during an erase-subject run. */
export interface AuditSubjectErasedOp {
  op: "subject_erased";
  subject_id_hash: string;
  memory_id: string;
  action: "full_delete" | "scrub";
  reason_hash: string;
}

/** Final per-cascade summary. */
export interface AuditSubjectErasedCompleteOp {
  op: "subject_erased_complete";
  subject_id_hash: string;
  count: number;
  manual_review_required?: number;
  skipped_missing_file?: number;
  duration_ms: number;
  verify_status: string; // "ok" | "needs_manual_review" | "noop"
}

/** Cascade encountered a body-only mention; human review required (spec §3.4). */
export interface AuditManualRedactionRequiredOp {
  op: "manual_redaction_required";
  subject_id_hash: string;
  memory_id: string;
  field_path: string; // "body" | "tags_or_sources" | …
  note?: string;
}

export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp
  | AuditContextOp | AuditFailedOp
  | AuditDecayOp | AuditArchiveOp | AuditLinkRebuildOp | AuditKeeperRunOp
  | AuditContradictScanOp | AuditSummarizeOp | AuditBudgetExceededOp
  | AuditProposalAppliedOp | AuditProposalRejectedOp
  | AuditProposalNoteOp | AuditProposalApplyFailedOp
  | AuditSupersedeOp
  | AuditSubjectIndexBuildOp | AuditSubjectMentionAddedOp
  | AuditSubjectMentionRemovedOp | AuditSubjectEraseRequestedOp
  | AuditSubjectErasedOp | AuditSubjectErasedCompleteOp
  | AuditManualRedactionRequiredOp;

export class Auditor {
  constructor(private readonly logPath: string) {}

  write(entry: AuditEntry): void {
    const line = serialize(entry);
    appendFileSync(this.logPath, line + "\n", { flag: "a" });
  }
}

function serialize(entry: AuditEntry): string {
  const base = { ts: new Date().toISOString(), v: 1 };
  if (entry.op === "search") {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  if (entry.op === "context" && entry.query !== undefined) {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  return JSON.stringify({ ...base, ...entry });
}
