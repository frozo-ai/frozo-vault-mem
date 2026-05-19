export type ErrorKind =
  | "not_found"
  | "invalid_schema"
  | "schema_validation_failed"
  | "vault_error"
  | "not_in_inbox"
  | "promote_failed"
  | "inbox_write_failed"
  | "internal_error"
  // supersede tool
  | "self_supersede"
  | "winner_not_found"
  | "winner_in_inbox"
  | "winner_archived"
  | "loser_not_found"
  | "loser_in_inbox"
  | "supersede_failed"
  // erase-subject tool
  | "invalid_subject_id"
  | "missing_reason"
  | "erase_request_failed";

export class ToolError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toPayload(): { kind: ErrorKind; message: string; details?: unknown } {
    return { kind: this.kind, message: this.message, details: this.details };
  }
}
