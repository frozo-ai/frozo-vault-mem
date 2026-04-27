import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
type AddFormats = typeof import("ajv-formats")["default"];
const addFormats: AddFormats =
  (addFormatsModule as { default?: AddFormats }).default ?? (addFormatsModule as unknown as AddFormats);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TYPES, type MemoryType, vaultPaths } from "../vault/paths.js";

export interface CompiledSchemas {
  decision: ValidateFunction;
  observation: ValidateFunction;
  todo: ValidateFunction;
  learning: ValidateFunction;
  summary: ValidateFunction;
  entity: ValidateFunction;
  question: ValidateFunction;
}

export function loadSchemas(vaultRoot: string): CompiledSchemas {
  const paths = vaultPaths(vaultRoot);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const common = JSON.parse(
    readFileSync(join(paths.schemaDir, "_common.json"), "utf8"),
  );
  ajv.addSchema(common, common.$id);

  const out: Partial<CompiledSchemas> = {};
  for (const t of MEMORY_TYPES) {
    const raw = JSON.parse(
      readFileSync(join(paths.schemaDir, `${t}.json`), "utf8"),
    );
    out[t] = ajv.compile(raw);
  }
  return out as CompiledSchemas;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ErrorObject[] };

export function validateFrontmatter(
  schemas: CompiledSchemas,
  type: MemoryType,
  data: unknown,
): ValidationResult {
  const fn = schemas[type];
  const ok = fn(data);
  if (ok) return { ok: true };
  return { ok: false, errors: fn.errors ?? [] };
}
