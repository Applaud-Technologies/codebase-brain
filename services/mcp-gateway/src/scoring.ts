import { RankingConfig } from "./config.js";

export interface ScoringInput {
  semanticSimilarity: number;
  lexicalMatch?: number;
  signatureFit?: number;
  usageCount: number;
  namespace?: string;
  targetNamespace?: string;
  isDeprecated?: boolean;
  isTest?: boolean;
  isGenerated?: boolean;
  isOrphan?: boolean;
  daysSinceModified?: number;
  hasDocstring?: boolean;
  docstringLength?: number;
}

export interface ScoringResult {
  total: number;
  components: {
    semantic: number;
    lexical: number;
    signature: number;
    centrality: number;
    locality: number;
  };
  penalties: string[];
  bonuses: string[];
  recommendation: "reuse" | "extend" | "wrap" | "new";
  reason: string;
}

export class ReuseScorer {
  constructor(private config: RankingConfig) {}

  score(input: ScoringInput): ScoringResult {
    const weights = this.config.scoring.weights;
    const penalties: string[] = [];
    const bonuses: string[] = [];

    // Base component scores (0-1 range)
    const semantic = input.semanticSimilarity;
    const lexical = input.lexicalMatch ?? 0;
    const signature = input.signatureFit ?? semantic * 0.8; // Approximate if not provided

    // Centrality from usage count (log scale, normalized)
    const centrality = Math.min(1, Math.log10(input.usageCount + 1) / 2);

    // Architecture locality
    let locality = 0;
    if (input.namespace && input.targetNamespace) {
      if (input.namespace === input.targetNamespace) {
        locality = 1;
      } else {
        // Partial match for shared prefixes
        const sourceParts = input.namespace.split(".");
        const targetParts = input.targetNamespace.split(".");
        let matchingParts = 0;
        for (let i = 0; i < Math.min(sourceParts.length, targetParts.length); i++) {
          if (sourceParts[i] === targetParts[i]) matchingParts++;
          else break;
        }
        locality = matchingParts / Math.max(sourceParts.length, targetParts.length);
      }
    }

    // Calculate weighted base score
    let baseScore =
      semantic * weights.semantic_similarity +
      signature * weights.symbol_signature_fit +
      lexical * weights.lexical_match +
      centrality * weights.centrality +
      locality * weights.architecture_locality;

    // Apply penalties
    let penaltyMultiplier = 1;

    if (input.isDeprecated && this.config.penalties.deprecated.enabled) {
      penaltyMultiplier *= this.config.penalties.deprecated.multiplier;
      penalties.push("deprecated");
    }

    if (input.isTest && this.config.penalties.test_only.enabled) {
      penaltyMultiplier *= this.config.penalties.test_only.multiplier;
      penalties.push("test-only");
    }

    if (input.isGenerated && this.config.penalties.generated_code.enabled) {
      penaltyMultiplier *= this.config.penalties.generated_code.multiplier;
      penalties.push("generated");
    }

    if (input.isOrphan && this.config.penalties.orphan_code.enabled) {
      penaltyMultiplier *= this.config.penalties.orphan_code.multiplier;
      penalties.push("orphan");
    }

    if (
      input.daysSinceModified &&
      input.daysSinceModified > this.config.penalties.old_code.age_days &&
      this.config.penalties.old_code.enabled
    ) {
      penaltyMultiplier *= this.config.penalties.old_code.multiplier;
      penalties.push("old-code");
    }

    // Apply bonuses
    let bonusMultiplier = 1;

    if (locality > 0.8 && this.config.bonuses.same_namespace.enabled) {
      bonusMultiplier *= this.config.bonuses.same_namespace.multiplier;
      bonuses.push("same-namespace");
    }

    if (
      input.daysSinceModified !== undefined &&
      input.daysSinceModified < this.config.bonuses.recent_activity.recency_days &&
      this.config.bonuses.recent_activity.enabled
    ) {
      bonusMultiplier *= this.config.bonuses.recent_activity.multiplier;
      bonuses.push("recent-activity");
    }

    if (
      input.hasDocstring &&
      (input.docstringLength ?? 0) > this.config.bonuses.documentation.min_docstring_length &&
      this.config.bonuses.documentation.enabled
    ) {
      bonusMultiplier *= this.config.bonuses.documentation.multiplier;
      bonuses.push("documented");
    }

    // Final score
    const total = Math.min(1, baseScore * penaltyMultiplier * bonusMultiplier);

    // Determine recommendation
    const thresholds = this.config.recommendations.thresholds;
    let recommendation: "reuse" | "extend" | "wrap" | "new";
    let reason: string;

    if (total >= thresholds.reuse) {
      recommendation = "reuse";
      reason = "Near-perfect match - use this directly";
    } else if (total >= thresholds.extend) {
      recommendation = "extend";
      reason = "Good match - consider extending this code";
    } else if (total >= thresholds.wrap) {
      recommendation = "wrap";
      reason = "Partial match - consider wrapping or adapting";
    } else {
      recommendation = "new";
      reason = "No strong match - new code may be warranted";
    }

    // Add penalty/bonus context to reason
    if (penalties.length > 0) {
      reason += ` (penalized: ${penalties.join(", ")})`;
    }
    if (bonuses.length > 0) {
      reason += ` (boosted: ${bonuses.join(", ")})`;
    }

    return {
      total,
      components: {
        semantic,
        lexical,
        signature,
        centrality,
        locality,
      },
      penalties,
      bonuses,
      recommendation,
      reason,
    };
  }
}
