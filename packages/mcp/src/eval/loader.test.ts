import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpVault, type TmpVault } from "../../test/helpers/tmpVault.js";
import { loadEvalSet, discoverEvalSets, EvalLoadError } from "./loader.js";

const validSet = {
  schema: "vault-mem-eval-set/1",
  project: "kincare",
  name: "smoke",
  created: "2026-05-14T00:00:00Z",
  questions: [
    {
      id: "q1",
      question: "What auth provider did we choose?",
      expected_citations: ["mem_2026-04-15_a8f3c0"],
    },
    {
      id: "q2",
      question: "What's our embedding model?",
      expected_citations: ["mem_2026-04-20_bbb222"],
      top_k: 5,
    },
  ],
};

describe("loadEvalSet", () => {
  let v: TmpVault;
  beforeEach(() => { v = makeTmpVault(); });
  afterEach(() => v.cleanup());

  function write(path: string, value: unknown): string {
    const abs = join(v.root, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, JSON.stringify(value));
    return abs;
  }

  it("loads + validates a well-formed set", () => {
    const path = write("evals/kincare/smoke.json", validSet);
    const set = loadEvalSet(path);
    expect(set.project).toBe("kincare");
    expect(set.name).toBe("smoke");
    expect(set.questions).toHaveLength(2);
    expect(set.questions[1]!.top_k).toBe(5);
  });

  it("rejects unknown schema id", () => {
    const path = write("evals/kincare/bad.json", { ...validSet, schema: "wrong/1" });
    expect(() => loadEvalSet(path)).toThrow(EvalLoadError);
  });

  it("rejects empty questions array", () => {
    const path = write("evals/kincare/empty.json", { ...validSet, questions: [] });
    expect(() => loadEvalSet(path)).toThrow(/non-empty array/);
  });

  it("rejects duplicate question ids", () => {
    const path = write("evals/kincare/dup.json", {
      ...validSet,
      questions: [
        { ...validSet.questions[0], id: "x" },
        { ...validSet.questions[1], id: "x" },
      ],
    });
    expect(() => loadEvalSet(path)).toThrow(/duplicate question id: x/);
  });

  it("rejects an expected_citations value that doesn't match memory-id regex", () => {
    const path = write("evals/kincare/bad-id.json", {
      ...validSet,
      questions: [{
        id: "q1", question: "?", expected_citations: ["not-a-mem-id"],
      }],
    });
    expect(() => loadEvalSet(path)).toThrow(/memory-id regex/);
  });

  it("rejects question id that doesn't match the slug regex", () => {
    const path = write("evals/kincare/bad-qid.json", {
      ...validSet,
      questions: [{
        id: "Q One", question: "?",
        expected_citations: ["mem_2026-04-15_a8f3c0"],
      }],
    });
    expect(() => loadEvalSet(path)).toThrow(/must match/);
  });

  it("rejects non-JSON input", () => {
    const abs = join(v.root, "evals/kincare/bad.json");
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "not json");
    expect(() => loadEvalSet(abs)).toThrow(EvalLoadError);
  });
});

describe("discoverEvalSets", () => {
  let v: TmpVault;
  beforeEach(() => { v = makeTmpVault(); });
  afterEach(() => v.cleanup());

  it("returns sorted list of .json files in evals/<project>/", () => {
    const dir = join(v.root, "evals", "kincare");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "smoke.json"), "{}");
    writeFileSync(join(dir, "regression.json"), "{}");
    writeFileSync(join(dir, "README.md"), "ignore me");  // non-.json filtered out
    const paths = discoverEvalSets(v.root, "kincare");
    expect(paths.map((p) => p.split("/").pop())).toEqual([
      "regression.json", "smoke.json",
    ]);
  });

  it("returns empty array when the directory doesn't exist", () => {
    expect(discoverEvalSets(v.root, "no-such-project")).toEqual([]);
  });
});
