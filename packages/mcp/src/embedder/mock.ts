import { createHash } from "node:crypto";
import { type Embedder, EMBED_DIM } from "./index.js";

/**
 * Deterministic text → vector mock embedder for tests.
 *
 * Uses SHA-256 of the text to seed a 384-dim vector. The same text always
 * produces the same vector; different texts produce different vectors.
 * Vectors are L2-normalized so cosine similarity behaves predictably.
 *
 * NOTE: this is for shape/protocol tests only — semantic similarity
 * properties (e.g., "auth" close to "authentication") are NOT guaranteed
 * by this mock. For real-similarity tests, use the Transformers embedder.
 */
export function createMockEmbedder(): Embedder {
  function vectorFor(text: string): Float32Array {
    const out = new Float32Array(EMBED_DIM);
    let sumSq = 0;
    let hash = createHash("sha256").update(text).digest();
    let cursor = 0;
    for (let i = 0; i < EMBED_DIM; i++) {
      if (cursor + 4 > hash.length) {
        hash = createHash("sha256").update(hash).digest();
        cursor = 0;
      }
      // Map 4 bytes → float in [-1, 1]
      const u32 = hash.readUInt32BE(cursor);
      cursor += 4;
      const f = (u32 / 0xffffffff) * 2 - 1;
      out[i] = f;
      sumSq += f * f;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < EMBED_DIM; i++) out[i]! /= norm;
    return out;
  }

  return {
    async embed(text) { return vectorFor(text); },
    async embedBatch(texts) { return texts.map(vectorFor); },
  };
}
