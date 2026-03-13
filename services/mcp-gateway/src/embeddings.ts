/**
 * Multi-model embedding service with support for different vector types.
 *
 * Design allows easy swapping of models per vector type:
 * - description: Natural language model (default: all-minilm)
 * - code: Code-aware model (default: all-minilm, can swap to codellama, starcoder, etc.)
 */

export type VectorType = "description" | "code";

export interface ModelConfig {
  name: string;
  dimensions: number;
  provider: "ollama" | "openai" | "huggingface";  // Extensible for future providers
}

export interface EmbeddingConfig {
  ollamaUrl: string;
  models: Record<VectorType, ModelConfig>;
}

// Default configuration - easy to override
export const DEFAULT_MODELS: Record<VectorType, ModelConfig> = {
  description: {
    name: "all-minilm",
    dimensions: 384,
    provider: "ollama",
  },
  code: {
    name: "all-minilm",  // Can swap to "codellama" or "nomic-embed-text" for better code embeddings
    dimensions: 384,
    provider: "ollama",
  },
};

export class EmbeddingService {
  private ollamaUrl: string;
  private models: Record<VectorType, ModelConfig>;

  constructor(config: EmbeddingConfig) {
    this.ollamaUrl = config.ollamaUrl;
    this.models = config.models;
  }

  /**
   * Create with default models - backward compatible
   */
  static withDefaults(ollamaUrl: string): EmbeddingService {
    return new EmbeddingService({
      ollamaUrl,
      models: DEFAULT_MODELS,
    });
  }

  /**
   * Create with custom model for a specific vector type
   */
  static withCustomModel(
    ollamaUrl: string,
    vectorType: VectorType,
    model: ModelConfig
  ): EmbeddingService {
    return new EmbeddingService({
      ollamaUrl,
      models: { ...DEFAULT_MODELS, [vectorType]: model },
    });
  }

  /**
   * Get dimensions for a vector type
   */
  getDimensions(vectorType: VectorType): number {
    return this.models[vectorType].dimensions;
  }

  /**
   * Get all model configs (useful for collection creation)
   */
  getModelConfigs(): Record<VectorType, ModelConfig> {
    return this.models;
  }

  /**
   * Embed text using the model for the specified vector type
   */
  async embed(text: string, vectorType: VectorType = "description"): Promise<number[]> {
    const model = this.models[vectorType];

    if (model.provider === "ollama") {
      return this.embedWithOllama(text, model.name);
    }

    // Future: Add other providers here
    // if (model.provider === "openai") return this.embedWithOpenAI(text, model.name);
    // if (model.provider === "huggingface") return this.embedWithHuggingFace(text, model.name);

    throw new Error(`Unsupported embedding provider: ${model.provider}`);
  }

  /**
   * Embed both description and code in one call
   */
  async embedDual(description: string, code: string): Promise<{ description: number[]; code: number[] }> {
    const [descEmbedding, codeEmbedding] = await Promise.all([
      this.embed(description, "description"),
      this.embed(code, "code"),
    ]);

    return {
      description: descEmbedding,
      code: codeEmbedding,
    };
  }

  /**
   * Batch embed for a specific vector type
   */
  async embedBatch(texts: string[], vectorType: VectorType = "description"): Promise<number[][]> {
    const results = await Promise.all(texts.map((text) => this.embed(text, vectorType)));
    return results;
  }

  /**
   * Batch embed both description and code
   */
  async embedBatchDual(
    items: Array<{ description: string; code: string }>
  ): Promise<Array<{ description: number[]; code: number[] }>> {
    const results = await Promise.all(
      items.map((item) => this.embedDual(item.description, item.code))
    );
    return results;
  }

  private async embedWithOllama(text: string, model: string): Promise<number[]> {
    const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }
}
