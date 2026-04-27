import { randomBytes } from "node:crypto";

export const ID_PATTERN = /^mem_\d{4}-\d{2}-\d{2}_[0-9a-f]{6}$/;

export function generateId(date: Date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10);
  const rand = randomBytes(3).toString("hex");
  return `mem_${ymd}_${rand}`;
}
