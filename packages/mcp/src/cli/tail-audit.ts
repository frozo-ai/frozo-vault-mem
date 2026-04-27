import { createReadStream, statSync, watchFile, unwatchFile } from "node:fs";
import { createInterface } from "node:readline";
import { vaultPaths } from "../vault/paths.js";

export interface TailAuditOpts {
  vault: string;
  n?: number;
  follow?: boolean;
  out?: NodeJS.WritableStream;
}

export async function runTailAudit(opts: TailAuditOpts): Promise<void> {
  const out = opts.out ?? process.stdout;
  const paths = vaultPaths(opts.vault);
  const { auditFile } = paths;
  const lines = await readLastN(auditFile, opts.n ?? 50);
  for (const ln of lines) out.write(formatLine(ln) + "\n");
  if (!opts.follow) return;

  let lastSize = statSync(auditFile).size;
  await new Promise<void>((resolve) => {
    watchFile(auditFile, { interval: 250 }, async (curr) => {
      if (curr.size > lastSize) {
        const chunk = await readFromOffset(auditFile, lastSize, curr.size);
        for (const ln of chunk.split("\n")) {
          if (ln.trim()) out.write(formatLine(ln) + "\n");
        }
        lastSize = curr.size;
      }
    });
    process.once("SIGINT", () => { unwatchFile(auditFile); resolve(); });
  });
}

async function readLastN(path: string, n: number): Promise<string[]> {
  const all: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path) });
    rl.on("line", (ln) => { if (ln.trim()) all.push(ln); });
    rl.on("close", () => resolve());
    rl.on("error", reject);
  });
  return all.slice(-n);
}

async function readFromOffset(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
    let buf = "";
    stream.on("data", (c) => { buf += c; });
    stream.on("end", () => resolve(buf));
    stream.on("error", reject);
  });
}

function formatLine(raw: string): string {
  try {
    const j = JSON.parse(raw);
    return `${j.ts} ${(j.op as string).padEnd(16)} ${(j.agent as string | undefined) ?? "-"}  ${(j.id as string | undefined) ?? (j.query_hash as string | undefined) ?? ""}`;
  } catch {
    return raw;
  }
}
