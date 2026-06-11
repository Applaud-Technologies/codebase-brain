import { z } from "zod";

// =============================================================================
// JOB STATUS
// =============================================================================

export const JobStatus = z.enum([
  "queued",
  "running",
  "finalizing",
  "completed",
  "failed",
  "timeout",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const AnalysisStage = z.enum([
  "discovery",
  "roslyn",
  "jscpd",
  "fallow",
  "report",
]);
export type AnalysisStage = z.infer<typeof AnalysisStage>;

// =============================================================================
// FINDING SCHEMA
// =============================================================================

export const Severity = z.enum(["info", "warning", "error"]);
export type Severity = z.infer<typeof Severity>;

export const FindingStatus = z.enum([
  "informational",
  "safe_to_fix",
  "needs_review",
  "blocked",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const RecommendedAction = z.enum([
  "reuse_existing",
  "extend_existing",
  "review_or_delete",
  "refactor_candidate",
  "reduce_complexity",
  "add_tests_before_change",
  "human_review_required",
  "no_action",
]);
export type RecommendedAction = z.infer<typeof RecommendedAction>;

export const FindingLocation = z.object({
  file_path: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  symbol: z.string().optional(),
});
export type FindingLocation = z.infer<typeof FindingLocation>;

export const FindingEvidence = z.object({
  reference_count: z.number().optional(),
  visibility: z.enum(["public", "internal", "protected", "private"]).optional(),
  callers: z.array(z.string()).optional(),
  public_api_boundary: z.boolean().optional(),
  analyzer_version: z.string().optional(),
  cyclomatic_complexity: z.number().optional(),
  method_length: z.number().optional(),
  nesting_depth: z.number().optional(),
  parameter_count: z.number().optional(),
  branch_count: z.number().optional(),
});
export type FindingEvidence = z.infer<typeof FindingEvidence>;

export const FindingRecommendation = z.object({
  action: RecommendedAction,
  rationale: z.string(),
  agent_instruction: z.string().optional(),
});
export type FindingRecommendation = z.infer<typeof FindingRecommendation>;

export const AnalyzerFinding = z.object({
  id: z.string(),
  tool: z.string(),
  language: z.string(),
  rule_id: z.string(),
  severity: Severity,
  confidence: z.number().min(0).max(1),
  status: FindingStatus,
  title: z.string(),
  summary: z.string(),
  location: FindingLocation,
  evidence: FindingEvidence,
  recommendation: FindingRecommendation,
});
export type AnalyzerFinding = z.infer<typeof AnalyzerFinding>;

// =============================================================================
// STAGE STATUS
// =============================================================================

export const StageStatus = z.object({
  stage: AnalysisStage,
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  error: z.string().optional(),
  finding_count: z.number().optional(),
});
export type StageStatus = z.infer<typeof StageStatus>;

// =============================================================================
// ANALYSIS JOB
// =============================================================================

export const AnalysisJob = z.object({
  job_id: z.string(),
  repository_path: z.string(),
  status: JobStatus,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().optional(),
  stages: z.array(StageStatus),
  config_hash: z.string().optional(),
  languages: z.array(z.string()).optional(),
  include_tests: z.boolean().optional(),
  findings: z.array(AnalyzerFinding).optional(),
  summary: z
    .object({
      total_findings: z.number(),
      by_severity: z.record(Severity, z.number()),
      by_status: z.record(FindingStatus, z.number()),
      by_tool: z.record(z.string(), z.number()),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        analyzer: z.string(),
        error: z.string(),
        recoverable: z.boolean(),
      })
    )
    .optional(),
  pinned: z.boolean().default(false),
});
export type AnalysisJob = z.infer<typeof AnalysisJob>;

// =============================================================================
// MCP TOOL INPUTS
// =============================================================================

export const AnalyzeRepositoryInput = z.object({
  repository_path: z.string(),
  languages: z.array(z.string()).optional(),
  include_tests: z.boolean().default(false),
  changed_files_only: z.boolean().default(false),
  severity_threshold: Severity.optional(),
  analyzers: z.array(z.string()).optional(),
  force_refresh: z.boolean().default(false),
});
export type AnalyzeRepositoryInput = z.infer<typeof AnalyzeRepositoryInput>;

export const GetAnalysisResultInput = z.object({
  job_id: z.string(),
  include_markdown: z.boolean().default(true),
  include_findings: z.boolean().default(true),
  stage_filter: AnalysisStage.optional(),
});
export type GetAnalysisResultInput = z.infer<typeof GetAnalysisResultInput>;

export const ListAnalysisRunsInput = z.object({
  repository_path: z.string(),
  status_filter: JobStatus.optional(),
  include_pinned: z.boolean().default(true),
  limit: z.number().default(25),
});
export type ListAnalysisRunsInput = z.infer<typeof ListAnalysisRunsInput>;

export const CleanupAnalysisRunsInput = z.object({
  repository_path: z.string(),
  dry_run: z.boolean().default(true),
  older_than_days: z.number().optional(),
  keep_latest: z.number().default(25),
  include_failed: z.boolean().default(true),
  delete_unpinned_only: z.boolean().default(true),
});
export type CleanupAnalysisRunsInput = z.infer<typeof CleanupAnalysisRunsInput>;

// =============================================================================
// ANALYZER CONFIG
// =============================================================================

export const AnalyzerConfig = z.object({
  version: z.number(),
  analyzers: z
    .object({
      roslyn: z.object({ enabled: z.boolean() }).optional(),
      jscpd: z.object({ enabled: z.boolean() }).optional(),
      fallow: z.object({ enabled: z.boolean() }).optional(),
    })
    .optional(),
  complexity: z
    .object({
      cyclomatic_threshold: z.number().default(10),
      method_length_threshold: z.number().default(50),
      nesting_depth_threshold: z.number().default(4),
      parameter_count_threshold: z.number().default(5),
      branch_count_threshold: z.number().default(10),
    })
    .optional(),
  exclusions: z
    .object({
      directories: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
    })
    .optional(),
  retention: z
    .object({
      keep_latest: z.number().default(25),
      max_age_days: z.number().default(30),
      failed_max_age_days: z.number().default(7),
    })
    .optional(),
});
export type AnalyzerConfig = z.infer<typeof AnalyzerConfig>;

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

export const DEFAULT_ANALYZER_CONFIG: AnalyzerConfig = {
  version: 1,
  analyzers: {
    roslyn: { enabled: true },
    jscpd: { enabled: true },
    fallow: { enabled: true },
  },
  complexity: {
    cyclomatic_threshold: 10,
    method_length_threshold: 50,
    nesting_depth_threshold: 4,
    parameter_count_threshold: 5,
    branch_count_threshold: 10,
  },
  exclusions: {
    directories: [
      "bin",
      "obj",
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".next",
      ".angular",
      ".git",
    ],
    files: [
      "*.g.cs",
      "*.generated.cs",
      "*.Designer.cs",
      "*.AssemblyInfo.cs",
    ],
  },
  retention: {
    keep_latest: 25,
    max_age_days: 30,
    failed_max_age_days: 7,
  },
};

// =============================================================================
// TIMEOUTS (ms)
// =============================================================================

export const ANALYZER_TIMEOUTS = {
  roslyn: 30_000,
  jscpd: 30_000,
  fallow: 30_000,
  total: 120_000,
};
