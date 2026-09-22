# Workflows

A workflow is a persisted stage plan, role mapping, verification-command snapshot and policy snapshot. Creating a draft launches nothing. Start is explicit. Only one executing or waiting run may hold a repository at once.

The built-in templates cover implementation/review, bug fixing, research/experimentation and documentation cleanup. Their review stages share this branch:

```text
task → verification → review
                       ├ APPROVE ─────────────→ final verification → human acceptance
                       ├ APPROVE_WITH_FIXES → fix → retest → review
                       └ REJECT ──────────────→ human decision
```

Review loops have a bounded cycle count. Exhausting the bound opens an explicit decision instead of creating an infinite chain. A rejected or malformed review never turns into approval simply because its process exited successfully. Review rejection overrides are audit events and cannot bypass final verification or human acceptance.

## State and attempts

Runs move through DRAFT, RUNNING, WAITING_INPUT, WAITING_APPROVAL, FAILED, INTERRUPTED, COMPLETED or CANCELLED. A stage also has PENDING and SKIPPED states. COMPLETED and CANCELLED runs are terminal. Failures and interruptions require deliberate retry, with a reason. Retry creates a new attempt with a link to the old one; the previous prompt, output and result remain inspectable.

The exact prompt sent to an agent includes the original goal, project path, stage task, constraints, prior results, test evidence, git checkpoint, artifacts, review findings and stopping rule. Additional input and approval instructions are saved. The interface can show prompts side by side across attempts.

## Verification

Project commands have a name, executable and argument array. For example:

```json
{ "name": "test", "executable": "npm", "args": ["test"] }
```

There is no shell-string expansion. Package scripts still execute arbitrary trusted project code, so configure them deliberately. Node TAP/spec and common Jest/Vitest summaries are recognized conservatively. When parsing is uncertain, the interface shows the observed exit status and raw captured output; test counts remain UNKNOWN. A failed command stops the run. Commands are frozen in the run policy, so editing project settings affects newly created runs.

## Human decisions

The run view displays **WAITING FOR YOU** and the decisions allowed for that specific gate. Final acceptance offers approve/reject. Review rejection and cycle-exhaustion gates may offer a documented override or retry with an edited next instruction. Decisions are single-use and guarded transactionally against duplicate clicks.

Manual adapters also wait visibly. Copy the exact saved prompt into the interactive CLI, then paste its final result. A manual reviewer must supply the same structured JSON verdict as an automated one. Manual output is attributed to an operator-supplied handoff, not a fabricated process execution.

## Restart and history

Restart never relaunches a CLI. Previously live attempts are marked interrupted and remain visible. Pending human approvals are restored. Inspect the repository before retrying. Historical git checkpoints capture metadata; the diff inspector explicitly shows the current repository diff, not a reconstructed historical patch. Remote divergence uses existing local remote-tracking refs and does not fetch the remote automatically.

History filters include project, goal, agent, status, dates, branch and verdict. SSE reconnects replay persisted event IDs. Logs and event buffers are bounded with visible truncation; the event API supports cursor-based history retrieval. Artifact files remain on disk and can become unavailable if moved or deleted.
