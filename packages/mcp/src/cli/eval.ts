import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  discoverEvalSets,
  loadEvalSet,
  runEvalSet,
  renderText,
  renderJson,
  type EvalReport,
} from "../eval/index.js";

export interface RunEvalCliOpts {
  vault: string;
  project: string;
  /** Filter to one named set (matches `set.name` or basename without `.json`). Optional. */
  setName?: string;
  topK?: number;
  maxTokens?: number;
  /** Write the report JSON to this path. */
  outputPath?: string;
  /** Fail (non-zero exit) when aggregate F1 < minF1. */
  minF1?: number;
  /**
   * Fail (non-zero exit) when pass-rate (% of questions where recall=1)
   * < minPassRate. This is the more meaningful gate for `memory.context`,
   * because the bundle is supposed to be project-wide context, not a
   * focused answer — so precision is naturally low even when retrieval
   * is perfect, and aggregate F1 is misleading.
   */
  minPassRate?: number;
}

export interface RunEvalCliResult {
  reports: EvalReport[];
  /** Exit code the CLI should propagate. 0 = all sets met min-f1. */
  exitCode: number;
}

export async function runEvalCli(opts: RunEvalCliOpts): Promise<RunEvalCliResult> {
  const paths = discoverEvalSets(opts.vault, opts.project);
  if (paths.length === 0) {
    throw new Error(
      `no eval sets found at <vault>/evals/${opts.project}/*.json — author one first; see vault-template/evals/README.md`
    );
  }

  const sets = paths
    .map((p) => ({ path: p, set: loadEvalSet(p) }))
    .filter(({ path, set }) => {
      if (!opts.setName) return true;
      const baseName = basename(path).replace(/\.json$/, "");
      return set.name === opts.setName || baseName === opts.setName;
    });

  if (sets.length === 0) {
    throw new Error(`no eval set matches --set=${JSON.stringify(opts.setName ?? "")}`);
  }

  const reports: EvalReport[] = [];
  for (const { set } of sets) {
    const report = await runEvalSet({
      vault: opts.vault,
      set,
      ...(opts.topK !== undefined && { topK: opts.topK }),
      ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    });
    reports.push(report);
    process.stdout.write(renderText(report));
    process.stdout.write("\n");
  }

  if (opts.outputPath) {
    const payload = reports.length === 1
      ? renderJson(reports[0]!)
      : JSON.stringify({ reports }, null, 2) + "\n";
    writeFileSync(opts.outputPath, payload);
    process.stdout.write(`Wrote ${opts.outputPath}\n`);
  }

  const minF1 = opts.minF1 ?? 0;
  const minPassRate = opts.minPassRate ?? 0;
  let failed = 0;
  for (const r of reports) {
    if (minF1 > 0 && r.metrics.f1 < minF1) {
      failed++;
      process.stderr.write(
        `FAIL: ${r.project}/${r.set} F1=${(r.metrics.f1 * 100).toFixed(0)}% < min-f1=${(minF1 * 100).toFixed(0)}%\n`
      );
    }
    if (minPassRate > 0 && r.metrics.passRate < minPassRate) {
      failed++;
      process.stderr.write(
        `FAIL: ${r.project}/${r.set} pass-rate=${(r.metrics.passRate * 100).toFixed(0)}% < min-pass-rate=${(minPassRate * 100).toFixed(0)}%\n`
      );
    }
  }
  return { reports, exitCode: failed === 0 ? 0 : 1 };
}
