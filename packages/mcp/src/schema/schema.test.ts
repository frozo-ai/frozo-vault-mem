import { describe, describe as describe2, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const VAULT_TEMPLATE = resolve(__dirname, "../../../../vault-template");

describe("_common.json schema", () => {
  it("compiles under Ajv draft-07", () => {
    const raw = readFileSync(
      resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
      "utf8",
    );
    const schema = JSON.parse(raw);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(typeof validate).toBe("function");
  });

  it("validates a well-formed common frontmatter object", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    const validate = ajv.compile(schema);
    const ok = validate({
      id: "mem_2026-04-27_a8f3c0",
      type: "decision",
      title: "Use Supabase for KinCare auth",
      agent: "claude-code",
      session: "01HXABCDEFGHJKMNPQRSTVWXYZ",
      created: "2026-04-27T14:32:00.000Z",
      updated: "2026-04-27T14:32:00.000Z",
      status: "active",
      schema_version: "0.1",
    });
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects an id with the wrong format", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    const validate = ajv.compile(schema);
    expect(
      validate({
        id: "not-a-vault-mem-id",
        type: "decision",
        title: "x",
        agent: "x",
        session: null,
        created: "2026-04-27T14:32:00.000Z",
        updated: "2026-04-27T14:32:00.000Z",
        status: "active",
        schema_version: "0.1",
      }),
    ).toBe(false);
  });
});

describe2("type-specific schemas compile together with _common.json", () => {
  const types = [
    "decision", "observation", "todo",
    "learning", "summary", "entity", "question",
  ] as const;

  it.each(types)("%s schema compiles via $ref into _common.json", (t) => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, "_system/schema/_common.json"),
        "utf8",
      ),
    );
    ajv.addSchema(common, common.$id);
    const typeSchema = JSON.parse(
      readFileSync(
        resolve(VAULT_TEMPLATE, `_system/schema/${t}.json`),
        "utf8",
      ),
    );
    const validate = ajv.compile(typeSchema);
    expect(typeof validate).toBe("function");
  });
});
