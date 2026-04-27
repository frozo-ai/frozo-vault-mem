import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AuditWriteOp {
  op: "write";
  agent: string;
  session: string | null;
  id: string;
  type: string;
  path: string;
  schema_version: string;
}

export interface AuditReadOp {
  op: "read";
  agent: string;
  session: string | null;
  id: string;
}

export interface AuditSearchOp {
  op: "search";
  agent: string;
  session: string | null;
  query: string;
  result_count: number;
}

export interface AuditPromoteOp {
  op: "promote";
  agent: string;
  session: string | null;
  id: string;
  from: string;
  to: string;
  reason?: string;
}

export interface AuditFailedOp {
  op: `${"write" | "read" | "search" | "promote"}:failed`;
  agent: string;
  session: string | null;
  correlation_id: string;
  message: string;
}

export type AuditEntry =
  | AuditWriteOp | AuditReadOp | AuditSearchOp | AuditPromoteOp | AuditFailedOp;

export class Auditor {
  constructor(private readonly logPath: string) {}

  write(entry: AuditEntry): void {
    const line = serialize(entry);
    appendFileSync(this.logPath, line + "\n", { flag: "a" });
  }
}

function serialize(entry: AuditEntry): string {
  const base = { ts: new Date().toISOString(), v: 1 };
  if (entry.op === "search") {
    const { query, ...rest } = entry;
    return JSON.stringify({
      ...base,
      ...rest,
      query_hash: "sha256:" + createHash("sha256").update(query).digest("hex"),
    });
  }
  return JSON.stringify({ ...base, ...entry });
}
