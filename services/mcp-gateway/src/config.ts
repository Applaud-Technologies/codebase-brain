import { readFileSync } from "fs";
import { parse } from "yaml";

export interface RankingConfig {
  scoring: {
    weights: {
      semantic_similarity: number;
      symbol_signature_fit: number;
      lexical_match: number;
      centrality: number;
      architecture_locality: number;
    };
    thresholds: {
      semantic_minimum: number;
      combined_minimum: number;
      reuse_recommendation: number;
      extend_recommendation: number;
    };
  };
  penalties: {
    deprecated: { enabled: boolean; multiplier: number };
    test_only: { enabled: boolean; multiplier: number };
    generated_code: { enabled: boolean; multiplier: number };
    orphan_code: { enabled: boolean; multiplier: number; threshold: number };
    old_code: { enabled: boolean; multiplier: number; age_days: number };
    wrong_layer: { enabled: boolean; multiplier: number };
  };
  bonuses: {
    same_namespace: { enabled: boolean; multiplier: number };
    same_bounded_context: { enabled: boolean; multiplier: number };
    high_test_coverage: { enabled: boolean; multiplier: number };
    recent_activity: { enabled: boolean; multiplier: number; recency_days: number };
    documentation: { enabled: boolean; multiplier: number; min_docstring_length: number };
  };
  recommendations: {
    thresholds: {
      reuse: number;
      extend: number;
      wrap: number;
      new: number;
    };
  };
}

const defaultConfig: RankingConfig = {
  scoring: {
    weights: {
      semantic_similarity: 0.3,
      symbol_signature_fit: 0.25,
      lexical_match: 0.2,
      centrality: 0.15,
      architecture_locality: 0.1,
    },
    thresholds: {
      semantic_minimum: 0.5,
      combined_minimum: 0.4,
      reuse_recommendation: 0.75,
      extend_recommendation: 0.6,
    },
  },
  penalties: {
    deprecated: { enabled: true, multiplier: 0.3 },
    test_only: { enabled: true, multiplier: 0.2 },
    generated_code: { enabled: true, multiplier: 0.4 },
    orphan_code: { enabled: true, multiplier: 0.5, threshold: 1 },
    old_code: { enabled: true, multiplier: 0.7, age_days: 365 },
    wrong_layer: { enabled: true, multiplier: 0.6 },
  },
  bonuses: {
    same_namespace: { enabled: true, multiplier: 1.2 },
    same_bounded_context: { enabled: true, multiplier: 1.15 },
    high_test_coverage: { enabled: true, multiplier: 1.1 },
    recent_activity: { enabled: true, multiplier: 1.1, recency_days: 30 },
    documentation: { enabled: true, multiplier: 1.1, min_docstring_length: 50 },
  },
  recommendations: {
    thresholds: {
      reuse: 0.85,
      extend: 0.7,
      wrap: 0.55,
      new: 0,
    },
  },
};

export async function loadConfig(): Promise<RankingConfig> {
  const configPath = process.env.RANKING_CONFIG_PATH || "/app/config/ranking.yaml";

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parse(content) as Partial<RankingConfig>;
    return deepMerge(defaultConfig, parsed);
  } catch {
    console.warn(`Config file not found at ${configPath}, using defaults`);
    return defaultConfig;
  }
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        (result as Record<string, unknown>)[key] = deepMerge(
          targetValue as object,
          sourceValue as object
        );
      } else if (sourceValue !== undefined) {
        (result as Record<string, unknown>)[key] = sourceValue;
      }
    }
  }

  return result;
}
