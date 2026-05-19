import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../audit/index.js";
import { ToolError } from "../errors.js";
import { createEraseSubjectTool } from "./erase-subject.js";

describe("memory_erase_subject MCP tool", () => {
  let vault: string;
  let auditPath: string;
  let auditor: Auditor;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "erase-subject-test-"));
    auditPath = join(vault, "_system", "audit.log");
    // Ensure _system exists for the audit writer.
    require("node:fs").mkdirSync(join(vault, "_system"), { recursive: true });
    auditor = new Auditor(auditPath);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("writes a pending proposal and returns pending_approval", async () => {
    const tool = createEraseSubjectTool({
      vault, auditor, agent: "claude-code", session: "01H",
    });
    const out = await tool.handle({
      subject_id: "email:foo@example.com",
      reason: "DPDP SAR #42",
    });
    expect(out.status).toBe("pending_approval");
    expect(out.proposal_id).toMatch(/^P-\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/);
    expect(out.subject_id_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.instructions).toContain("vault-mem-keeper review");

    // Proposal file contains the record with plaintext while pending.
    const lines = readFileSync(join(vault, "_system", "proposals.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.kind).toBe("subject_erase_request");
    expect(rec.subject_id).toBe("email:foo@example.com");
    expect(rec.reason).toBe("DPDP SAR #42");
    expect(rec.status).toBe("pending");
    expect(rec.requested_by_agent).toBe("claude-code");
    expect(rec.suggested_action).toBe("run_erase_subject");
    // Contradict-shape fields exist (defaults) so Python's
    // ProposalsHandle dataclass round-trip works.
    expect(rec.source_id).toBe("");
    expect(rec.target_id).toBe("");
    expect(rec.severity).toBe("high");
  });

  it("writes a hashed-only audit entry (no plaintext subject_id or reason)", async () => {
    const tool = createEraseSubjectTool({ vault, auditor, agent: "x", session: null });
    await tool.handle({ subject_id: "github:alice", reason: "GDPR" });
    const auditLines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(auditLines).toHaveLength(1);
    const entry = JSON.parse(auditLines[0]!);
    expect(entry.op).toBe("subject_erase_requested");
    expect(entry.subject_id_hash).toMatch(/^sha256:/);
    // Plaintext MUST NOT leak into the audit log
    expect(entry.subject_id).toBeUndefined();
    expect(entry.reason).toBeUndefined();
  });

  it("rejects invalid subject_id formats", async () => {
    const tool = createEraseSubjectTool({ vault, auditor });
    for (const bad of ["", "foo@bar.com", "unknown:foo", "email:"]) {
      await expect(tool.handle({ subject_id: bad, reason: "x" })).rejects.toBeInstanceOf(ToolError);
    }
  });

  it("rejects missing reason", async () => {
    const tool = createEraseSubjectTool({ vault, auditor });
    await expect(tool.handle({ subject_id: "email:a@b.com", reason: "" })).rejects.toBeInstanceOf(ToolError);
  });

  it("accepts canonical prefixes case-insensitively", async () => {
    const tool = createEraseSubjectTool({ vault, auditor });
    const out = await tool.handle({ subject_id: "Email:Foo@X.com", reason: "r" });
    expect(out.status).toBe("pending_approval");
  });

  it("appends rather than overwriting when called twice", async () => {
    const tool = createEraseSubjectTool({ vault, auditor });
    await tool.handle({ subject_id: "email:a@b.com", reason: "r1" });
    await tool.handle({ subject_id: "email:c@d.com", reason: "r2" });
    const lines = readFileSync(join(vault, "_system", "proposals.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
