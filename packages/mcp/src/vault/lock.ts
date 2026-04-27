import lockfile from "proper-lockfile";

export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(path, {
    retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
    realpath: false,
    stale: 30_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
