import { describe, expect, it } from "vitest";
import { createTransformersEmbedder, EMBED_DIM, EMBED_MODEL_ID } from "./index.js";
import { createMockEmbedder } from "./mock.js";

describe("EMBED_MODEL_ID", () => {
  it("identifies the int8 quantized MiniLM model", () => {
    expect(EMBED_MODEL_ID).toBe("Xenova/all-MiniLM-L6-v2:int8");
    expect(EMBED_DIM).toBe(384);
  });
});

describe("createMockEmbedder", () => {
  it("produces 384-dim vectors deterministically from input", async () => {
    const e = createMockEmbedder();
    const v1 = await e.embed("hello");
    const v2 = await e.embed("hello");
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v1.length).toBe(384);
    expect(Array.from(v1)).toEqual(Array.from(v2)); // deterministic
  });

  it("produces different vectors for different inputs", async () => {
    const e = createMockEmbedder();
    const a = await e.embed("hello");
    const b = await e.embed("world");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("embedBatch matches sequential embed", async () => {
    const e = createMockEmbedder();
    const seq = await Promise.all([e.embed("a"), e.embed("b"), e.embed("c")]);
    const batch = await e.embedBatch(["a", "b", "c"]);
    expect(batch.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(Array.from(batch[i]!)).toEqual(Array.from(seq[i]!));
    }
  });

  it("returns L2-normalized vectors (norm ≈ 1)", async () => {
    const e = createMockEmbedder();
    const v = await e.embed("normalize check");
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    expect(norm).toBeCloseTo(1, 4);
  });
});

describe("createTransformersEmbedder (real model, slow first run)", () => {
  it("produces 384-dim L2-normalized Float32Array", { timeout: 30_000 }, async () => {
    const e = createTransformersEmbedder();
    const v = await e.embed("Use SQLite FTS5 for the keyword index");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 3);
  });

  it("similar texts have higher cosine similarity than dissimilar texts", { timeout: 30_000 }, async () => {
    const e = createTransformersEmbedder();
    const auth = await e.embed("Use Supabase for authentication");
    const auth2 = await e.embed("Authentication via Auth0");
    const food = await e.embed("Pasta carbonara recipe");
    const cos = (a: Float32Array, b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
      return s;
    };
    expect(cos(auth, auth2)).toBeGreaterThan(cos(auth, food));
  });
});
