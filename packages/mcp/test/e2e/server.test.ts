import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTmpVault, type TmpVault } from "../helpers/tmpVault.js";
import { buildServer } from "../../src/server/index.js";
import { vaultPaths, MEMORY_TYPES } from "../../src/vault/paths.js";

describe("MCP server (in-memory transport)", () => {
  let v: TmpVault;
  beforeEach(() => {
    v = makeTmpVault();
    const paths = vaultPaths(v.root);
    for (const t of MEMORY_TYPES) {
      mkdirSync(paths.memoryDir(t), { recursive: true });
      mkdirSync(paths.inboxDir(t), { recursive: true });
    }
    return () => v.cleanup();
  });

  it("happy-path round-trip: write, read, search, promote, context", { timeout: 30_000 }, async () => {
    const built = await buildServer({ vault: v.root });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await built.server.connect(a);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(b);

    const wrote = await client.callTool({
      name: "memory.write",
      arguments: {
        type: "decision",
        fields: { title: "E2E test", project: "demo" },
        content: "we did this",
        agent: "test-client",
      },
    });
    const writeOut = JSON.parse((wrote.content as Array<{ text: string }>)[0]!.text);
    expect(writeOut.id).toMatch(/^mem_/);

    const read = await client.callTool({
      name: "memory.read",
      arguments: { id: writeOut.id },
    });
    const readOut = JSON.parse((read.content as Array<{ text: string }>)[0]!.text);
    expect(readOut.frontmatter.title).toBe("E2E test");

    const search = await client.callTool({
      name: "memory.search",
      arguments: { query: "E2E" },
    });
    const searchOut = JSON.parse((search.content as Array<{ text: string }>)[0]!.text);
    expect(searchOut.results.some((r: { id: string }) => r.id === writeOut.id)).toBe(true);

    const promote = await client.callTool({
      name: "memory.promote",
      arguments: { id: writeOut.id },
    });
    const promoteOut = JSON.parse((promote.content as Array<{ text: string }>)[0]!.text);
    expect(promoteOut.to).toContain("/memory/decisions/");

    const ctx = await client.callTool({
      name: "memory.context",
      arguments: { project: "demo", max_tokens: 4000 },
    });
    const ctxOut = JSON.parse((ctx.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(ctxOut.items)).toBe(true);
    expect(ctxOut.total_tokens).toBeGreaterThanOrEqual(0);

    await client.close();
    await built.shutdown();
  });
});
