/**
 * Selected task detail: the attempts of one stage with their exact prompt,
 * previous-prompt comparison, streamed output, commands, verification, review
 * verdict and artifact references.
 *
 * Attempts are rendered separately and never collapsed: a retry adds a new
 * immutable attempt with its own reason, and the failed one stays visible.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AttemptRecord, StageRecord } from "../../core/types.js";
import type { RunDetailResponse } from "../api.js";
import {
  artifactView,
  attemptCountsView,
  commandLine,
  diffLines,
  eventMessage,
  filterEvents,
  fixLoopCycleLabel,
  formatClock,
  formatDuration,
  formatTimestamp,
  issueDisposition,
  issueDispositionLabel,
  promptComparisons,
  relativeTime,
  reviewerIdentity,
  reviewCycleView,
  statusLabel,
  testCountsLabel,
  text,
  usageView,
  verdictOutcomeLabel,
  verdictTone,
  verificationCountsLabel,
  verificationLabel,
} from "../view-model.js";
import {
  Card,
  CodeBlock,
  CopyButton,
  DiffView,
  Disclosure,
  KeyValue,
  Notice,
  Pill,
  StatusPill,
  TabPanel,
  Tabs,
} from "./Bits.js";

function duration(attempt: AttemptRecord): string {
  if (!attempt.startedAt || !attempt.endedAt) return "UNKNOWN";
  const ms =
    new Date(attempt.endedAt).getTime() - new Date(attempt.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "UNKNOWN";
}

const ATTEMPT_TABS_ID = "attempt-sections";

/**
 * Panel wrapper for one attempt section.
 *
 * The panel element always exists so every tab's `aria-controls` resolves while
 * only the selected section's body is rendered (the output pane can hold
 * thousands of log lines, so hidden panels must not cost DOM).
 */
function Panel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: ReactNode;
}) {
  const selected = active === id;
  return (
    <TabPanel idBase={ATTEMPT_TABS_ID} id={id} selected={selected}>
      {selected ? children : null}
    </TabPanel>
  );
}

function AttemptTabs({
  detail,
  attempt,
}: {
  detail: RunDetailResponse;
  attempt: AttemptRecord;
}) {
  const [tab, setTab] = useState("prompt");
  const events = useMemo(
    () => filterEvents(detail.events, { attempts: [attempt.id] }),
    [detail.events, attempt.id],
  );
  const commands = useMemo(
    () => detail.commands.filter((command) => command.attemptId === attempt.id),
    [detail.commands, attempt.id],
  );
  const tests = useMemo(
    () => detail.tests.filter((test) => test.attemptId === attempt.id),
    [detail.tests, attempt.id],
  );
  const verdicts = useMemo(
    () =>
      detail.reviewVerdicts.filter(
        (verdict) => verdict.attemptId === attempt.id,
      ),
    [detail.reviewVerdicts, attempt.id],
  );
  const artifacts = useMemo(
    () =>
      detail.artifacts.filter((artifact) => artifact.attemptId === attempt.id),
    [detail.artifacts, attempt.id],
  );
  const comparison = useMemo(
    () =>
      promptComparisons(detail.attempts).find(
        (entry) => entry.attemptId === attempt.id,
      ) ?? null,
    [detail.attempts, attempt.id],
  );
  const usage = usageView(attempt.usage, attempt.usageKnown);
  // Counts come from the attempt's own verification record, or from the
  // normalized test runs recorded for this attempt when the record has none.
  const counts = attemptCountsView({
    attemptId: attempt.id,
    verification: attempt.verification,
    tests,
  });

  return (
    <div>
      <Tabs
        idBase={ATTEMPT_TABS_ID}
        label={`Attempt ${attempt.attemptNumber} sections`}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "prompt", label: "Prompt" },
          { id: "output", label: "Output", count: events.length },
          { id: "commands", label: "Commands", count: commands.length },
          { id: "verification", label: "Verification", count: tests.length },
          { id: "review", label: "Review", count: verdicts.length },
          { id: "artifacts", label: "Artifacts", count: artifacts.length },
          { id: "usage", label: "Usage" },
        ]}
      />

      <Panel id="prompt" active={tab}>
        <div className="stack">
          <div className="row row--between">
            <span className="faint small">
              Exact prompt persisted for attempt #{attempt.attemptNumber}{" "}
              (redacted before storage by the server).
            </span>
            <CopyButton
              text={attempt.promptText ?? ""}
              label="Copy exact prompt"
            />
          </div>
          <CodeBlock
            text={attempt.promptText}
            tall
            emptyLabel="No prompt text was persisted for this attempt."
          />
          {comparison ? (
            <div className="stack--tight">
              <h4>
                Revision vs attempt #{comparison.previousAttemptNumber ?? "?"}
              </h4>
              <p className="faint small">
                {comparison.changed
                  ? `${comparison.addedLines} added / ${comparison.removedLines} removed line(s) compared with the previous attempt of this task.`
                  : "Identical to the previous attempt prompt for this task."}
              </p>
              {comparison.previousPrompt !== null &&
              comparison.currentPrompt !== null ? (
                <Disclosure summary="Show the line diff">
                  <DiffView
                    lines={diffLines(
                      comparison.previousPrompt,
                      comparison.currentPrompt,
                    )}
                  />
                </Disclosure>
              ) : (
                <p className="faint small">
                  One side of the comparison was not persisted, so no diff can
                  be shown.
                </p>
              )}
              <Disclosure summary="Show the previous prompt verbatim">
                <CodeBlock
                  text={comparison.previousPrompt}
                  emptyLabel="Previous prompt not persisted."
                />
              </Disclosure>
            </div>
          ) : (
            <p className="faint small">
              This is the first attempt of this task; there is no earlier prompt
              to compare.
            </p>
          )}
          {attempt.promptPacket ? (
            <Disclosure summary="Show the structured prompt packet (JSON)">
              <CodeBlock text={JSON.stringify(attempt.promptPacket, null, 2)} />
            </Disclosure>
          ) : (
            <p className="faint small">
              No structured packet was persisted for this attempt.
            </p>
          )}
          {attempt.inputs.length > 0 ? (
            <div className="stack--tight">
              <h4>Operator inputs supplied to this attempt</h4>
              {attempt.inputs.map((input, index) => (
                <CodeBlock
                  key={index}
                  text={input}
                  label={`input ${index + 1}`}
                />
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel id="output" active={tab}>
        <div className="stack">
          <KeyValue
            rows={[
              [
                "Result status",
                <Pill
                  tone={
                    attempt.resultStatus === "completed"
                      ? "success"
                      : attempt.resultStatus
                        ? "warn"
                        : "muted"
                  }
                >
                  {text(attempt.resultStatus, "not recorded")}
                </Pill>,
              ],
              [
                "Exit code",
                attempt.exitCode === null
                  ? "UNKNOWN"
                  : String(attempt.exitCode),
              ],
              ["Summary", attempt.resultSummary ?? "none recorded"],
              [
                "Error",
                attempt.error ? (
                  <span className="field__error wrap-anywhere">
                    {attempt.error}
                  </span>
                ) : (
                  "none"
                ),
              ],
            ]}
          />
          {events.length === 0 ? (
            <p className="faint small">
              No events were persisted for this attempt.
            </p>
          ) : (
            <div className="terminal terminal--tall">
              {events.map((event) => (
                <div key={event.id} className="terminal__line">
                  <span className="terminal__time">
                    {formatClock(event.createdAt)}
                  </span>
                  <span className="terminal__actor">{event.actor}</span>
                  <span className="wrap-anywhere">
                    <span className="faint">{event.type}</span>{" "}
                    {eventMessage(event)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="faint small">
            Output is the persisted event stream for this attempt. Truncated
            output is flagged by the server on the command records.
          </p>
        </div>
      </Panel>

      <Panel id="commands" active={tab}>
        <div className="stack">
          {commands.length === 0 ? (
            <p className="faint small">
              No shell commands were recorded for this attempt.
            </p>
          ) : (
            commands.map((command) => (
              <div className="attempt" key={command.id}>
                <div className="row row--between">
                  <b className="mono">{commandLine(command)}</b>
                  <div className="row row--tight">
                    {command.truncated ? (
                      <Pill tone="warn">truncated</Pill>
                    ) : null}
                    <StatusPill status={command.status} />
                    <Pill tone="muted" dot={false}>
                      exit{" "}
                      {command.exitCode === null ? "UNKNOWN" : command.exitCode}
                    </Pill>
                    <Pill tone="muted" dot={false}>
                      {formatDuration(command.durationMs)}
                    </Pill>
                  </div>
                </div>
                <div className="faint small mono wrap-anywhere">
                  cwd {text(command.cwd, "inherited")} · stage{" "}
                  {command.stageKey} · {formatTimestamp(command.createdAt)}
                </div>
                {command.stdoutExcerpt ? (
                  <CodeBlock text={command.stdoutExcerpt} label="stdout" />
                ) : null}
                {command.stderrExcerpt ? (
                  <CodeBlock text={command.stderrExcerpt} label="stderr" />
                ) : null}
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel id="verification" active={tab}>
        <div className="stack">
          {attempt.verification ? (
            <>
              <KeyValue
                rows={[
                  [
                    "Outcome",
                    <Pill
                      tone={
                        attempt.verification.status === "passed"
                          ? "success"
                          : attempt.verification.status === "failed"
                            ? "danger"
                            : "warn"
                      }
                    >
                      {attempt.verification.status}
                    </Pill>,
                  ],
                  ["Mode", attempt.verification.mode],
                  ["Commands", String(attempt.verification.commandCount)],
                  [
                    "Counts",
                    <span className="wrap-anywhere">
                      {verificationCountsLabel(counts.counts)}
                      {counts.source === "normalized test run"
                        ? ` (from the normalized test run${counts.framework ? ` ${counts.framework}` : ""})`
                        : ""}
                    </span>,
                  ],
                  ["Summary", attempt.verification.summary],
                  ["Reason", attempt.verification.reason ?? "none"],
                ]}
              />
              <p className="faint small">
                {verificationLabel({
                  ...attempt.verification,
                  counts: counts.counts,
                })}
              </p>
            </>
          ) : (
            <p className="faint small">
              This attempt recorded no verification outcome.
            </p>
          )}
          {tests.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Framework</th>
                  <th scope="col">Status</th>
                  <th scope="col">Counts</th>
                  <th scope="col">Duration</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => (
                  <tr key={test.id}>
                    <td className="mono">{test.framework}</td>
                    <td>
                      <StatusPill status={test.status} />
                    </td>
                    <td>
                      <span className="wrap-anywhere">
                        {testCountsLabel(test)}
                      </span>
                    </td>
                    <td>{formatDuration(test.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </Panel>

      <Panel id="review" active={tab}>
        <div className="stack">
          {verdicts.length === 0 ? (
            <p className="faint small">
              No review verdict was recorded for this attempt.
            </p>
          ) : (
            verdicts.map((verdict) => (
              <div className="attempt" key={verdict.id}>
                <div className="row row--between">
                  <Pill tone={verdictTone(verdict.verdict)}>
                    {verdictOutcomeLabel(verdict.verdict, verdict.valid)}
                  </Pill>
                  <span className="faint small">
                    review cycle {verdict.cycle} · reviewer{" "}
                    <b className="wrap-anywhere">
                      {
                        reviewerIdentity({
                          reviewer: verdict.reviewer,
                          attemptId: verdict.attemptId,
                          attempts: detail.attempts,
                          agents: detail.agents,
                        }).name
                      }
                    </b>{" "}
                    · {formatTimestamp(verdict.createdAt)}
                  </span>
                </div>
                {!verdict.valid ? (
                  <Notice tone="warn">
                    The payload failed validation. Validation errors:{" "}
                    {verdict.validationErrors.join("; ") || "none reported"}
                  </Notice>
                ) : null}
                {verdict.summary ? (
                  <p>{verdict.summary}</p>
                ) : (
                  <p className="faint small">No summary recorded.</p>
                )}
                {verdict.issues.length > 0 ? (
                  <ul
                    className="evidence-issues"
                    style={{ margin: 0, paddingLeft: 0 }}
                  >
                    {verdict.issues.map((issue, index) => {
                      const disposition = issueDisposition(issue.severity);
                      return (
                        <li key={index} className="evidence-issue">
                          <div className="evidence-issue__head">
                            <Pill
                              tone={
                                disposition === "blocker" ? "danger" : "muted"
                              }
                              dot={false}
                            >
                              {issueDispositionLabel(disposition)}
                            </Pill>
                            <span className="faint small">
                              reviewed severity: {issue.severity}
                              {issue.path
                                ? ` · ${issue.path}${issue.line ? `:${issue.line}` : ""}`
                                : ""}
                            </span>
                          </div>
                          <span className="evidence-issue__body">
                            {issue.description}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="faint small">No issues listed.</p>
                )}
                {verdict.confidence === null ? (
                  <p className="faint small">Confidence UNKNOWN.</p>
                ) : (
                  <p className="faint small">Confidence {verdict.confidence}</p>
                )}
                <Disclosure summary="Show the raw review payload">
                  <CodeBlock text={verdict.raw} />
                </Disclosure>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel id="artifacts" active={tab}>
        <div className="stack">
          {attempt.artifacts.length === 0 && artifacts.length === 0 ? (
            <p className="faint small">This attempt references no artifacts.</p>
          ) : null}
          {attempt.artifacts.map((artifact) => (
            <div className="attempt" key={`ref-${artifact.path}`}>
              <b className="mono wrap-anywhere">{artifact.path}</b>
              <div className="faint small">
                kind {artifact.kind}
                {artifact.note ? ` · ${artifact.note}` : ""}
              </div>
            </div>
          ))}
          {artifacts.map((artifact) => {
            const view = artifactView(artifact);
            return (
              <div className="attempt" key={artifact.id}>
                <div className="row row--between">
                  <b className="mono wrap-anywhere">{artifact.path}</b>
                  <Pill tone={artifact.exists ? "success" : "danger"}>
                    {view.exists}
                  </Pill>
                </div>
                <div className="faint small">
                  kind {artifact.kind} · creator {artifact.creator} · size{" "}
                  {view.size} · {formatTimestamp(artifact.createdAt)} (
                  {relativeTime(artifact.createdAt)})
                </div>
              </div>
            );
          })}
          <p className="faint small">
            Artifacts are references to canonical paths inside the registered
            repository. Payloads are never copied into the database.
          </p>
        </div>
      </Panel>

      <Panel id="usage" active={tab}>
        <div className="stack">
          {!usage.known ? (
            <Notice tone="warn">
              Usage is UNKNOWN for this attempt. Unknown is not zero.
            </Notice>
          ) : null}
          <KeyValue
            rows={[
              ["Input tokens", usage.input],
              ["Output tokens", usage.output],
              ["Total tokens", usage.total],
              ["Cost", usage.cost],
              ["Model", usage.model],
              ["Agent", attempt.agentId ?? "none"],
              ["Adapter", attempt.adapterKind ?? "none"],
              ["Session", attempt.agentSessionId ?? "none"],
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}

export function AttemptDetail({
  detail,
  stage,
  selectedAttemptId,
  onSelectAttempt,
}: {
  detail: RunDetailResponse;
  stage: StageRecord | null;
  selectedAttemptId: string | null;
  onSelectAttempt: (attemptId: string) => void;
}) {
  const attempts = useMemo(
    () =>
      detail.attempts
        .filter((attempt) => (stage ? attempt.stageKey === stage.key : true))
        .sort((a, b) => a.attemptNumber - b.attemptNumber),
    [detail.attempts, stage],
  );
  const selected =
    attempts.find((attempt) => attempt.id === selectedAttemptId) ??
    attempts[attempts.length - 1] ??
    null;

  if (!stage) {
    return (
      <Card title="Task detail">
        <p className="faint small">
          Select a stage on the rail to inspect its attempts.
        </p>
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card
        title={
          <>
            {stage.name} <Pill tone="muted">{stage.kind}</Pill>
          </>
        }
        actions={
          <div className="row row--tight">
            <StatusPill status={stage.status} />
            {stage.overridden ? <Pill tone="warn">overridden</Pill> : null}
          </div>
        }
        hint={stage.instructions}
      >
        <KeyValue
          rows={[
            ["Stage key", <span className="mono">{stage.key}</span>],
            ["Role", stage.role],
            [
              "Agent",
              detail.agents.find((agent) => agent.id === stage.agentId)?.name ??
                stage.agentId ??
                "not assigned",
            ],
            [
              "Cycle",
              stage.loop
                ? `${fixLoopCycleLabel(stage.cycle, stage.loop.maxReviewCycles)} (${stage.loop.phase})`
                : stage.kind === "review"
                  ? reviewCycleView({
                      reviewCycle: stage.cycle,
                      policy: detail.run.policy,
                    }).label
                  : String(stage.cycle),
            ],
            ["Attempts", String(stage.attemptCount)],
            [
              "Depends on",
              stage.dependsOn.length > 0
                ? stage.dependsOn.join(", ")
                : "nothing",
            ],
            ["Started", formatTimestamp(stage.startedAt)],
            ["Ended", formatTimestamp(stage.endedAt)],
            ["Summary", stage.summary ?? "none recorded"],
            [
              "Failure",
              stage.failureReason ? (
                <span className="field__error">{stage.failureReason}</span>
              ) : (
                "none"
              ),
            ],
            ["Skip reason", stage.skipReason ?? "not skipped"],
          ]}
        />
      </Card>

      <Card
        title={`Attempts (${attempts.length})`}
        hint="Attempts are immutable executions. A retry adds one; it never replaces a failed result."
      >
        {attempts.length === 0 ? (
          <p className="faint small">This stage has not been executed yet.</p>
        ) : (
          <div className="stack--tight">
            {attempts.map((attempt) => (
              <button
                key={attempt.id}
                type="button"
                className="attempt"
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  width: "100%",
                  font: "inherit",
                  color: "inherit",
                }}
                aria-current={selected?.id === attempt.id ? "true" : undefined}
                onClick={() => onSelectAttempt(attempt.id)}
              >
                <span className="attempt__head">
                  <span className="attempt__num">#{attempt.attemptNumber}</span>
                  <StatusPill status={attempt.status} />
                  <Pill tone="muted" dot={false}>
                    {attempt.kind}
                  </Pill>
                  <Pill tone="muted" dot={false}>
                    {formatDuration(
                      attempt.endedAt && attempt.startedAt
                        ? new Date(attempt.endedAt).getTime() -
                            new Date(attempt.startedAt).getTime()
                        : null,
                    )}
                  </Pill>
                  {attempt.agentId ? (
                    <span className="faint small">
                      {detail.agents.find(
                        (agent) => agent.id === attempt.agentId,
                      )?.name ?? attempt.agentId}
                    </span>
                  ) : null}
                </span>
                <span className="faint small">
                  {attempt.reason
                    ? `reason: ${attempt.reason}`
                    : "reason: not recorded"}
                  {attempt.previousAttemptId
                    ? " · supersedes a previous attempt"
                    : ""}
                  {` · started ${formatTimestamp(attempt.startedAt)}`}
                </span>
                {attempt.error ? (
                  <span className="field__error">{attempt.error}</span>
                ) : null}
                {attempt.resultSummary ? (
                  <span className="faint small">{attempt.resultSummary}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Card>

      {selected ? (
        <Card
          title={`Attempt #${selected.attemptNumber} · ${statusLabel(selected.status)}`}
          hint={`Duration ${duration(selected)} · started ${formatTimestamp(selected.startedAt)} · ended ${formatTimestamp(selected.endedAt)}`}
        >
          <AttemptTabs detail={detail} attempt={selected} />
        </Card>
      ) : (
        <Card title="No attempt yet">
          <p className="faint small">
            The stage exists but no attempt has been recorded for it.
          </p>
        </Card>
      )}
    </div>
  );
}
