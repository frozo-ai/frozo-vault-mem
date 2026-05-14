export const EVAL_SET_SCHEMA_ID = "vault-mem-eval-set/1";
export const DEFAULT_TOP_K = 10;
export const DEFAULT_MAX_TOKENS = 4000;

export interface EvalQuestion {
  id: string;
  question: string;
  expected_citations: string[];
  top_k?: number;
  max_tokens?: number;
  include_inbox?: boolean;
  notes?: string;
}

export interface EvalSet {
  schema: typeof EVAL_SET_SCHEMA_ID;
  project: string;
  name: string;
  created?: string;
  description?: string;
  questions: EvalQuestion[];
}

export interface QuestionMetrics {
  precision: number;
  recall: number;
  f1: number;
  expectedCount: number;
  returnedCount: number;
  hitCount: number;
}

export interface QuestionResult {
  id: string;
  question: string;
  expected: string[];
  returned: string[];
  hits: string[];
  missing: string[];
  metrics: QuestionMetrics;
  passed: boolean;
  /** Items beyond top_k that memory.context produced but didn't count. */
  beyondTopK: string[];
}

export interface AggregateMetrics {
  precision: number;
  recall: number;
  f1: number;
  passRate: number;
  totalExpected: number;
  totalReturned: number;
  totalHits: number;
}

export interface EvalReport {
  project: string;
  set: string;
  vault: string;
  runAt: string;
  total: number;
  passed: number;
  metrics: AggregateMetrics;
  questions: QuestionResult[];
}
