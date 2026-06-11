// Shared shapes for the defense benchmark harness. The corpus files
// live under <vault>/evals/defense/ (or the bundled
// vault-template/evals/defense/ when running from the OSS template).
//
// Spec: docs/superpowers/specs/2026-06-11-trust-defense-gaps.md §Gap 5
// (in the vault-cloud repo).

export const DEFENSE_REPORT_VERSION = "0.1.0";

export const SMELL_CATEGORIES = [
  "imperative_to_agent",
  "credential_pattern",
  "tool_invocation_lookalike",
  "external_url_with_action",
  "role_override",
] as const;
export type SmellCategory = (typeof SMELL_CATEGORIES)[number];

export type DefenseCorpus = "agentpoison" | "minja" | "behavioral";

export interface AgentPoisonAttackRow {
  id: string;
  title: string;
  body: string;
  expected_categories: SmellCategory[];
  attack_class: "agentpoison";
}

export interface AgentPoisonBenignRow {
  id: string;
  title: string;
  body: string;
}

export interface MinjaAttackRow {
  id: string;
  memory: { title: string; body: string };
  target_query: string;
  expected_top_k_inclusion: boolean;
  attack_class: "minja";
}

export interface MinjaQueryRow {
  query_id: string;
  query: string;
  attack_id: string;
  expected_benign_citation: string;
}

export interface BehavioralWriteRow {
  title: string;
  body: string;
  expected_disposition: "active" | "review" | "quarantined";
}

export interface BehavioralSimRow {
  day: number;
  agent_id: string;
  writes: BehavioralWriteRow[];
}

export interface BehavioralExpectedOutcomes {
  version: string;
  corpus: "behavioral";
  agent_id: string;
  milestones: { day: number; max_score: number; comment?: string }[];
  thirty_day_targets: {
    quarantine_rate_min: number;
    final_score_max: number;
    detection_latency_days_max: number;
  };
  notes?: string;
}

// ───────────────────────── report shapes ─────────────────────────

export interface AgentPoisonCategoryStats {
  n: number;
  tp: number;
  recall: number;
}

export interface AgentPoisonReport {
  version: string;
  corpus: "agentpoison";
  ran_at: string;
  mode: "oss-regex" | "cloud-live";
  n_attacks: number;
  n_benign: number;
  precision: number;
  recall: number;
  false_positive_rate: number;
  false_negative_rate: number;
  by_category: Record<SmellCategory, AgentPoisonCategoryStats>;
}

export interface MinjaReport {
  version: string;
  corpus: "minja";
  ran_at: string;
  mode: "oss-placeholder" | "cloud-live";
  n_queries: number;
  n_attacks: number;
  top_5_contamination_rate: number;
  per_query: Array<{
    query_id: string;
    attack_in_top5: boolean;
    rank_of_attack: number | null;
  }>;
  notes?: string;
}

export interface BehavioralReport {
  version: string;
  corpus: "behavioral";
  ran_at: string;
  mode: "oss-placeholder" | "cloud-live";
  agent_id: string;
  score_curve: Array<{
    day: number;
    score: number;
    write_count: number;
    quarantine_count: number;
  }>;
  detected_at_day: number | null;
  final_score: number;
  thirty_day_quarantine_rate: number;
  notes?: string;
}

export type DefenseReport = AgentPoisonReport | MinjaReport | BehavioralReport;
