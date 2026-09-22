# Security model

AgentOps runs trusted local programs with your user account. It is a coordinator, not a sandbox. Register only repositories and configure only commands you trust. A package's test/build script can itself execute arbitrary code. A third-party agent may modify files or call git outside AgentOps; its CLI permissions remain the enforcement boundary for those actions.

The server binds to `127.0.0.1`. There is no remote mode, account system or hosted database. Exact Host/Origin validation, cross-site rejection and a per-server random action token protect against browser-driven requests and DNS rebinding. Do not expose the server through a tunnel or reverse proxy. Another process running as your OS user can access local data and is outside this threat model.

Projects use canonical filesystem roots. Artifact access validates real paths and rejects traversal and symlink escape. Git reads disable external diff, text conversion, hooks and filesystem monitor integration. Write operations have typed arguments and a workflow allowlist. Dangerous git writes are not implemented; unsupported operations are rejected. No implicit reset, clean, stash or checkout occurs.

Commands use executable and argument arrays with `shell: false`; direct shell interpreters are rejected. This prevents accidental shell expansion, not malicious configured executables. Credentials are inherited from local CLI environments and are never copied into AgentOps configuration. Do not put credentials in prompts or argument arrays.

Common API tokens, authorization values, passwords and credential-bearing URLs are redacted before output storage. Redaction is best effort, not a universal data-loss prevention system. Output is bounded; truncation is explicitly recorded. Unbounded unterminated output lines are omitted. Raw logs means redacted process output, not unfiltered secrets. AgentOps does not print environment variables wholesale.

Process handles are kept only in memory. Cancellation signals the POSIX process group created by that handle, first TERM and then KILL with a bounded deadline. Stored PIDs are never used for termination. Processes that deliberately escape their process group cannot be contained by this mechanism. Windows process-tree lifecycle is not supported in this release.

On restart, live attempts become interrupted. AgentOps does not relaunch them or assume their children survived. Inspect the repository and deliberately retry. A database lock prevents multiple local service instances from driving the same store; state changes also have transactional guards.

Approvals record actor, time, gate, decision and optional instruction. Review approval requires a structured verdict; exit code zero alone cannot authorize progression. Final human acceptance is separate from test success. Review rejection overrides remain visible. Tests that fail stop progression.

Hermes one-shot mode bypasses its own interactive approvals according to the installed CLI help. The adapter requires an explicit `allowHermesOneshot` setting; otherwise use manual mode. Codex uses its configured workspace/read-only sandbox. Claude review sessions expose only read tools. Permission behavior may vary with CLI versions; inspect configuration before running real agents.

No telemetry is added by AgentOps. Invoked AI CLIs may send prompts and repository context to their configured providers. “Local-first” describes AgentOps persistence and orchestration, not offline AI inference.

AgentOps-issued commits intentionally disable repository hooks and commit signing so they cannot start hidden hook code or signing prompts. Git-write audit events record this behavior. Default workflow policy is read-only. A stale acquisition guard (`server.lock.guard`) left by a crash during startup requires inspection/removal after verifying no server is acquiring the database; it is not blindly reclaimed.
