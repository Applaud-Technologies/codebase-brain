export class EmbeddingService {
  constructor(
    private ollamaUrl: string,
    private model: string
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't have native batch embedding, so we parallelize
    const results = await Promise.all(texts.map((text) => this.embed(text)));
    return results;
  }
}
