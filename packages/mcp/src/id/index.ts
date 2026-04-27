import { randomBytes } from "node:crypto";

export const ID_PATTERN = /^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/;

/**
 * Process-scoped set of IDs issued this session, used to guarantee
 * uniqueness within a single process run (e.g., during bulk writes).
 * Cleared on process exit; not persisted to disk.
 */
const _issued = new Set<string>();

export function generateId(date: Date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10);
  let id: string;
  do {
    const rand = randomBytes(3).toString("hex");
    id = `mem_${ymd}_${rand}`;
  } while (_issued.has(id));
  _issued.add(id);
  return id;
}
