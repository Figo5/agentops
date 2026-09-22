# Final acceptance — 2026-09-22

**Reviewer: Astra. Verdict: APPROVE for local-first v1 publication, within the documented boundaries.**

The user explicitly authorized Astra to perform the final acceptance gate after Claude Code reached its session limit. Claude's attempted final product review produced no verdict. Earlier Claude process/security and architecture findings were addressed and regression-tested; Claude also completed the real fixture's code review with APPROVE.

## Evidence examined

- Persisted transitions, immutable attempts, guarded updates, per-project lease, rejection overrides and mandatory final verification.
- Restart behavior preserving human gates while interrupting abandoned live execution; verified both in tests and on the real running service.
- Owned process supervisor, timeout/cancellation and TERM-resistant descendant cleanup; no stored PID termination.
- Host/Origin/action-token checks, bounded output, redacted structured audit records, canonical project/artifact containment, and read-only git policy.
- CLI invocation, manual handoff and structured verdict extraction; explicit UNKNOWN usage and unavailable model-access status.
- Actual browser views at desktop and mobile sizes, live SSE updates, retry history, prompt inspection and approval controls.
- Real disposable-repository workflow: DeepSeek changed two files, independent verification passed seven tests, Claude approved, final verification passed seven tests, and the human acceptance gate stayed pending across restart.

Final adapter corrections preserve explicit failed/cancelled manual results instead of treating all submissions as completion, reject unsupported result statuses while keeping input open, and restrict Claude planner tools to the same read-only set as reviewer tools. Regression coverage verifies these cases.

## Acceptance checks

- 206 automated tests passed; no failed, skipped or cancelled tests.
- 2 Chromium end-to-end tests passed.
- Server/core and frontend TypeScript checks passed.
- Production Vite build and formatting checks passed.
- Source inventory excludes local databases, CLI logs, credentials, runtime files and generated build output.
- Screenshots were captured from the real service and visually inspected.

The successful dogfood task remains WAITING FOR HUMAN ACCEPTANCE; product release acceptance does not impersonate the operator's decision on that run. GitHub-hosted CI is configured and its execution is a separate platform check after publication.

## Accepted limitations

POSIX/macOS/Linux operation; pipe-compatible CLI automation with manual fallback; no remote access, cloud persistence, accounts, arbitrary DAG editor, PTY automation or Windows process-tree guarantee. Shipped workflow git writes are disabled, and destructive operations/deployments are unsupported. AgentOps is not an OS sandbox and cannot see internal tool calls a CLI does not emit. Redaction is best effort, checkpoints are metadata, provider availability is external, and no paid Codex task was tested. No license was selected without permission.
