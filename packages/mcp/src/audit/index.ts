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

export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp
  | AuditContextOp | AuditFailedOp
  | AuditDecayOp | AuditArchiveOp | AuditLinkRebuildOp | AuditKeeperRunOp
  | AuditContradictScanOp | AuditSummarizeOp | AuditBudgetExceededOp
  | AuditProposalAppliedOp | AuditProposalRejectedOp
  | AuditProposalNoteOp | AuditProposalApplyFailedOp
  | AuditSupersedeOp;

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
