import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { vaultPaths } from "../vault/paths.js";
import { EVAL_SET_SCHEMA_ID, type EvalSet, type EvalQuestion } from "./types.js";

export class EvalLoadError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = "EvalLoadError";
  }
}

/**
 * Load and validate a single eval set JSON file. Throws EvalLoadError on
 * any structural issue — we'd rather refuse to run a bad set than score
 * against garbage and produce misleading numbers.
 */
export function loadEvalSet(path: string): EvalSet {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new EvalLoadError(`cannot read ${path}: ${(e as Error).message}`, path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EvalLoadError(`invalid JSON at ${path}: ${(e as Error).message}`, path);
  }
  return validateEvalSet(parsed, path);
}

/**
 * Discover all `.json` eval sets under `<vault>/evals/<project>/`. Returns
 * an empty array when the directory doesn't exist (so calling code can
 * decide whether that's an error).
 */
export function discoverEvalSets(vault: string, project: string): string[] {
  const paths = vaultPaths(vault);
  const dir = join(paths.root, "evals", project);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

function validateEvalSet(input: unknown, path: string): EvalSet {
  if (!isPlainObject(input)) {
    throw new EvalLoadError("top-level value must be a JSON object", path);
  }
  const v = input as Record<string, unknown>;

  if (v["schema"] !== EVAL_SET_SCHEMA_ID) {
    throw new EvalLoadError(
      `schema must be "${EVAL_SET_SCHEMA_ID}", got ${JSON.stringify(v["schema"])}`,
      path
    );
  }
  const project = requireString(v, "project", path);
  const name = requireString(v, "name", path);

  const rawQuestions = v["questions"];
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new EvalLoadError("`questions` must be a non-empty array", path);
  }

  const questions: EvalQuestion[] = rawQuestions.map((q, idx) => validateQuestion(q, idx, path));
  const seenIds = new Set<string>();
  for (const q of questions) {
    if (seenIds.has(q.id)) {
      throw new EvalLoadError(`duplicate question id: ${q.id}`, path);
    }
    seenIds.add(q.id);
  }

  const set: EvalSet = {
    schema: EVAL_SET_SCHEMA_ID,
    project,
    name,
    questions,
  };
  if (typeof v["created"] === "string") set.created = v["created"];
  if (typeof v["description"] === "string") set.description = v["description"];
  return set;
}

const MEMORY_ID_RE = /^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/;
const QUESTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function validateQuestion(
  raw: unknown,
  idx: number,
  path: string
): EvalQuestion {
  if (!isPlainObject(raw)) {
    throw new EvalLoadError(`questions[${idx}] must be an object`, path);
  }
  const v = raw as Record<string, unknown>;
  const id = requireString(v, "id", path, `questions[${idx}].id`);
  if (!QUESTION_ID_RE.test(id)) {
    throw new EvalLoadError(
      `questions[${idx}].id must match ${QUESTION_ID_RE} (got ${JSON.stringify(id)})`,
      path
    );
  }
  const question = requireString(v, "question", path, `questions[${idx}].question`);
  const exp = v["expected_citations"];
  if (!Array.isArray(exp) || exp.length === 0) {
    throw new EvalLoadError(
      `questions[${idx}].expected_citations must be a non-empty array`,
      path
    );
  }
  const expected: string[] = exp.map((e, j) => {
    if (typeof e !== "string" || !MEMORY_ID_RE.test(e)) {
      throw new EvalLoadError(
        `questions[${idx}].expected_citations[${j}] must match memory-id regex (got ${JSON.stringify(e)})`,
        path
      );
    }
    return e;
  });
  const q: EvalQuestion = { id, question, expected_citations: expected };
  if (typeof v["top_k"] === "number") q.top_k = v["top_k"];
  if (typeof v["max_tokens"] === "number") q.max_tokens = v["max_tokens"];
  if (typeof v["include_inbox"] === "boolean") q.include_inbox = v["include_inbox"];
  if (typeof v["notes"] === "string") q.notes = v["notes"];
  return q;
}

function requireString(
  v: Record<string, unknown>,
  key: string,
  path: string,
  contextLabel?: string
): string {
  const value = v[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new EvalLoadError(`${contextLabel ?? key} must be a non-empty string`, path);
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
