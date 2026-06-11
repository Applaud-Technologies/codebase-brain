import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { pino } from "pino";
import {
  AnalysisJob,
  AnalysisStage,
  AnalyzeRepositoryInput,
  AnalyzerConfig,
  AnalyzerFinding,
  CleanupAnalysisRunsInput,
  DEFAULT_ANALYZER_CONFIG,
  GetAnalysisResultInput,
  ListAnalysisRunsInput,
  StageStatus,
  ANALYZER_TIMEOUTS,
} from "./analyzer-types.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const RUNS_DIR = ".codebase-brain/runs";
const CONFIG_FILE = "codebase-brain.config.json";

// =============================================================================
// CONFIG LOADING
// =============================================================================

export async function loadAnalyzerConfig(
  repoPath: string
): Promise<AnalyzerConfig> {
  const configPath = path.join(repoPath, CONFIG_FILE);
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(content);
    return { ...DEFAULT_ANALYZER_CONFIG, ...parsed };
  } catch {
    logger.info({ repoPath }, "No config file found, using defaults");
    return DEFAULT_ANALYZER_CONFIG;
  }
}

// =============================================================================
// ARTIFACT STORAGE
// =============================================================================

async function ensureRunsDir(repoPath: string): Promise<string> {
  const runsPath = path.join(repoPath, RUNS_DIR);
  await fs.mkdir(runsPath, { recursive: true });
  return runsPath;
}

async function saveJob(repoPath: string, job: AnalysisJob): Promise<void> {
  const runsPath = await ensureRunsDir(repoPath);
  const jobDir = path.join(runsPath, job.job_id);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(
    path.join(jobDir, "result.json"),
    JSON.stringify(job, null, 2)
  );
}

const JOB_ID_RE = /^job_[0-9]+_[a-f0-9]{8}$/;

async function loadJob(
  repoPath: string,
  jobId: string
): Promise<AnalysisJob | null> {
  if (!JOB_ID_RE.test(jobId)) return null;
  try {
    const runsDir = await fs.realpath(path.join(repoPath, RUNS_DIR)).catch(() => null);
    if (!runsDir) return null;
    const jobPath = path.resolve(runsDir, jobId, "result.json");
    if (!jobPath.startsWith(runsDir + path.sep)) return null;
    const content = await fs.readFile(jobPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// =============================================================================
// ROSLYN ADAPTER
// =============================================================================

interface RoslynSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  modifiers: string[];
  namespace?: string;
}

interface RoslynAnalyzeResponse {
  totalSymbols: number;
  symbols: RoslynSymbol[];
}

async function callRoslyn(
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const roslynUrl = process.env.ROSLYN_URL || "http://localhost:5000";
  const response = await fetch(`${roslynUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ANALYZER_TIMEOUTS.roslyn),
  });
  if (!response.ok) {
    throw new Error(`Roslyn error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function findUnusedPrivateMembers(
  solutionPath: string
): Promise<AnalyzerFinding[]> {
  const findings: AnalyzerFinding[] = [];

  try {
    const analysis = (await callRoslyn("/analyze", {
      SolutionPath: solutionPath,
    })) as RoslynAnalyzeResponse;

    const memberKinds = ["Method", "Property", "Field"];
    const privateMembers = analysis.symbols.filter(
      (s) => memberKinds.includes(s.kind) && s.modifiers?.includes("private")
    );

    logger.info(
      { total: analysis.symbols.length, private: privateMembers.length },
      "Roslyn symbols analyzed"
    );

    for (const symbol of privateMembers) {
      const refs = (await callRoslyn("/find-references", {
        SolutionPath: solutionPath,
        FilePath: symbol.filePath,
        Line: symbol.lineStart,
        Column: 1,
      })) as { references?: unknown[] };

      if (!refs.references || refs.references.length === 0) {
        findings.push({
          id: `finding_${randomUUID().slice(0, 8)}`,
          tool: "roslyn-worker",
          language: "csharp",
          rule_id: `csharp.unused_private_${symbol.kind.toLowerCase()}`,
          severity: "warning",
          confidence: 1.0,
          status: "safe_to_fix",
          title: `Unused private ${symbol.kind.toLowerCase()}: ${symbol.name}`,
          summary: `Private ${symbol.kind.toLowerCase()} '${symbol.name}' has no references in the solution.`,
          location: {
            file_path: symbol.filePath,
            start_line: symbol.lineStart,
            end_line: symbol.lineEnd,
            symbol: symbol.qualifiedName,
          },
          evidence: {
            reference_count: 0,
            visibility: "private",
            callers: [],
            public_api_boundary: false,
            analyzer_version: "roslyn-worker",
          },
          recommendation: {
            action: "review_or_delete",
            rationale: "Private member has no references in the solution.",
            agent_instruction:
              "Consider removing this unused member or document why it's needed.",
          },
        });
      }
    }
  } catch (error) {
    logger.error({ error, solutionPath }, "Roslyn analysis failed");
    throw error;
  }

  return findings;
}

// =============================================================================
// JSCPD ADAPTER
// =============================================================================

interface JscpdDuplicate {
  firstFile: {
    name: string;
    start: number;
    end: number;
    startLoc: { line: number; column: number };
    endLoc: { line: number; column: number };
  };
  secondFile: {
    name: string;
    start: number;
    end: number;
    startLoc: { line: number; column: number };
    endLoc: { line: number; column: number };
  };
  format: string;
  fragment: string;
  lines: number;
  tokens: number;
}

interface JscpdReport {
  duplicates: JscpdDuplicate[];
  statistics: {
    total: {
      clones: number;
      duplicatedLines: number;
      percentage: number;
    };
  };
}

async function runJscpd(repoPath: string): Promise<AnalyzerFinding[]> {
  const findings: AnalyzerFinding[] = [];
  const outputDir = path.join(repoPath, ".codebase-brain", "jscpd-temp");

  try {
    await fs.mkdir(outputDir, { recursive: true });

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("npx", [
      "jscpd",
      "--min-tokens", "20",
      "--reporters", "json",
      "--output", outputDir,
      "--ignore", "**/node_modules/**,**/bin/**,**/obj/**,**/.git/**,**/.codebase-brain/**",
      repoPath,
    ], {
      timeout: ANALYZER_TIMEOUTS.jscpd,
      cwd: repoPath,
    });

    const reportPath = path.join(outputDir, "jscpd-report.json");
    const reportContent = await fs.readFile(reportPath, "utf-8");
    const report: JscpdReport = JSON.parse(reportContent);

    logger.info(
      { duplicates: report.duplicates.length, percentage: report.statistics.total.percentage },
      "jscpd scan complete"
    );

    for (const dup of report.duplicates) {
      const isSameFile = dup.firstFile.name === dup.secondFile.name;
      const ruleId = isSameFile ? "duplicate.same_file_block" : "duplicate.cross_file_block";

      const firstFilePath = dup.firstFile.name.startsWith("/")
        ? dup.firstFile.name
        : path.join(repoPath, dup.firstFile.name);
      const secondFilePath = dup.secondFile.name.startsWith("/")
        ? dup.secondFile.name
        : path.join(repoPath, dup.secondFile.name);

      findings.push({
        id: `finding_${randomUUID().slice(0, 8)}`,
        tool: "jscpd",
        language: dup.format,
        rule_id: ruleId,
        severity: "warning",
        confidence: 0.8,
        status: "needs_review",
        title: `Duplicate code block (${dup.lines} lines)`,
        summary: `Code in ${path.basename(firstFilePath)}:${dup.firstFile.startLoc.line} duplicates ${path.basename(secondFilePath)}:${dup.secondFile.startLoc.line}`,
        location: {
          file_path: firstFilePath,
          start_line: dup.firstFile.startLoc.line,
          end_line: dup.firstFile.endLoc.line,
        },
        evidence: {
          analyzer_version: "jscpd",
        },
        recommendation: {
          action: "refactor_candidate",
          rationale: `${dup.tokens} tokens duplicated across ${dup.lines} lines. Consider extracting shared logic.`,
          agent_instruction: "Review whether this duplication is intentional or should be refactored into a shared helper.",
        },
      });
    }

    // Cleanup temp directory
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch (error) {
    logger.error({ error, repoPath }, "jscpd analysis failed");
    // Try to cleanup even on error
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return findings;
}

// =============================================================================
// FALLOW ADAPTER
// =============================================================================

interface FallowUnusedExport {
  path: string;
  export_name: string;
  line: number;
  col: number;
  is_type_only: boolean;
}

interface FallowUnusedDependency {
  package_name: string;
  in_file: string;
}

interface FallowDeadCodeReport {
  kind: string;
  version: string;
  total_issues: number;
  summary: {
    unused_files: number;
    unused_exports: number;
    unused_types: number;
    unused_dependencies: number;
    unused_class_members: number;
  };
  unused_files: Array<{ path: string }>;
  unused_exports: FallowUnusedExport[];
  unused_types: FallowUnusedExport[];
  unused_dependencies: FallowUnusedDependency[];
  unused_class_members: Array<{ path: string; class_name: string; member_name: string; line: number }>;
}

async function runFallow(projectPath: string): Promise<AnalyzerFinding[]> {
  const findings: AnalyzerFinding[] = [];

  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    let stdout: string;
    try {
      const result = await execFileAsync("npx", [
        "fallow",
        "dead-code",
        "--format", "json",
      ], {
        timeout: ANALYZER_TIMEOUTS.fallow,
        cwd: projectPath,
        env: { ...process.env, npm_config_loglevel: "silent" },
      });
      stdout = result.stdout;
    } catch (execError: unknown) {
      // Fallow exits with code 1 when it finds issues - check if we got valid JSON
      const err = execError as { stdout?: string; code?: number; message?: string };
      if (err.stdout && err.stdout.includes('"kind"')) {
        stdout = err.stdout;
      } else if (err.message && err.message.includes('"kind"')) {
        // Sometimes the stdout is embedded in the error message
        const msgJsonStart = err.message.indexOf("{");
        if (msgJsonStart !== -1) {
          stdout = err.message.slice(msgJsonStart);
        } else {
          throw execError;
        }
      } else {
        throw execError;
      }
    }

    // Find the JSON object in stdout (skip any npm warnings)
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      throw new Error("No JSON output from Fallow");
    }
    const report: FallowDeadCodeReport = JSON.parse(stdout.slice(jsonStart));

    logger.info(
      { total: report.total_issues, exports: report.summary.unused_exports },
      "Fallow scan complete"
    );

    for (const exp of report.unused_exports) {
      findings.push({
        id: `finding_${randomUUID().slice(0, 8)}`,
        tool: "fallow",
        language: exp.path.endsWith(".ts") || exp.path.endsWith(".tsx") ? "typescript" : "javascript",
        rule_id: "fallow.unused_export",
        severity: "warning",
        confidence: 0.9,
        status: "needs_review",
        title: `Unused export: ${exp.export_name}`,
        summary: `Export '${exp.export_name}' in ${exp.path} is not imported anywhere.`,
        location: {
          file_path: path.join(projectPath, exp.path),
          start_line: exp.line,
          end_line: exp.line,
          symbol: exp.export_name,
        },
        evidence: {
          visibility: "public",
          analyzer_version: report.version,
        },
        recommendation: {
          action: "review_or_delete",
          rationale: exp.is_type_only
            ? "This type export is not used. Consider removing it or marking it as internal."
            : "This export is not imported anywhere in the codebase.",
          agent_instruction: "Check if this export is part of a public API before removing.",
        },
      });
    }

    for (const typ of report.unused_types || []) {
      findings.push({
        id: `finding_${randomUUID().slice(0, 8)}`,
        tool: "fallow",
        language: "typescript",
        rule_id: "fallow.unused_type",
        severity: "info",
        confidence: 0.9,
        status: "needs_review",
        title: `Unused type: ${typ.export_name}`,
        summary: `Type '${typ.export_name}' in ${typ.path} is not used.`,
        location: {
          file_path: path.join(projectPath, typ.path),
          start_line: typ.line,
          end_line: typ.line,
          symbol: typ.export_name,
        },
        evidence: {
          analyzer_version: report.version,
        },
        recommendation: {
          action: "review_or_delete",
          rationale: "This type definition is not referenced anywhere.",
        },
      });
    }

    for (const dep of report.unused_dependencies || []) {
      findings.push({
        id: `finding_${randomUUID().slice(0, 8)}`,
        tool: "fallow",
        language: "javascript",
        rule_id: "fallow.unused_dependency",
        severity: "warning",
        confidence: 0.95,
        status: "safe_to_fix",
        title: `Unused dependency: ${dep.package_name}`,
        summary: `Package '${dep.package_name}' is listed in package.json but not imported.`,
        location: {
          file_path: path.join(projectPath, dep.in_file || "package.json"),
          start_line: 1,
          end_line: 1,
        },
        evidence: {
          analyzer_version: report.version,
        },
        recommendation: {
          action: "review_or_delete",
          rationale: "This dependency can likely be removed from package.json.",
          agent_instruction: "Run npm uninstall to remove this unused package.",
        },
      });
    }
  } catch (error) {
    logger.error({ error, projectPath }, "Fallow analysis failed");
    throw error;
  }

  return findings;
}

// =============================================================================
// PROJECT DISCOVERY
// =============================================================================

interface DiscoveredProject {
  type: "csharp" | "typescript" | "javascript";
  path: string;
  name: string;
}

async function discoverProjects(
  repoPath: string
): Promise<DiscoveredProject[]> {
  const projects: DiscoveredProject[] = [];

  async function findFiles(
    dir: string,
    pattern: RegExp
  ): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            !["node_modules", "bin", "obj", ".git", "dist", "build"].includes(
              entry.name
            )
          ) {
            results.push(...(await findFiles(fullPath, pattern)));
          }
        } else if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
    return results;
  }

  const slnFiles = await findFiles(repoPath, /\.sln$/);
  for (const sln of slnFiles) {
    projects.push({
      type: "csharp",
      path: sln,
      name: path.basename(sln, ".sln"),
    });
  }

  const packageJsonFiles = await findFiles(repoPath, /^package\.json$/);
  for (const pkg of packageJsonFiles) {
    try {
      const content = await fs.readFile(pkg, "utf-8");
      const parsed = JSON.parse(content);
      const dir = path.dirname(pkg);
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const hasTsConfig = await fs
        .access(tsconfigPath)
        .then(() => true)
        .catch(() => false);

      projects.push({
        type: hasTsConfig ? "typescript" : "javascript",
        path: pkg,
        name: parsed.name || path.basename(dir),
      });
    } catch {
      // Skip invalid package.json
    }
  }

  return projects;
}

// =============================================================================
// MARKDOWN REPORT
// =============================================================================

function generateMarkdownReport(job: AnalysisJob): string {
  const lines: string[] = [];

  lines.push(`# Codebase Health Report`);
  lines.push("");
  lines.push(`**Repository:** ${job.repository_path}`);
  lines.push(`**Generated:** ${job.completed_at || job.updated_at}`);
  lines.push(`**Status:** ${job.status}`);
  lines.push("");

  if (job.summary) {
    lines.push(`## Summary`);
    lines.push("");
    lines.push(`- **Total findings:** ${job.summary.total_findings}`);
    lines.push(
      `- **By severity:** ${Object.entries(job.summary.by_severity)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`
    );
    lines.push("");
  }

  const findings = job.findings || [];

  const unusedFindings = findings.filter((f) =>
    f.rule_id.includes("unused")
  );
  if (unusedFindings.length > 0) {
    lines.push(`## Unused Code`);
    lines.push("");
    for (const f of unusedFindings) {
      lines.push(
        `- **${f.title}** (${f.status}) - ${f.location.file_path}:${f.location.start_line}`
      );
      lines.push(`  ${f.summary}`);
    }
    lines.push("");
  }

  const duplicateFindings = findings.filter((f) =>
    f.rule_id.includes("duplicate")
  );
  if (duplicateFindings.length > 0) {
    lines.push(`## Duplicates`);
    lines.push("");
    for (const f of duplicateFindings) {
      lines.push(
        `- **${f.title}** (${f.status}) - ${f.location.file_path}:${f.location.start_line}`
      );
      lines.push(`  ${f.summary}`);
    }
    lines.push("");
  }

  const complexityFindings = findings.filter((f) =>
    f.rule_id.includes("complexity")
  );
  if (complexityFindings.length > 0) {
    lines.push(`## Complexity Hotspots`);
    lines.push("");
    for (const f of complexityFindings) {
      lines.push(
        `- **${f.title}** (${f.status}) - ${f.location.file_path}:${f.location.start_line}`
      );
      lines.push(`  ${f.summary}`);
    }
    lines.push("");
  }

  if (job.errors && job.errors.length > 0) {
    lines.push(`## Analyzer Notes`);
    lines.push("");
    for (const e of job.errors) {
      lines.push(`- **${e.analyzer}:** ${e.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function saveMarkdownReport(
  repoPath: string,
  job: AnalysisJob
): Promise<void> {
  const markdown = generateMarkdownReport(job);
  const jobDir = path.join(repoPath, RUNS_DIR, job.job_id);
  await fs.writeFile(path.join(jobDir, "report.md"), markdown);
}

// =============================================================================
// ANALYZE REPOSITORY
// =============================================================================

export async function analyzeRepository(
  input: AnalyzeRepositoryInput
): Promise<{ job_id: string; status: string; stages: StageStatus[] }> {
  const jobId = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const job: AnalysisJob = {
    job_id: jobId,
    repository_path: input.repository_path,
    status: "queued",
    created_at: now,
    updated_at: now,
    stages: [
      { stage: "discovery", status: "pending" },
      { stage: "roslyn", status: "pending" },
      { stage: "jscpd", status: "pending" },
      { stage: "fallow", status: "pending" },
      { stage: "report", status: "pending" },
    ],
    languages: input.languages,
    include_tests: input.include_tests,
    findings: [],
    errors: [],
    pinned: false,
  };

  await saveJob(input.repository_path, job);

  runAnalysisAsync(input.repository_path, job).catch((err) => {
    logger.error({ err, jobId }, "Background analysis failed");
  });

  return {
    job_id: jobId,
    status: job.status,
    stages: job.stages,
  };
}

async function runAnalysisAsync(
  repoPath: string,
  job: AnalysisJob
): Promise<void> {
  const updateStage = async (
    stage: AnalysisStage,
    status: StageStatus["status"],
    extra?: Partial<StageStatus>
  ) => {
    const stageObj = job.stages.find((s) => s.stage === stage);
    if (stageObj) {
      stageObj.status = status;
      if (status === "running") stageObj.started_at = new Date().toISOString();
      if (status === "completed" || status === "failed")
        stageObj.completed_at = new Date().toISOString();
      Object.assign(stageObj, extra);
    }
    job.updated_at = new Date().toISOString();
    await saveJob(repoPath, job);
  };

  try {
    job.status = "running";
    await saveJob(repoPath, job);

    // Stage 1: Discovery
    await updateStage("discovery", "running");
    const config = await loadAnalyzerConfig(repoPath);
    const projects = await discoverProjects(repoPath);
    logger.info({ projects: projects.length }, "Discovered projects");
    await updateStage("discovery", "completed");

    // Stage 2: Roslyn
    const csharpProjects = projects.filter((p) => p.type === "csharp");
    if (csharpProjects.length > 0 && config.analyzers?.roslyn?.enabled !== false) {
      await updateStage("roslyn", "running");
      try {
        for (const proj of csharpProjects) {
          const findings = await findUnusedPrivateMembers(proj.path);
          job.findings = [...(job.findings || []), ...findings];
        }
        await updateStage("roslyn", "completed", {
          finding_count: job.findings?.length || 0,
        });
      } catch (error) {
        job.errors?.push({
          analyzer: "roslyn",
          error: (error as Error).message,
          recoverable: true,
        });
        await updateStage("roslyn", "failed", {
          error: (error as Error).message,
        });
      }
    } else {
      await updateStage("roslyn", "skipped");
    }

    // Stage 3: jscpd
    if (config.analyzers?.jscpd?.enabled !== false) {
      await updateStage("jscpd", "running");
      try {
        const jscpdFindings = await runJscpd(repoPath);
        job.findings = [...(job.findings || []), ...jscpdFindings];
        await updateStage("jscpd", "completed", {
          finding_count: jscpdFindings.length,
        });
      } catch (error) {
        job.errors?.push({
          analyzer: "jscpd",
          error: (error as Error).message,
          recoverable: true,
        });
        await updateStage("jscpd", "failed", {
          error: (error as Error).message,
        });
      }
    } else {
      await updateStage("jscpd", "skipped");
    }

    // Stage 4: Fallow
    const jstsProjects = projects.filter((p) => p.type === "typescript" || p.type === "javascript");
    if (jstsProjects.length > 0 && config.analyzers?.fallow?.enabled !== false) {
      await updateStage("fallow", "running");
      try {
        for (const proj of jstsProjects) {
          const projectDir = path.dirname(proj.path);
          const fallowFindings = await runFallow(projectDir);
          job.findings = [...(job.findings || []), ...fallowFindings];
        }
        await updateStage("fallow", "completed", {
          finding_count: job.findings?.filter(f => f.tool === "fallow").length || 0,
        });
      } catch (error) {
        job.errors?.push({
          analyzer: "fallow",
          error: (error as Error).message,
          recoverable: true,
        });
        await updateStage("fallow", "failed", {
          error: (error as Error).message,
        });
      }
    } else {
      await updateStage("fallow", "skipped");
    }

    // Stage 5: Report
    await updateStage("report", "running");
    job.summary = {
      total_findings: job.findings?.length || 0,
      by_severity: {
        info: job.findings?.filter((f) => f.severity === "info").length || 0,
        warning:
          job.findings?.filter((f) => f.severity === "warning").length || 0,
        error: job.findings?.filter((f) => f.severity === "error").length || 0,
      },
      by_status: {
        informational:
          job.findings?.filter((f) => f.status === "informational").length || 0,
        safe_to_fix:
          job.findings?.filter((f) => f.status === "safe_to_fix").length || 0,
        needs_review:
          job.findings?.filter((f) => f.status === "needs_review").length || 0,
        blocked:
          job.findings?.filter((f) => f.status === "blocked").length || 0,
      },
      by_tool: {},
    };
    for (const f of job.findings || []) {
      job.summary.by_tool[f.tool] = (job.summary.by_tool[f.tool] || 0) + 1;
    }
    await saveMarkdownReport(repoPath, job);
    await updateStage("report", "completed");

    job.status = "completed";
    job.completed_at = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.errors?.push({
      analyzer: "orchestrator",
      error: (error as Error).message,
      recoverable: false,
    });
  }

  job.updated_at = new Date().toISOString();
  await saveJob(repoPath, job);
}

// =============================================================================
// GET ANALYSIS RESULT
// =============================================================================

export async function getAnalysisResult(input: GetAnalysisResultInput & { repository_path?: string }): Promise<{
  job: AnalysisJob | null;
  markdown?: string;
  error?: string;
}> {
  const repoPath = input.repository_path || ".";
  const job = await loadJob(repoPath, input.job_id);
  if (!job) {
    return { job: null, error: `Job not found: ${input.job_id}` };
  }

  let markdown: string | undefined;
  if (input.include_markdown && JOB_ID_RE.test(input.job_id)) {
    try {
      const runsDir = await fs.realpath(path.join(repoPath, RUNS_DIR)).catch(() => null);
      if (runsDir) {
        const mdPath = path.resolve(runsDir, input.job_id, "report.md");
        if (mdPath.startsWith(runsDir + path.sep)) {
          markdown = await fs.readFile(mdPath, "utf-8");
        }
      }
    } catch {
      // Report not yet generated
    }
  }

  const result: AnalysisJob = { ...job };
  if (input.include_findings === false) {
    delete result.findings;
  }

  return { job: result, markdown };
}

// =============================================================================
// LIST ANALYSIS RUNS
// =============================================================================

export async function listAnalysisRuns(input: ListAnalysisRunsInput): Promise<{
  runs: Array<{
    job_id: string;
    status: string;
    created_at: string;
    completed_at?: string;
    finding_count: number;
    pinned: boolean;
  }>;
}> {
  const runsPath = path.join(input.repository_path, RUNS_DIR);

  try {
    const entries = await fs.readdir(runsPath, { withFileTypes: true });
    const runs: Array<{
      job_id: string;
      status: string;
      created_at: string;
      completed_at?: string;
      finding_count: number;
      pinned: boolean;
    }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;

      const job = await loadJob(input.repository_path, entry.name);
      if (!job) continue;

      if (input.status_filter && job.status !== input.status_filter) continue;
      if (!input.include_pinned && job.pinned) continue;

      runs.push({
        job_id: job.job_id,
        status: job.status,
        created_at: job.created_at,
        completed_at: job.completed_at,
        finding_count: job.findings?.length || 0,
        pinned: job.pinned,
      });
    }

    runs.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return { runs: runs.slice(0, input.limit) };
  } catch {
    return { runs: [] };
  }
}

// =============================================================================
// CLEANUP ANALYSIS RUNS
// =============================================================================

export async function cleanupAnalysisRuns(
  input: CleanupAnalysisRunsInput
): Promise<{
  dry_run: boolean;
  runs_to_delete: string[];
  runs_deleted: string[];
  runs_skipped: Array<{ job_id: string; reason: string }>;
}> {
  const runsPath = path.join(input.repository_path, RUNS_DIR);
  const runsToDelete: string[] = [];
  const runsDeleted: string[] = [];
  const runsSkipped: Array<{ job_id: string; reason: string }> = [];

  try {
    const entries = await fs.readdir(runsPath, { withFileTypes: true });
    const jobs: AnalysisJob[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;
      const job = await loadJob(input.repository_path, entry.name);
      if (job) jobs.push(job);
    }

    jobs.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const activeStatuses = ["queued", "running", "finalizing"];
    const now = Date.now();
    const maxAgeDays = input.older_than_days || 30;
    const failedMaxAgeDays = 7;

    let keptCount = 0;

    for (const job of jobs) {
      if (activeStatuses.includes(job.status)) {
        runsSkipped.push({ job_id: job.job_id, reason: "active" });
        continue;
      }

      if (job.pinned && input.delete_unpinned_only) {
        runsSkipped.push({ job_id: job.job_id, reason: "pinned" });
        keptCount++;
        continue;
      }

      const ageMs = now - new Date(job.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      const isFailed = ["failed", "timeout"].includes(job.status);
      const maxAge = isFailed ? failedMaxAgeDays : maxAgeDays;

      if (ageDays > maxAge) {
        runsToDelete.push(job.job_id);
      } else if (keptCount >= input.keep_latest) {
        runsToDelete.push(job.job_id);
      } else {
        keptCount++;
      }
    }

    if (!input.dry_run) {
      for (const jobId of runsToDelete) {
        try {
          await fs.rm(path.join(runsPath, jobId), { recursive: true });
          runsDeleted.push(jobId);
        } catch (error) {
          runsSkipped.push({
            job_id: jobId,
            reason: (error as Error).message,
          });
        }
      }

      // Write audit log
      const logPath = path.join(runsPath, "cleanup-log.jsonl");
      const logEntry = {
        timestamp: new Date().toISOString(),
        deleted: runsDeleted,
        reason: "retention_policy",
      };
      await fs.appendFile(logPath, JSON.stringify(logEntry) + "\n");
    }

    return {
      dry_run: input.dry_run,
      runs_to_delete: runsToDelete,
      runs_deleted: runsDeleted,
      runs_skipped: runsSkipped,
    };
  } catch {
    return {
      dry_run: input.dry_run,
      runs_to_delete: [],
      runs_deleted: [],
      runs_skipped: [],
    };
  }
}
