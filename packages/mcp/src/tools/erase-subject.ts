/**
 * DPDP/GDPR per-subject erasure MCP tool (Phase 3 of the cascade spec).
 *
 * This tool does NOT execute the cascade. It writes an
 * `subject_erase_request` proposal to `_system/proposals.jsonl` and
 * returns `status: "pending_approval"`. An operator runs
 * `vault-mem-keeper review` to approve; only then does the keeper
 * fire `run_erase_subject(...)`.
 *
 * Why a queue rather than synchronous TTY confirm:
 *   - This tool is called by AGENTS (Claude Code, Cursor, …) — there
 *     is no TTY to prompt.
 *   - Erasure is unrecoverable; spec §6.2 + Q5 require an explicit
 *     human gate. The proposals queue + review CLI is that gate.
 *   - Telegram is a future delivery channel for the SAME queue
 *     (Phase 4 work in the original keeper roadmap, not yet built).
 *
 * Plaintext `subject_id` and `reason` live in `proposals.jsonl`
 * (gitignored, controller-private) while pending. The audit log
 * entry uses SHA-256 hashes only — never plaintext.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Auditor } from "../audit/index.js";
import { ToolError } from "../errors.js";
import { vaultPaths } from "../vault/paths.js";

export interface EraseSubjectToolInput {
  subject_id: string;
  reason: string;
}

export interface EraseSubjectToolOutput {
  status: "pending_approval";
  proposal_id: string;
  subject_id_hash: string;
  instructions: string;
}

export interface EraseSubjectToolDeps {
  vault: string;
  auditor: Auditor;
  agent?: string;
  session?: string | null;
}

const SUBJECT_PREFIXES = ["email", "slack", "github", "linear", "notion", "local"] as const;
const SUBJECT_RE = new RegExp(`^(?:${SUBJECT_PREFIXES.join("|")}):.+$`, "i");

const MAX_REASON_LEN = 1000;

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

function newProposalId(): string {
  // Match the Python proposals.py format: P-YYYY-MM-DD_<6 hex>
  const today = new Date().toISOString().slice(0, 10);
  const suffix = createHash("sha256")
    .update(`${Date.now()}_${Math.random()}`)
    .digest("hex")
    .slice(0, 6);
  return `P-${today}_${suffix}`;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export function createEraseSubjectTool(deps: EraseSubjectToolDeps) {
  return {
    async handle(input: EraseSubjectToolInput): Promise<EraseSubjectToolOutput> {
      const subjectId = (input.subject_id ?? "").trim();
      const reason = (input.reason ?? "").trim();

      if (!subjectId || !SUBJECT_RE.test(subjectId)) {
        throw new ToolError(
          "invalid_subject_id",
          `subject_id must match one of: ${SUBJECT_PREFIXES.map((p) => `${p}:<value>`).join(", ")}. Got: ${JSON.stringify(input.subject_id)}`,
        );
      }
      if (!reason) {
        throw new ToolError(
          "missing_reason",
          "`reason` is required (Q2 of the DPDP design — operators must document erasure requests).",
        );
      }
      if (reason.length > MAX_REASON_LEN) {
        throw new ToolError(
          "missing_reason",
          `reason exceeds ${MAX_REASON_LEN} characters.`,
        );
      }

      const paths = vaultPaths(deps.vault);
      const proposalsPath = join(paths.systemDir, "proposals.jsonl");
      mkdirSync(dirname(proposalsPath), { recursive: true });
      if (!existsSync(proposalsPath)) writeFileSync(proposalsPath, "");

      const proposalId = newProposalId();
      const subjectIdHash = sha256(subjectId);

      // Schema mirrors the Python Proposal dataclass but only fills
      // the fields meaningful for `subject_erase_request`. Contradict
      // fields (source_id/target_id/severity/…) are written as empty
      // so the Python dataclass round-trip stays compatible.
      const record = {
        kind: "subject_erase_request",
        // Plaintext while pending; proposals.jsonl is gitignored.
        subject_id: subjectId,
        reason,
        requested_by_agent: deps.agent ?? "unknown",
        // Contradict-shape fields (kept empty for forward compat with
        // the existing ProposalsHandle dataclass field names).
        source_id: "",
        target_id: "",
        severity: "high",
        reasoning: "",
        suggested_action: "run_erase_subject",
        model: "",
        cost_usd: 0,
        run_id: "",
        source_updated: "",
        target_updated: "",
        // ProposalsHandle.append-filled fields:
        v: 1,
        id: proposalId,
        status: "pending",
        created_at: nowIso(),
      };

      try {
        appendFileSync(proposalsPath, JSON.stringify(record) + "\n", { flag: "a" });
      } catch (e) {
        throw new ToolError(
          "erase_request_failed",
          `Failed to write proposal: ${(e as Error).message}`,
        );
      }

      // Audit (hashes only, no plaintext).
      deps.auditor.write({
        op: "subject_erase_requested",
        subject_id_hash: subjectIdHash,
        proposal_id: proposalId,
        agent: deps.agent ?? "unknown",
        session: deps.session ?? null,
      });

      return {
        status: "pending_approval",
        proposal_id: proposalId,
        subject_id_hash: subjectIdHash,
        instructions:
          `Erasure is unrecoverable and requires human approval. To approve, run on the vault host:\n` +
          `  vault-mem-keeper review --filter subject_erase_request --vault ${deps.vault}\n` +
          `Approving fires the cascade (full_delete + scrub per spec §4). ` +
          `Rejecting marks the proposal status=rejected and leaves the vault untouched.`,
      };
    },
  };
}
