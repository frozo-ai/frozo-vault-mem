import { join } from "node:path";
import { Auditor } from "../audit/index.js";
import { createContextTool, type ContextToolInput } from "../tools/context.js";
import { resolveConfigPaths, loadConfig } from "../config/index.js";
import { openIndex } from "../index/sqlite.js";
import { openLance } from "../index/lance.js";
import { createTransformersEmbedder } from "../embedder/index.js";
import { vaultPaths } from "../vault/paths.js";
import { scoreQuestion, aggregate } from "./scorer.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOP_K,
  type EvalReport,
  type EvalSet,
  type QuestionResult,
} from "./types.js";

export interface RunEvalSetOpts {
  vault: string;
  set: EvalSet;
  /** Override per-question top_k. CLI flag wins over question.top_k wins over DEFAULT_TOP_K. */
  topK?: number;
  /** Override per-question max_tokens. */
  maxTokens?: number;
  /** Inject an audit log path; defaults to vault audit path. */
  auditPath?: string;
}

/**
 * Run every question in `set` against the vault's memory.context tool and
 * return a scored report. Heavy: opens FTS index + Lance + embedder once,
 * reuses them across all questions.
 */
export async function runEvalSet(opts: RunEvalSetOpts): Promise<EvalReport> {
  const paths = vaultPaths(opts.vault);
  const config = resolveConfigPaths(opts.vault, loadConfig(opts.vault));
  const auditor = new Auditor(opts.auditPath ?? config.resolvedAuditPath);

  const index = openIndex(config.resolvedIndexPath);
  const lance = await openLance(join(paths.systemDir, "embeddings.lance"));
  const embedder = createTransformersEmbedder();

  const contextTool = createContextTool({
    vault: opts.vault,
    auditor,
    index,
    lance,
    embedder,
    agent: "eval-harness",
    session: null,
  });

  const questionResults: QuestionResult[] = [];
  try {
    for (const q of opts.set.questions) {
      const topK = opts.topK ?? q.top_k ?? DEFAULT_TOP_K;
      const maxTokens = opts.maxTokens ?? q.max_tokens ?? DEFAULT_MAX_TOKENS;
      const input: ContextToolInput = {
        project: opts.set.project,
        query: q.question,
        max_tokens: maxTokens,
      };
      if (q.include_inbox !== undefined) input.include_inbox = q.include_inbox;

      const out = await contextTool.handle(input);
      const returnedIds = out.items.map((i) => i.id);

      questionResults.push(scoreQuestion({
        id: q.id,
        question: q.question,
        expected: q.expected_citations,
        returned: returnedIds,
        topK,
      }));
    }
  } finally {
    index.close();
  }

  const passed = questionResults.filter((r) => r.passed).length;
  return {
    project: opts.set.project,
    set: opts.set.name,
    vault: opts.vault,
    runAt: new Date().toISOString(),
    total: questionResults.length,
    passed,
    metrics: aggregate(questionResults),
    questions: questionResults,
  };
}
