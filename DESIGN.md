# AgentOps v1 architecture

AgentOps is a local process coordinator and durable audit log. It does not provide an AI API, cloud service, credential store, or implicit repository maintenance.

## Runtime and boundaries

Node 24+ TypeScript server, SQLite (`node:sqlite`), React/TypeScript/Vite browser client. One server owns one database. Bind only 127.0.0.1. Serve the built client from the same origin. SSE broadcasts persisted event IDs; reconnect replays history. No desktop wrapper: detached POSIX process groups provide the lifecycle control needed for v1. Windows process-tree cleanup is explicitly unsupported until tested.

`src/core` owns domain types, pure transition rules, prompt construction and the persisted engine. `src/db` owns versioned SQL migrations and repositories. `src/adapters/agents` implements mock, generic CLI, Codex, Claude Code, Hermes/OpenCode and manual adapters. `src/adapters/shell` owns process lifecycle and redaction; `git` owns snapshots/diffs and a typed operation policy; `tests` parses only supported output. `src/server` owns request validation, local-origin protection, API and SSE. `src/ui` renders persisted state and submits explicit actions. React never participates in orchestration decisions.

## Persisted state machine

Run: DRAFT → RUNNING → WAITING_APPROVAL | WAITING_INPUT | FAILED | INTERRUPTED | COMPLETED | CANCELLED. WAITING_APPROVAL can resume only with a recorded decision; WAITING_INPUT only with supplied input. FAILED and INTERRUPTED resume only by deliberate retry. Terminal completion/cancellation cannot restart. One nonterminal executing/waiting run per canonical project root; acquire the repository lease transactionally.

Stage: PENDING → RUNNING → COMPLETED | FAILED | WAITING_INPUT | WAITING_APPROVAL | INTERRUPTED | CANCELLED; conditional stages may become SKIPPED. Retry creates an immutable new task_attempt with monotonically increasing attempt number, reason and previous attempt reference. Never replace a failed result. A task is the stable identity of a stage; attempts are executions. State updates and their audit events share one transaction. Use guarded updates and a per-run execution mutex to prevent duplicate starts, approvals and retry races.

Sequential template stages form a small explicit graph. Review requires a validated structured verdict (APPROVE, APPROVE_WITH_FIXES, REJECT). Exit zero alone is never approval. APPROVE advances to final verification. APPROVE_WITH_FIXES schedules fix → retest → review, bounded by max review cycles. REJECT waits for a human decision; an override is recorded and cannot skip final verification. Failed verification stops progression. Final acceptance is always a human gate. Policy changes are snapshotted when a run is created.

Startup marks persisted RUNNING/WAITING_INPUT attempts INTERRUPTED and releases owned runtime handles; it never signals persisted PIDs or relaunches processes. Pending human gates remain pending. Cancellation records intent, terminates only the current owned group, awaits bounded cleanup and then records terminal state. Late completions cannot overwrite cancellation.

## Database

Versioned migrations; WAL; foreign keys; busy timeout. Separate tables: projects, agents, workflow_templates, workflow_stages, runs, run_stages, tasks, task_attempts, events, agent_sessions, shell_commands, test_runs, git_snapshots, review_verdicts, artifacts, approvals. JSON is restricted to configurations, typed result metadata and snapshot details. Events have monotonic integer IDs and actor/project/run/task/attempt/category/time/type/payload. Prompts and command provenance are stored per attempt. Index run/project/status/date and event run/id. History search combines project, goal, agent, status, date, branch and verdict.

## Adapter contract

`startTask(packet, config): AgentSession`; session exposes `sendInput(text)`, `cancel(reason)`, `getStatus()`, `streamEvents(): AsyncIterable<AgentEvent>`, `collectResult(): Promise<AgentResult>`. Events: AGENT_STARTED, AGENT_OUTPUT, AGENT_TOOL_CALL, AGENT_WAITING, AGENT_COMPLETED, AGENT_FAILED, AGENT_CANCELLED. Preserve separate redacted stdout/stderr and normalized events. Result: status, summary, exitCode, structured review when applicable, artifact references, nullable measured usage. CLI-specific parsing stays in adapters. Model and effort are optional manually configured strings. Commands use executable + argument arrays and stdin; generic CLI requires explicit configuration. Interactive-only adapters can enter an honest manual handoff state. PTY is an optional backend, never silently emulated with pipes.

Mock scenarios are deterministic: success, failure, fixes, rejection, failure-then-success, long-running, input-required, malformed-review. Automated tests never call paid AI providers.

## Prompt packets and evidence

Each handoff persists project/root, goal, constraints, stage instructions, prior attempt/stage results, latest git checkpoint, verification results, artifacts and stopping rule. Revision history is inspectable. Persist the exact redacted prompt that is sent (reject obvious embedded credentials). Before/after stage checkpoints capture HEAD, branch, status, staged/unstaged/untracked paths, diff statistics, local commits and remote divergence when available. No repository copies. Diff commands disable external diff/textconv and use argument arrays.

Test/build commands are explicit executable/args arrays from project configuration, not concatenated shell strings. Store actual exit status, stdout/stderr and only confidently parsed counts. Artifacts reference canonical paths inside the registered repository, record creator/stage/type/existence and never put large payloads in SQLite.

## Security and process ownership

Localhost only is not sufficient: validate Host and Origin on every request, require a same-origin anti-CSRF token for writes, reject cross-origin preflights, bound bodies and SSE backpressure. Canonicalize real project roots and reject traversal/symlink escapes for file access. Do not expose a general filesystem reader. Redact obvious secrets before storage and display; cap process output and event retention per execution and report truncation. Inherit credentials without logging environment or storing keys. Generic commands and agents execute with the user's OS privileges; workflow git policy governs AgentOps-issued operations, not a security sandbox around third-party agents. Explicitly disclose this boundary.

Git reads may run automatically. Typed git writes require snapshotted workflow allowlists. Force push, hard reset and branch deletion additionally require a scoped one-use human approval. No arbitrary git command endpoint. V1 may expose only safe branch/commit operations and reject unsupported dangerous writes. Never clean/reset/stash implicitly.

Only freshly created runtime handles may be signalled. Spawn detached process groups on POSIX; SIGTERM then SIGKILL with deadlines; cancellation and timeout resolve once. Handle ENOENT, stdin closure, unexpected exit and bounded output. Database/disk failures stop progression and surface an explicit service error.

## Product surface

First-run flow: register and validate repo → configure verification commands → configure roles/adapters → select a seeded workflow → enter goal → inspect stage plan → start. Dashboard shows active, waiting/failed, recent runs, projects and agents. Run view has compact branched stages, selected attempt prompt/output/results, git/test/review/artifact inspector, event filters and streaming log drawer. Approval decisions support next-instruction edits; retries remain visible. Search is persisted history, not synthetic cards.

## Acceptance gates

1. Core/schema/mock: transition, retry, review loop, approval and restoration tests.
2. Git/projects/verification: disposable repository tests and architecture review by Claude.
3. API/UI/SSE: real persisted data, first-run flow and browser/UI tests.
4. Real adapters/process control: local CLI help verification, process/security review by Claude.
5. Review/fix/gates: race and negative-path tests.
6. Dogfood: deterministic fixture workflow plus attempted real worker/reviewer run if available; retain evidence and distinguish actual from simulated changes.
7. Documentation/screenshot, final Claude review, clean build/tests, then GitHub publication. No license is chosen without explicit approval.

Agents never concurrently edit the same files. DeepSeek owns implementation assignments; Astra owns architecture/integration decisions; Claude receives read-only review assignments.
