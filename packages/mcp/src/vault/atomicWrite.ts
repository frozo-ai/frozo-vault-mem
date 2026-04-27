import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicWrite(absPath: string, contents: string): void {
  const tmp = `${absPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
  fsyncDir(dirname(absPath));
}

function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return; // Some filesystems (e.g., Windows in CI) don't allow dir fds; skip.
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
