# Architecture

See [DESIGN.md](../DESIGN.md) for decisions and invariants. The application is a single local Node service with a separately built React browser interface. SQLite is the source of truth; SSE is a view of persisted events, not a second state store.

| Boundary              | Responsibility                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/core`            | Domain types, templates, prompt rendering, verdict validation, transition guards, execution driver, recovery |
| `src/db`              | Versioned schema migrations, typed row mapping, transactional repositories and history queries               |
| `src/adapters/agents` | Common contract, deterministic mock, vendor invocation/parsing and manual sessions                           |
| `src/adapters/shell`  | Supervised process groups, stdin, bounded output, redaction, cancellation and timeout                        |
| `src/adapters/git`    | Canonical roots, snapshots, actual diffs and typed write allowlist                                           |
| `src/adapters/tests`  | Conservative output summary parsing                                                                          |
| `src/server`          | Local HTTP protection, API validation, runtime composition and event streaming                               |
| `src/ui`              | First-run setup, dashboard, history, run rail, attempts, inspectors and approvals                            |

## Durable execution

A template is copied into a frozen run plan. Roles resolve to configured agent IDs. Each stage has a stable task; each execution creates a separate attempt, carrying a previous-attempt reference and retry reason. Guarded SQL updates prevent late completions from overwriting cancellation. State changes and their audit events commit together. One executing/waiting run owns a project root at a time.

The engine builds a complete prompt packet with goal, project, stage instructions, prior results, verification evidence, git checkpoint, artifacts, reviewer findings and stopping rule. It persists the exact rendered prompt before the adapter starts. No hidden conversational history is required to reconstruct a handoff.

Verification is injected into the core. The server implementation executes configured command arrays itself, records command output and parses only recognized summaries. No configured command means unavailable verification, not success. The test-only core seam can use explicit deterministic outcomes.

## Process supervision

Each invocation starts a small Node supervisor as a detached POSIX group leader. The target CLI is a child in that group. Output and stdin are forwarded through pipes; IPC carries the target's actual result. The supervisor remains alive until cleanup, then signals its own group. On cancellation it sends TERM, retains group ownership through a grace period, and sends KILL. On parent disconnect it performs bounded cleanup. Processes that deliberately escape the group are outside this mechanism.

The server never terminates a persisted PID. Recovery marks previously live attempts interrupted, preserving history and human gates. Retry is deliberate and creates another attempt.

## Database and events

Normalized tables cover projects, agents, templates, stages, runs, tasks, attempts, events, sessions, commands, tests, snapshots, review verdicts, artifacts and approvals. WAL, foreign keys and a busy timeout are enabled. JSON carries configuration and typed metadata; it is not the entire application state.

SSE emits monotonically increasing event IDs. A client reconnects with its last ID, deduplicates and reloads the relevant persisted aggregate. Per-connection backpressure is bounded. Event and output limits are visible. Artifact files remain in the repository; SQLite stores references and metadata.

## Deliberate boundaries

No React imports in orchestration. No vendor SDK in the engine. No desktop wrapper, background deployment service or cloud persistence. Git write policy does not sandbox external agents. The default templates are a small sequential graph with explicit review loops, not an arbitrary workflow programming language.
