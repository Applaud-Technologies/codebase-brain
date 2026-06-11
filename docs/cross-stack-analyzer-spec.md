# Cross-Stack Analyzer Spec

## Purpose

Codebase Brain should become the evidence layer for AI-assisted development across Randall's normal stack: C#/.NET backends with Angular, React, and TypeScript frontends.

Fallow is a strong model for deterministic JavaScript and TypeScript codebase analysis, but it is not the product boundary for Codebase Brain. Codebase Brain should treat Fallow as one analyzer plugin and combine its findings with Roslyn-based C# analysis, language-neutral duplication checks, lexical search, semantic search, and graph evidence.

The goal is one agent-facing workflow:

1. Search the existing codebase before writing.
2. Analyze the repository for dead, duplicated, complex, or risky code.
3. Explain evidence in a consistent format across C#, JavaScript, and TypeScript.
4. Block or warn agents before they create avoidable duplication.

## Non-Goals

This effort is not trying to replace every static analysis or quality tool in the stack.

Non-goals:

- Replacing compiler warnings.
- Replacing unit, integration, or end-to-end tests.
- Replacing full security scanning or SAST.
- Replacing NDepend for teams that already want a commercial .NET analysis product.
- Automatically deleting code without human review.
- Treating token-level duplication as proof that code should be refactored.
- Using AI to invent findings that analyzers did not produce.

The product boundary is narrower: Codebase Brain should gather analyzer evidence and make it usable by coding agents before they write code, review code, or suggest refactors.

## Problem

Most current agent coding workflows are weak at repository memory. They can write plausible code, but they often miss existing behavior, create duplicate methods, add dead exports, ignore public API boundaries, and increase maintenance cost.

Fallow helps with this for JS/TS by producing deterministic evidence such as unused exports, duplicate code, and complexity hotspots. The same style of evidence is needed for C#/.NET, but Fallow does not analyze C#.

Codebase Brain already has the correct shape:

- MCP gateway for agent access.
- Semantic search for behavior discovery.
- Lexical/symbol search for exact matches.
- Graph-oriented thinking for usage and impact.
- `services/roslyn-worker` for C# compiler-grade analysis.

The gap is turning these pieces into one cross-stack findings engine.

## Design Principles

- Deterministic evidence first: analyzer output should be factual, repeatable, and auditable.
- AI consumes evidence; AI does not invent analyzer facts.
- Language-specific analyzers are plugins, not separate products.
- Roslyn is the source of truth for C# symbols, references, types, and call relationships.
- Fallow is the source of truth for JS/TS unused exports, dependency hygiene, and JS/TS duplicate/complexity findings.
- jscpd can provide language-neutral token-level duplication, including C#.
- Public API boundaries must be modeled so Codebase Brain does not recommend unsafe deletions.
- All findings should normalize into one schema for MCP clients.

## Analyzer Execution Model

Analyzer execution should be explicit, observable, and tolerant of partial failure.

Discovery:

- Detect C# projects from `.sln` and `.csproj` files.
- Detect JS/TS projects from `package.json`, `tsconfig.json`, `vite.config.*`, `next.config.*`, `angular.json`, and workspace files.
- Allow manual project roots to override automatic discovery.

Execution:

- Run analyzers through a separate analyzer orchestrator or worker process instead of embedding command execution directly inside MCP tool handlers.
- The MCP gateway should request analysis, collect normalized results, and return agent-facing responses.
- The analyzer orchestrator should run in stages so quick findings can return before slower/deeper analysis.
- Within each stage, independent analyzers should run in parallel where possible.
- Prefer locally installed project tools when available.
- Fall back to package-runner commands such as `npx` only when acceptable for local developer use.
- Keep Docker execution as an optional future mode for CI or isolated environments.

Timeouts and failures:

- Each analyzer gets a timeout.
- Analyzer failures should not fail the entire repository analysis unless the caller requests strict mode.
- Partial results should include skipped analyzers, exit codes, stderr summaries, and remediation hints.
- MCP responses should clearly indicate whether the report is complete or partial.
- Slow analyzers should not block faster analyzer results from being returned when partial results are acceptable.

Suggested MVP stages:

- Stage 1: project discovery, config load, exclusions, quick duplicate scan, and existing cached findings.
- Stage 2: Roslyn symbol/reference analysis and C# unused symbol findings.
- Stage 3: complexity findings, Fallow JS/TS findings, and duplicate-to-symbol correlation.
- Stage 4: Markdown health report generation and guardrail warning synthesis.

Caching:

- Cache analyzer results by repository path, analyzer name, config hash, and file-change fingerprint.
- Allow callers to bypass cache with `force_refresh`.
- Keep early implementation simple with repo-local JSON/Markdown artifacts before deciding on database persistence.
- Store MVP run artifacts under `.codebase-brain/runs/{job_id}/`.
- Suggested artifact files are `.codebase-brain/runs/{job_id}/result.json` and `.codebase-brain/runs/{job_id}/report.md`.
- Run artifacts should be ignored by git.
- Include `.codebase-brain/README.md` to explain local analysis artifacts and retention expectations.

Retention and cleanup:

- MVP should include retention instead of relying only on manual cleanup.
- Default retention should keep the latest 25 completed runs per repository and delete completed runs older than 30 days.
- Failed, canceled, or timed-out runs should use a shorter default retention window of 7 days.
- A run can be pinned to opt out of automatic cleanup.
- Cleanup should run opportunistically when a new analysis job starts and should also be callable directly.
- Cleanup should never delete a run that is currently `queued`, `running`, or `finalizing`.
- Cleanup should write a small audit entry into `.codebase-brain/runs/cleanup-log.jsonl` with deleted run IDs, timestamps, and reason.
- Retention settings should be configurable in `codebase-brain.config.json`.
- Dashboard controls should allow humans to inspect run history, pin/unpin runs, delete selected runs, and trigger cleanup manually.
- MCP/CLI controls should expose the same cleanup behavior so agents and CI do not require the dashboard.

Configuration:

- MVP should support a repo-level config file named `codebase-brain.config.json`.
- If the config file is missing, analyzers should use built-in defaults.
- Complexity thresholds should be configurable in this file.
- Exclusion patterns should be configurable in this file.
- Retention limits should be configurable in this file.
- The config hash should be included in analyzer metadata and cache keys.
- The example project should include a sample `codebase-brain.config.json` that documents the expected shape.
- The sample config may include a `$schema` reference as a placeholder.
- Creating the JSON Schema file is deferred until implementation stabilizes the config shape.

## Exclusions

Analyzer results should ignore common generated, vendored, and build-output paths by default.

Default directory exclusions:

- `bin/`
- `obj/`
- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `.next/`
- `.angular/`
- `.git/`

Default file exclusions:

- `*.g.cs`
- `*.generated.cs`
- `*.Designer.cs`
- `*.AssemblyInfo.cs`
- generated API clients
- generated GraphQL files
- snapshots
- minified JavaScript

Special handling:

- EF migrations should be included for dependency awareness, but findings should default to `informational` or `needs_review`.
- Test fixtures and snapshots should not drive duplicate-code warnings unless the caller explicitly includes tests.
- Public generated clients should be marked as API boundary candidates, not refactor candidates.

## Target Architecture

```text
AI Agent
  |
  v
MCP Gateway
  |
  +-- find_existing_behavior
  +-- find_symbols
  +-- trace_usage
  +-- pre_write_guard
  +-- analyze_repository
  +-- codebase_health
  |
  v
Analyzer Orchestrator
  |
  +-- Fallow Adapter
  |     +-- JS/TS unused exports
  |     +-- JS/TS duplicate blocks
  |     +-- JS/TS complexity hotspots
  |     +-- dependency hygiene
  |
  +-- Roslyn Adapter
  |     +-- C# symbols
  |     +-- references and implementations
  |     +-- call hierarchy
  |     +-- unused private/internal members
  |     +-- C# complexity and impact radius
  |
  +-- jscpd Adapter
  |     +-- language-neutral copy/paste duplicates
  |     +-- C# duplicate blocks
  |
  +-- Search Providers
        +-- semantic behavior search
        +-- lexical/symbol search
        +-- graph traversal
```

## Analyzer Plugins

### Fallow Adapter

Scope:

- JavaScript
- TypeScript
- React
- Angular
- Node/MCP services

Responsibilities:

- Run Fallow against JS/TS project roots.
- Parse JSON output.
- Convert Fallow findings into Codebase Brain findings.
- Preserve source locations, severity, rule IDs, and remediation hints.

Expected findings:

- Unused exports.
- Unused dependencies.
- Duplicate code blocks.
- Complexity hotspots.
- Risky PR changes when available.

Non-goals:

- C# analysis.
- Replacing Roslyn.
- Acting as the only quality gate.

### Roslyn Adapter

Scope:

- C# projects.
- .NET solutions.
- ASP.NET services.
- Shared class libraries.
- Test projects.

Current local foundation:

- `services/roslyn-worker` already exposes solution analysis, symbol search, references, implementations, and call hierarchy.

Responsibilities:

- Load `.sln` and `.csproj` files through MSBuildWorkspace.
- Build symbol tables for classes, interfaces, methods, properties, fields, constructors, records, and enums.
- Resolve references using Roslyn semantic models instead of text matching.
- Identify unused private/internal symbols.
- Calculate method-level complexity metrics.
- Build call graph and impact radius.
- Detect public API boundaries.
- Normalize C# findings into the shared finding schema.

Expected findings:

- `csharp.unused_private_member`
- `csharp.unused_internal_type`
- `csharp.unreferenced_method`
- `csharp.high_complexity_method`
- `csharp.large_class`
- `csharp.near_duplicate_method`
- `csharp.public_api_boundary`
- `csharp.high_impact_symbol`

Complexity model:

- Complexity should use a configurable combination of signals, not one metric only.
- MVP signals should include cyclomatic complexity, method length, nesting depth, parameter count, and branch count.
- Each signal should be reported separately in finding evidence.
- The combined score should be explainable, with thresholds stored in `codebase-brain.config.json`.
- Repositories should be able to tune thresholds later without changing analyzer code.

Deletion safety rules:

- Never recommend deleting public members by default.
- Public members should be context-only during the MVP.
- Treat controllers, minimal API endpoints, public interfaces, DI registrations, EF entities, DTOs, serializers, reflection usage, and externally referenced assemblies as API boundary candidates.
- Require stronger evidence before marking internal members unused across project boundaries.
- Classify unused internal members during the MVP, but default them to `needs_review`.
- Internal member findings should explain that tests, reflection, DI, serialization, generated code, or framework conventions may still use them.
- Private unused members may be marked `safe_to_fix` only when Roslyn reports zero references and no boundary flags.
- Mark uncertain findings as `needs_review`, not `safe_to_delete`.

### jscpd Adapter

Scope:

- Cross-language duplication.
- Especially useful as a quick first pass for C# duplicate blocks.

Responsibilities:

- Run jscpd with JSON output.
- Convert duplicate blocks into normalized findings.
- Correlate duplicates with Roslyn symbols when possible.
- For C# duplicates, map each duplicate block back to the containing method, property, constructor, class, or record when Roslyn can resolve it.
- Keep raw file/line ranges even when Roslyn symbol mapping fails.

Expected findings:

- `duplicate.token_block`
- `duplicate.cross_file_block`
- `duplicate.same_file_block`

Limitations:

- Token-level duplication is not semantic duplication.
- Should not be used alone for refactoring recommendations.
- Duplicate findings without Roslyn symbol mapping should remain line-range evidence only.

## Shared Finding Schema

```json
{
  "id": "finding_01J...",
  "tool": "roslyn-worker",
  "language": "csharp",
  "rule_id": "csharp.unreferenced_method",
  "severity": "warning",
  "confidence": 0.86,
  "status": "needs_review",
  "title": "Method appears unreferenced",
  "summary": "CalculateLegacyDiscount has no references inside the loaded solution.",
  "location": {
    "file_path": "src/Pricing/DiscountService.cs",
    "start_line": 42,
    "end_line": 67,
    "symbol": "Pricing.DiscountService.CalculateLegacyDiscount"
  },
  "evidence": {
    "reference_count": 0,
    "visibility": "private",
    "callers": [],
    "public_api_boundary": false,
    "analyzer_version": "roslyn-worker"
  },
  "recommendation": {
    "action": "review_or_delete",
    "rationale": "Private method has no references in the solution.",
    "agent_instruction": "Do not create new discount logic until existing pricing methods are reviewed."
  }
}
```

## Severity, Status, and Actions

Severity describes how important the finding is.

Allowed severity values:

- `info`: Useful context, not a problem by itself.
- `warning`: Likely maintenance issue or agent-writing risk.
- `error`: High-confidence issue that should block or strongly warn in CI/PR workflows.

Status describes how safe it is to act.

Allowed status values:

- `informational`: Evidence only. No action recommended.
- `safe_to_fix`: High-confidence issue with low blast radius.
- `needs_review`: Useful finding, but human judgment is required.
- `blocked`: Agent should not proceed until the issue is resolved or explicitly approved.

Recommended action describes what the agent or developer should do.

Allowed action values:

- `reuse_existing`
- `extend_existing`
- `review_or_delete`
- `refactor_candidate`
- `reduce_complexity`
- `add_tests_before_change`
- `human_review_required`
- `no_action`

Default policy:

- Public API boundary findings should never be `safe_to_fix`.
- Duplicate findings from jscpd should default to `needs_review`.
- Unused private C# members can be `safe_to_fix` only when Roslyn reports zero references and no boundary flags.
- Unused internal C# members should be classified, but default to `needs_review` during the MVP.
- Public C# members should be context-only during the MVP, not deletion recommendations.
- High-complexity findings should default to `needs_review` unless the proposed agent change would add more complexity to that same symbol.
- If analyzer evidence is incomplete, findings must not be marked `safe_to_fix`.

## Agent-Facing MCP Tools

### `analyze_repository`

Starts configured analyzers and returns a staged analysis job/result handle immediately.

Inputs:

- `repository_path`
- `languages`
- `include_tests`
- `changed_files_only`
- `severity_threshold`
- `analyzers`

Outputs:

- `job_id` or `result_id` for follow-up status/result retrieval.
- Current stage status.
- Summary counts.
- Normalized findings.
- Analyzer execution metadata.
- Files skipped and why.
- Agent-readable JSON as the canonical output.
- Human-readable Markdown generated from the same findings.

MVP behavior:

- Return immediately by default.
- Allow clients to poll for stage completion.
- Return partial findings when available.
- Include a final completion status when all stages finish.

### `get_analysis_result`

Retrieves status, partial findings, or final findings for an analysis job.

Inputs:

- `job_id`
- `include_markdown`
- `include_findings`
- `stage_filter`

Outputs:

- Job status.
- Stage statuses.
- Partial or final normalized findings.
- Partial or final Markdown report.
- Analyzer execution metadata.
- Errors, skipped analyzers, and timeout information.

MVP behavior:

- Keep this separate from `analyze_repository` so starting analysis and reading results are easy to test independently.
- Return partial results while the job is still running.
- Return final results after all stages complete or timeout.

### `cleanup_analysis_runs`

Deletes old local analysis artifacts according to the configured retention policy.

Inputs:

- `repository_path`
- `dry_run`
- `older_than_days`
- `keep_latest`
- `include_failed`
- `delete_unpinned_only`

Outputs:

- Runs selected for deletion.
- Runs actually deleted.
- Runs skipped and why.
- Bytes reclaimed when available.
- Cleanup log path.

MVP behavior:

- Default to `dry_run: true` unless called internally by the orchestrator's scheduled/opportunistic cleanup path.
- Never delete pinned runs.
- Never delete active runs.
- Use the same retention policy as the dashboard.

### `list_analysis_runs`

Lists local run artifacts for dashboard, CLI, and agent use.

Inputs:

- `repository_path`
- `status_filter`
- `include_pinned`
- `limit`

Outputs:

- Run IDs.
- Created and completed timestamps.
- Status.
- Summary counts.
- Pinned state.
- Artifact paths.
- Report title or first summary line when available.

MVP behavior:

- Read from `.codebase-brain/runs/`.
- Sort newest first.
- Return enough metadata for a dashboard run-history table without loading every full `result.json`.

### `codebase_health`

Returns a concise health summary for agent and human use.

Outputs:

- Unused code summary.
- Duplicate code summary.
- Complexity hotspots.
- Risky high-impact symbols.
- Recommended next actions.
- Markdown report text suitable for quick review or PR comments.

Markdown report structure:

- Group findings by developer concern first, not by analyzer tool.
- MVP groups should include `Unused code`, `Duplicates`, `Complexity`, `Guardrail warnings`, and `Analyzer notes`.
- Preserve analyzer source, such as Roslyn, jscpd, or Fallow, as metadata inside each finding.
- Put high-signal recommended actions near the top of each group.

### `pre_write_guard`

Extends the existing search-before-write policy with analyzer evidence.

Additional checks:

- Has semantic search been performed?
- Has symbol search been performed?
- Are there existing duplicate or similar findings?
- Is the proposed location already complex?
- Is there an existing public API or service that should be extended instead?

MVP enforcement mode:

- `pre_write_guard` should consume analyzer findings in warning mode.
- Analyzer findings should warn agents about risk, duplication, complexity, or reuse opportunities.
- Analyzer findings should not hard-block writes in the MVP.
- The only MVP hard block should remain missing required search evidence.
- Hard-blocking based on analyzer findings can be added later after false positives are measured.

### `trace_usage`

Uses Roslyn and graph evidence to explain impact radius.

Outputs:

- Callers.
- Callees.
- Implementations.
- Interface contracts.
- Test coverage hints when available.
- Public API boundary warnings.

## Implementation Plan

### Phase 1: Normalize Analyzer Output

- Add shared finding TypeScript types in the MCP gateway.
- Add analyzer result envelope with metadata and errors.
- Add async-first `analyze_repository` MCP tool stub that returns a job/result handle immediately.
- Add separate `get_analysis_result` MCP tool for polling and result retrieval.
- Add `list_analysis_runs` and `cleanup_analysis_runs` MCP tool stubs for run-history and retention control.
- Add an analyzer orchestrator/worker boundary for parallel analyzer execution.
- Store findings in a local JSON artifact for early testing.
- Add retention cleanup for local run artifacts, including pin support and dry-run behavior.
- Define severity, status, action, and confidence conventions.
- Generate Markdown health summaries from normalized findings.

Deliverable:

- Agent can call `analyze_repository`, receive a job/result handle immediately, and use `get_analysis_result` to retrieve consistent findings plus a human-readable Markdown summary as stages complete. Humans and agents can list and clean up local run artifacts without manually deleting directories.

### Phase 2: Prove C# Findings Path

- Add Roslyn findings for unused private methods, fields, properties, and classes.
- Add configurable Roslyn method-level complexity findings for C#.
- Include cyclomatic complexity, method length, nesting depth, parameter count, and branch count as separate evidence fields.
- Add a Roslyn endpoint or response shape for public API boundary hints.
- Add jscpd execution for C# duplicate blocks.
- Map C# duplicate blocks back to containing Roslyn symbols when possible.
- Map both Roslyn and jscpd output into normalized findings.
- Add fixture tests using `test/sample-repo`.

Deliverable:

- Codebase Brain can return useful C# findings from the sample repo.

### Phase 3: Add Fallow Adapter

- Add Fallow execution wrapper for JS/TS roots.
- Detect JS/TS project roots from `package.json`, `tsconfig.json`, and workspace layout.
- Parse Fallow JSON.
- Map Fallow rules into normalized findings.
- Include JS/TS complexity findings from Fallow when available.
- Add fixture tests using `services/mcp-gateway`.

Deliverable:

- Codebase Brain exposes Fallow findings through MCP.

### Phase 4: Generalize jscpd Adapter

- Add jscpd wrapper with JSON output.
- Include C#, JS, TS, and frontend paths.
- Map duplicate blocks into normalized findings.
- Correlate C# duplicate locations with Roslyn methods when possible.

Deliverable:

- Codebase Brain can report token-level duplicates across C# and TS/JS.

### Phase 5: Extend Roslyn Worker

- Add method complexity metrics.
- Add call graph export.
- Add impact radius analysis.
- Expand public API boundary detection.
- Return normalized or easily mappable C# findings.

Deliverable:

- Codebase Brain can produce Fallow-style C# findings from Roslyn.

### Phase 6: Merge Evidence Into Guardrails

- Feed findings into `pre_write_guard`.
- Start in warning mode for analyzer-driven findings.
- Warn when proposed code duplicates existing behavior.
- Warn when proposed code lands in an already complex file/class.
- Suggest reuse or extension when a nearby symbol has high similarity.
- Add confidence and review thresholds.
- Continue hard-blocking only when required search evidence is missing.

Deliverable:

- Agents receive a single decision layer combining semantic search and deterministic analyzer evidence, with analyzer findings warning instead of blocking during the MVP.

### Phase 7: CI and PR Workflow

- Add CLI command or script for repository health checks.
- Support changed-files-only mode.
- Reuse the Markdown summary for PR comments.
- Emit JSON for agents.
- Track trend metrics over time.

Deliverable:

- Codebase Brain can run as a pre-PR or CI quality gate.

## MVP Acceptance Criteria

MVP testing ground:

- The first implementation should use the example project inside the Codebase Brain repository as the controlled test bed.
- Real client repositories are not the first target.
- Client-repo support should influence the design, but not expand the first build slice.

The first useful version is done when these are true:

- `analyze_repository` is available through the MCP gateway.
- `analyze_repository` returns immediately with a job/result ID.
- `get_analysis_result` is available through the MCP gateway.
- Clients can retrieve partial and final staged results.
- The response uses a stable normalized finding schema.
- The response includes agent-readable JSON and human-readable Markdown.
- Markdown groups findings by developer concern, with analyzer source shown as metadata.
- The response includes analyzer metadata, including partial-failure details.
- Analyzer execution runs through a separate orchestrator/worker boundary and supports parallel analyzer execution.
- Analyzer execution is staged so quick findings can return before deeper analysis when partial results are acceptable.
- Analysis jobs/results are stored as repo-local artifacts under `.codebase-brain/runs/{job_id}/`.
- Analysis run artifacts have default retention rules: keep the latest 25 completed runs, delete completed runs older than 30 days, and delete failed/canceled/timed-out runs older than 7 days.
- Analysis runs can be pinned to opt out of automatic cleanup.
- Cleanup can run automatically when new analysis starts and can be triggered manually through an MCP/CLI command.
- Dashboard run-history controls can list runs, show status/summary, pin or unpin runs, delete selected runs, and trigger cleanup.
- `.codebase-brain/README.md` exists to document local artifact behavior.
- The analyzer supports `codebase-brain.config.json` with built-in defaults when missing.
- `test/sample-repo/codebase-brain.config.json` exists as the MVP sample config.
- A JSON Schema file is not required for MVP.
- C# project discovery works against `test/sample-repo`.
- Roslyn returns unused private method, field, property, and class findings.
- Roslyn classifies unused internal members as `needs_review`.
- Roslyn returns configurable C# method-level complexity findings.
- Complexity findings include cyclomatic complexity, method length, nesting depth, parameter count, and branch count evidence.
- Public C# members are reported only as context/API-boundary evidence during the MVP.
- jscpd returns C# duplicate findings against `test/sample-repo` when duplicates exist.
- C# duplicate findings include containing method/class symbol metadata when Roslyn can resolve it.
- Fallow returns JS/TS findings against `services/mcp-gateway`.
- Fallow complexity findings are included when available.
- Default exclusions prevent `bin/`, `obj/`, `node_modules/`, generated C# files, and build artifacts from polluting results.
- Findings include severity, status, confidence, source location, evidence, and recommended action.
- `pre_write_guard` can consume analyzer findings in addition to semantic search evidence.
- `pre_write_guard` uses analyzer findings in warning mode only during the MVP.
- Missing search evidence remains the only MVP hard-block condition.
- Tests cover at least one normalized finding from Roslyn, jscpd, and Fallow.

## Initial CLI Experiments

Already observed locally:

- Fallow on `test/sample-repo`, a C# sample, returned no useful C# analysis.
- Fallow on `services/mcp-gateway`, a TypeScript service, produced real JS/TS findings.
- jscpd can scan C# and produced JSON against the C# sample repo.
- `services/roslyn-worker` exists and already has the core Roslyn plumbing needed for C# symbol and reference analysis.

These results support the plugin model:

- Use Fallow for JS/TS.
- Use Roslyn for C#.
- Use jscpd for cross-language duplicate scanning.
- Use Codebase Brain as the unified MCP evidence and guardrail layer.

## Post-MVP Open Questions

- After MVP repo-local artifacts, should normalized findings also be persisted in Qdrant, Neo4j, or both?
- What is the minimum confidence required for delete recommendations?
- How should generated code, migrations, snapshots, and vendored code be excluded?
- Should NDepend be supported later as a commercial optional adapter?
- How should frontend framework boundaries be represented for Angular modules and React components?

## Recommended Next Build Slice

Build the smallest useful vertical path:

1. Add `AnalyzerFinding` types in `services/mcp-gateway`.
2. Add an `analyze_repository` MCP tool.
3. Implement the Fallow adapter for JS/TS.
4. Implement the jscpd adapter for C# duplicate blocks.
5. Add a Roslyn endpoint for unused private methods.
6. Store run artifacts under `.codebase-brain/runs/{job_id}/`.
7. Add `list_analysis_runs` and `cleanup_analysis_runs` with default retention and pin support.
8. Return all findings through one normalized response.

That gives Codebase Brain a visible Fallow-like health feature while proving the C# path with Roslyn and keeping local run artifacts manageable from the start.
