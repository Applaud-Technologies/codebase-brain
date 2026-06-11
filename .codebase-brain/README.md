# Codebase Brain Local Artifacts

This directory is reserved for local Codebase Brain analysis artifacts.

Generated analysis runs should be written under:

```text
.codebase-brain/runs/{job_id}/
```

Suggested run artifacts:

- `result.json`: canonical agent-readable findings and metadata.
- `report.md`: human-readable health report generated from the same findings.

The `runs/` directory is intentionally ignored by git. Keep generated analysis output local unless a specific report should be copied into documentation or a PR comment.

Default retention policy:

- Keep the latest 25 completed runs.
- Delete completed runs older than 30 days.
- Delete failed, canceled, or timed-out runs older than 7 days.
- Never delete pinned runs.
- Never delete active runs.

Cleanup should be available from the dashboard and from MCP/CLI commands, with a dry-run mode for review before deletion.
