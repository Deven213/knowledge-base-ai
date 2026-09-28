import "server-only";
import type { Embedder } from "./embedder";
import type { SearchHit, VectorStore } from "./vector-store";

export interface RetrieveDeps {
  embedder: Embedder;
  vectorStore: VectorStore;
}

export interface RetrieveOptions {
  topK: number;
  minScore: number;
  documentIds?: string[];
}

/** Question → query embedding → top-k most similar chunks above the score threshold. */
export async function retrieveContext(
  deps: RetrieveDeps,
  question: string,
  options: RetrieveOptions,
): Promise<SearchHit[]> {
  const query = await deps.embedder.embedQuery(question);
  return deps.vectorStore.search(query, {
    topK: options.topK,
    minScore: options.minScore,
    embeddingModel: deps.embedder.modelId,
    documentIds: options.documentIds,
  });
}
