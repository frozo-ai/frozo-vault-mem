// Public entry for the defense benchmark harness. See per-corpus
// READMEs under vault-template/evals/defense/ for the threat model
// and scoring rationale.

export * from "./types.js";
export {
  loadAgentPoison,
  loadMinja,
  loadBehavioral,
  listCorpora,
} from "./loader.js";
export { classify, dispositionFor } from "./classifier.js";
export {
  runAgentPoison,
  runMinjaPlaceholder,
  runBehavioralPlaceholder,
  ossRegexTester,
} from "./runners.js";
