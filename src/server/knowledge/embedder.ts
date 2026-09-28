import "server-only";
import path from "node:path";
import { getConfig } from "../config";

/** Turns text into vectors. Implementations must return L2-normalised vectors. */
export interface Embedder {
  /** Identifies the vector space; vectors from different models must never be compared. */
  readonly modelId: string;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

const BATCH_SIZE = 16;

/**
 * Runs a Hugging Face ONNX embedding model in-process. The model is downloaded
 * once into DATA_DIR/models; no API key is needed and no text leaves the machine.
 */
export class LocalEmbedder implements Embedder {
  private extractor?: Promise<FeatureExtractor>;

  constructor(
    readonly modelId: string,
    private readonly pooling: "cls" | "mean",
    private readonly queryPrefix: string,
    private readonly cacheDir: string,
  ) {}

  private load(): Promise<FeatureExtractor> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.cacheDir;
      // The `pipeline` overloads produce a union too complex for TS; we only use this call shape.
      const pipe = await (pipeline as unknown as (...args: unknown[]) => Promise<FeatureExtractor>)(
        "feature-extraction",
        this.modelId,
        { dtype: "q8" },
      );
      return pipe;
    })().catch((err) => {
      this.extractor = undefined; // allow a retry, e.g. after a network failure during download
      throw err;
    });
    return this.extractor;
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const tensor = await extractor(batch, { pooling: this.pooling, normalize: true });
      for (const row of tensor.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  }

  embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([this.queryPrefix + text]);
    return vector!;
  }
}

const globalForEmbedder = globalThis as unknown as { __kbEmbedder?: Embedder };

export function getEmbedder(): Embedder {
  if (!globalForEmbedder.__kbEmbedder) {
    const cfg = getConfig();
    globalForEmbedder.__kbEmbedder = new LocalEmbedder(
      cfg.EMBEDDING_MODEL,
      cfg.EMBEDDING_POOLING,
      cfg.EMBEDDING_QUERY_PREFIX,
      path.join(cfg.DATA_DIR, "models"),
    );
  }
  return globalForEmbedder.__kbEmbedder;
}
