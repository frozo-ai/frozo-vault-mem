import { homedir } from "node:os";
import { resolve, join } from "node:path";

export const MEMORY_TYPES = [
  "decision",
  "observation",
  "todo",
  "learning",
  "summary",
  "entity",
  "question",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const LOCATIONS = ["inbox", "memory", "archive"] as const;
export type Location = (typeof LOCATIONS)[number];

const PLURAL: Record<MemoryType, string> = {
  decision: "decisions",
  observation: "observations",
  todo: "todos",
  learning: "learnings",
  summary: "summaries",
  entity: "entities",
  question: "questions",
};

export const PLURAL_TO_TYPE: Record<string, MemoryType> = {
  decisions: "decision",
  observations: "observation",
  todos: "todo",
  learnings: "learning",
  summaries: "summary",
  entities: "entity",
  questions: "question",
};

export interface ResolveInput {
  flag?: string;
  env?: string;
  home?: string;
}

export function resolveVaultPath(input: ResolveInput = {}): string {
  if (input.flag) return resolve(input.flag);
  if (input.env) return resolve(input.env);
  const home = input.home ?? homedir();
  return resolve(home, "vault-mem");
}

export interface VaultPaths {
  root: string;
  systemDir: string;
  schemaDir: string;
  templatesDir: string;
  configFile: string;
  auditFile: string;
  indexFile: string;
  archiveDir: string;
  projectsDir: string;
  memoryDir: (t: MemoryType) => string;
  inboxDir: (t: MemoryType) => string;
  memoryFile: (t: MemoryType, id: string, loc: Location) => string;
}

export function vaultPaths(root: string): VaultPaths {
  const abs = resolve(root);
  const systemDir = join(abs, "_system");
  return {
    root: abs,
    systemDir,
    schemaDir: join(systemDir, "schema"),
    templatesDir: join(systemDir, "templates"),
    configFile: join(systemDir, "config.yaml"),
    auditFile: join(systemDir, "audit.log"),
    indexFile: join(systemDir, "index.sqlite"),
    archiveDir: join(abs, "archive"),
    projectsDir: join(abs, "projects"),
    memoryDir: (t) => join(abs, "memory", PLURAL[t]),
    inboxDir: (t) => join(abs, "inbox", PLURAL[t]),
    memoryFile: (t, id, loc) => {
      switch (loc) {
        case "inbox":
          return join(abs, "inbox", PLURAL[t], `${id}.md`);
        case "memory":
          return join(abs, "memory", PLURAL[t], `${id}.md`);
        case "archive":
          return join(abs, "archive", `${id}.md`);
      }
    },
  };
}
