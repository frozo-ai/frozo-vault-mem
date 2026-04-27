import pino, { type Logger } from "pino";

const isDev = process.env.NODE_ENV !== "production";
const level =
  process.env.VAULT_MEM_LOG_LEVEL ??
  (isDev ? "info" : "info");

export function createLogger(): Logger {
  return pino(
    {
      level,
      base: { pkg: "vault-mem-mcp" },
    },
    pino.destination({ dest: 2, sync: false }), // fd 2 = stderr
  );
}
