// Loads defense corpora from disk. Resolution order:
//   1. <vault>/evals/defense/<corpus>/...    (if running against a real vault)
//   2. <packageRoot>/vault-template/evals/defense/<corpus>/... (bundled corpus)
//
// The bundled corpus is the OSS-published source of truth. Per-vault
// overrides are supported so design partners can extend the corpus for
// their own threat models without forking.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentPoisonAttackRow,
  AgentPoisonBenignRow,
  BehavioralSimRow,
  BehavioralExpectedOutcomes,
  DefenseCorpus,
  MinjaAttackRow,
  MinjaQueryRow,
} from "./types.js";

function templateRoot(): string {
  // src/eval/defense/loader.ts → ../../../../../vault-template/evals/defense
  // dist after build is the same depth.
  const here = fileURLToPath(import.meta.url);
  // Walk upward until we find the vault-template dir we're shipped with.
  let dir = resolve(here, "..");
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "vault-template", "evals", "defense");
    if (existsSync(candidate)) return candidate;
    const next = resolve(dir, "..");
    if (next === dir) break;
    dir = next;
  }
  throw new Error(
    "loader: could not locate bundled vault-template/evals/defense — did the build drop the template?"
  );
}

function resolveCorpusDir(vault: string | undefined, corpus: DefenseCorpus): string {
  if (vault) {
    const local = join(vault, "evals", "defense", corpus);
    if (existsSync(local)) return local;
  }
  return join(templateRoot(), corpus);
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, "utf-8");
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    out.push(JSON.parse(trimmed) as T);
  }
  return out;
}

export interface AgentPoisonCorpus {
  dir: string;
  attacks: AgentPoisonAttackRow[];
  benign: AgentPoisonBenignRow[];
}

export function loadAgentPoison(vault: string | undefined): AgentPoisonCorpus {
  const dir = resolveCorpusDir(vault, "agentpoison");
  const attacks = readJsonl<AgentPoisonAttackRow>(join(dir, "attacks.jsonl"));
  const benign = readJsonl<AgentPoisonBenignRow>(join(dir, "benign.jsonl"));
  return { dir, attacks, benign };
}

export interface MinjaCorpus {
  dir: string;
  attacks: MinjaAttackRow[];
  queries: MinjaQueryRow[];
}

export function loadMinja(vault: string | undefined): MinjaCorpus {
  const dir = resolveCorpusDir(vault, "minja");
  const attacks = readJsonl<MinjaAttackRow>(join(dir, "attacks.jsonl"));
  const queries = readJsonl<MinjaQueryRow>(join(dir, "queries.jsonl"));
  return { dir, attacks, queries };
}

export interface BehavioralCorpus {
  dir: string;
  simulation: BehavioralSimRow[];
  expected: BehavioralExpectedOutcomes;
}

export function loadBehavioral(vault: string | undefined): BehavioralCorpus {
  const dir = resolveCorpusDir(vault, "behavioral");
  const simulation = readJsonl<BehavioralSimRow>(join(dir, "simulation.jsonl"));
  const expected = JSON.parse(
    readFileSync(join(dir, "expected_outcomes.json"), "utf-8")
  ) as BehavioralExpectedOutcomes;
  return { dir, simulation, expected };
}

/** List available corpus subdirectories for `--corpus` discovery. */
export function listCorpora(vault: string | undefined): string[] {
  const dir = vault ? join(vault, "evals", "defense") : templateRoot();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
