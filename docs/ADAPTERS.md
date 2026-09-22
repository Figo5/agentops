# Agent adapters

The core depends only on `AgentAdapter` and `AgentSession` in `src/core/types.ts`. It never imports vendor SDKs. A task receives a complete, persisted prompt packet; the adapter returns normalized events and a result while preserving redacted stdout/stderr separately.

| Adapter         | Execution                                          | Notes                                                                               |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mock            | In-process deterministic session                   | CI and explicit simulations; no AI calls                                            |
| Generic CLI     | Executable, argument array, prompt on stdin        | Explicit configuration; never shell interpolation                                   |
| Codex           | `codex exec --json`                                | Model/effort supplied only when configured; JSONL events                            |
| Claude Code     | `claude -p --output-format stream-json --verbose`  | Structured result extraction; review tools limited to reading                       |
| Hermes/OpenCode | `hermes --provider … --model … --reasoning … -z …` | Provider is configurable; one-shot approval bypass requires explicit acknowledgment |
| Manual mode     | Persisted handoff and user-supplied result         | Honest fallback for interactive-only setups; no fake process                        |

The API is `startTask(packet, config)` → session with `sendInput`, `cancel`, `getStatus`, `streamEvents` and `collectResult`. Output events include AGENT_STARTED, AGENT_OUTPUT, AGENT_TOOL_CALL, AGENT_WAITING, AGENT_COMPLETED, AGENT_FAILED and AGENT_CANCELLED. Vendor events need not map one-to-one.

Model names are manually configured strings. Display names and roles are independent of adapters. AgentOps does not assume it can query model access. Executable-not-found and nonzero exits fail explicitly. Provider errors are preserved after redaction. Usage remains UNKNOWN unless a supported structured stream supplies values; estimated costs are not recorded as measured.

Reviewer final output must be a JSON object:

```json
{
  "verdict": "APPROVE_WITH_FIXES",
  "summary": "Add a blank-input regression test.",
  "issues": [
    {
      "severity": "major",
      "description": "Whitespace-only input is accepted.",
      "path": "greeting.mjs"
    }
  ]
}
```

Other verdicts are APPROVE and REJECT. A fenced JSON final answer is accepted. General prose saying “looks good” is not approval. Generic workers can return plain text or `{ "summary": "…", "artifacts": [{ "path": "report.md", "kind": "markdown" }] }`.

Pipes are supported. A PTY is deliberately not silently substituted: CLIs that require terminal interaction should use manual mode. Manual review results require the same JSON verdict. A manual worker may explicitly submit `{ "status": "failed", "summary": "…", "error": "…" }` or a cancelled status; these are preserved as failures/cancellations. Unsupported result statuses are rejected without closing the input gate. Input history is persisted. Keep credentials in the CLI's existing credential store/environment, never in agent configuration.

Hermes one-shot mode exposes its final answer through stdout, but does not reliably stream its internal tool calls. AgentOps records the invocation, available output, result, verification and git effects; it does not reconstruct unseen commands from the agent's prose. Codex and Claude emit structured events when supported by their installed versions. Adapter availability reports executable installation, not provider authentication or model entitlement.
