# Process/security gate — 2026-09-22

Reviewer: Claude Opus 5 via Claude Code, high effort, read-only tools. Initial verdict: **APPROVE_WITH_FIXES**.

Changes made in response:

- Replaced service-side numeric process-group signalling with a persistent supervisor. The supervisor is the group leader and signals its own current group; it remains alive while TERM-resistant descendants are cleaned up. This also removes the late-close escalation race.
- Git output truncation now makes the checkpoint/diff unavailable instead of presenting a partial result as complete.
- Command provenance arguments are redacted. Token-header comparison checks byte lengths, and same-site cross-origin browser requests are rejected.
- Lock acquisition and stale-owner reclamation are serialized through a separate acquisition guard. A crash during acquisition can require manual guard inspection; normal backend restart reclaims a dead owner.
- Event queue overflow emits an explicit truncation marker. Streams have one consumer.
- Artifact references are relativized against the same canonical root used for containment.
- AgentOps commits disable hooks and signing; this is disclosed in the git-write event and security documentation. Writes remain unavailable under the default read-only workflow policy.

The reviewer questioned Claude CLI option support. Local primary evidence resolved that finding: **Claude Code 2.1.221** `--help` lists `--tools`, `--effort` and `--permission-mode dontAsk`. The reviewer adapter retains those flags and has a regression assertion for its read-only tool list. Codex **0.155.1** and Hermes **0.21.1** help were also inspected. No provider configuration or CLI installation was changed.

HTTP validation errors already map to 400 in the implemented server, so the suggested 500-to-400 correction was not applicable. Final acceptance will review the integrated result again.
