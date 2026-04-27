import { pipeline } from "@xenova/transformers";

type Pipeline = Awaited<ReturnType<typeof pipeline>>;

export const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2:int8";
export const EMBED_DIM = 384;

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export function createTransformersEmbedder(): Embedder {
  let pipelinePromise: Promise<Pipeline> | null = null;

  const getPipeline = (): Promise<Pipeline> => {
    if (pipelinePromise === null) {
      const created = pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { quantized: true },
      ) as unknown as Promise<Pipeline>;
      pipelinePromise = created.catch((err) => {
        // Reset so a future call can retry the load
        pipelinePromise = null;
        throw err;
      });
    }
    return pipelinePromise;
  };

  async function embed(text: string): Promise<Float32Array> {
    const fe = await getPipeline();
    const out = await (fe as unknown as (
      input: string,
      opts: { pooling: "mean"; normalize: true },
    ) => Promise<{ data: Float32Array }>)(text, {
      pooling: "mean",
      normalize: true,
    });
    return new Float32Array(out.data);
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => embed(t)));
  }

  return { embed, embedBatch };
}
