/**
 * Run view: stage rail + selected task detail + inspector + log drawer, with the
 * action bar that owns every human decision.
 *
 * The engine drives execution; this view only submits explicit actions:
 * start, retry (with a mandatory reason), cancel (with a mandatory reason),
 * approval decisions limited to `pendingApproval.allowed`, and operator input.
 * The next instruction a human types is retained across refreshes until it is
 * submitted or cleared.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApprovalDecision,
  EventRecord,
  StageRecord,
} from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction, useRunDetail } from "../hooks.js";
import {
  approvalDecisionOptions,
  approvalEvidenceView,
  approvalGateLabel,
  buildStageRail,
  eventsForRun,
  formatTimestamp,
  isTerminalRun,
  mergeEvents,
  pendingInputQuestion,
  relativeTime,
  reviewCycleView,
  statusLabel,
  text,
  validateCancelReason,
  validateDecision,
  validateRetryForm,
} from "../view-model.js";
import { ApprovalPanel } from "./ApprovalPanel.js";
import { AttemptDetail } from "./AttemptDetail.js";
import {
  Button,
  Card,
  ClampedText,
  ErrorBox,
  Field,
  Loading,
  Notice,
  StatusPill,
  TextArea,
} from "./Bits.js";
import { Inspector } from "./Inspector.js";
import { LogsDrawer } from "./LogsDrawer.js";
import { StageRail } from "./StageRail.js";

function pickInitialStage(
  stages: readonly StageRecord[],
  nextStageKey: string | null,
): string | null {
  if (nextStageKey) {
    const match = stages.find((stage) => stage.key === nextStageKey);
    if (match) return match.key;
  }
  const running = stages.find((stage) => stage.status === "RUNNING");
  if (running) return running.key;
  const waiting = stages.find(
    (stage) =>
      stage.status === "WAITING_APPROVAL" || stage.status === "WAITING_INPUT",
  );
  if (waiting) return waiting.key;
  const lastTouched = [...stages]
    .filter((stage) => stage.endedAt)
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  return lastTouched?.key ?? stages[0]?.key ?? null;
}

export function RunView({
  client,
  bootstrap,
  runId,
  refreshBootstrap,
  streamEvents,
  streamStatus,
  streamVersion,
}: {
  client: AgentOpsClient;
  bootstrap: Bootstrap;
  runId: string;
  refreshBootstrap: () => void | Promise<void>;
  /** Events pushed by the app-level SSE subscription (already deduplicated by id). */
  streamEvents: readonly EventRecord[];
  streamStatus: string;
  /** Bumped by the app when streamed events arrive, to refresh the detail payload. */
  streamVersion: number;
}) {
  const [version, setVersion] = useState(0);
  const detail = useRunDetail(client, runId, version + streamVersion);
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    null,
  );
  const [logsOpen, setLogsOpen] = useState(true);
  const [selectedDecision, setSelectedDecision] =
    useState<ApprovalDecision | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [retryReason, setRetryReason] = useState("");
  const [retryInstruction, setRetryInstruction] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [operatorInput, setOperatorInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);
  const [showRetry, setShowRetry] = useState(false);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  const refreshAll = useCallback(async () => {
    await detail.reload();
    await refreshBootstrap();
  }, [detail, refreshBootstrap]);

  const action = useAction(client, refreshAll);

  const mergedEvents = useMemo(
    () =>
      mergeEvents(detail.data?.events ?? [], eventsForRun(streamEvents, runId)),
    [detail.data?.events, streamEvents, runId],
  );

  // Reset per-run UI state when the selected run changes.
  useEffect(() => {
    setSelectedStageKey(null);
    setSelectedAttemptId(null);
    setSelectedDecision(null);
    setDecisionReason("");
    setRetryReason("");
    setRetryInstruction("");
    setCancelReason("");
    setOperatorInput("");
    setFormError(null);
    setShowCancel(false);
    setShowRetry(false);
  }, [runId]);

  useEffect(() => {
    if (!detail.data) return;
    setSelectedStageKey(
      (current) =>
        current ??
        pickInitialStage(detail.data!.stages, detail.data!.run.nextStageKey),
    );
  }, [detail.data]);

  const run = detail.data?.run ?? null;
  const project =
    detail.data?.project ??
    bootstrap.projects.find((candidate) => candidate.id === run?.projectId) ??
    null;
  const rail = useMemo(() => {
    if (!detail.data) return null;
    return buildStageRail(
      detail.data.plan,
      detail.data.stages,
      detail.data.tasks,
      detail.data.agents,
      detail.data.run.nextStageKey,
    );
  }, [detail.data]);

  const selectedStage =
    detail.data?.stages.find((stage) => stage.key === selectedStageKey) ?? null;
  const pending = detail.data?.pendingApproval ?? null;
  const decisions = useMemo(() => approvalDecisionOptions(pending), [pending]);

  if (detail.error && !detail.data) {
    return (
      <div className="view view--wide">
        <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />
        <Button onClick={() => (window.location.hash = "#/runs")}>
          Back to history
        </Button>
      </div>
    );
  }

  if (!detail.data || !run) {
    return (
      <div className="view view--wide">
        <Loading label={`Loading run ${runId}…`} />
      </div>
    );
  }

  const cycle = reviewCycleView(run);
  const evidence = approvalEvidenceView({
    approval: pending,
    reviewCycle: cycle,
    verdicts: detail.data.reviewVerdicts,
    attempts: detail.data.attempts,
    tests: detail.data.tests,
    agents: detail.data.agents,
  });
  const question = pendingInputQuestion({
    events: mergedEvents,
    attempts: detail.data.attempts,
  });

  const submitDecision = async (decision: ApprovalDecision) => {
    const result = validateDecision(decision, decisionReason, decisions);
    if (!result.ok) {
      setFormError(Object.values(result.errors).join(" · "));
      return;
    }
    setFormError(null);
    const updated = await action.run((c) =>
      c.decideApproval(run.id, {
        decision,
        instruction: result.value.instruction,
      }),
    );
    if (updated) {
      setDecisionReason("");
      setSelectedDecision(null);
    }
  };

  const submitRetry = async () => {
    const result = validateRetryForm({
      reason: retryReason,
      instruction: retryInstruction,
    });
    if (!result.ok) {
      setFormError(result.errors["reason"] ?? "Invalid retry request");
      return;
    }
    setFormError(null);
    const updated = await action.run((c) =>
      c.retryRun(run.id, {
        reason: result.value.reason,
        instruction: result.value.instruction,
      }),
    );
    if (updated) {
      setRetryReason("");
      setRetryInstruction("");
      setShowRetry(false);
    }
  };

  const submitCancel = async () => {
    const result = validateCancelReason(cancelReason);
    if (!result.ok) {
      setFormError(result.errors["reason"] ?? "Invalid cancellation request");
      return;
    }
    setFormError(null);
    const updated = await action.run((c) =>
      c.cancelRun(run.id, { reason: result.value.reason }),
    );
    if (updated) {
      setCancelReason("");
      setShowCancel(false);
    }
  };

  const submitInput = async () => {
    if (!operatorInput.trim()) {
      setFormError("Input text is required");
      return;
    }
    setFormError(null);
    const updated = await action.run((c) =>
      c.sendInput(run.id, { text: operatorInput }),
    );
    if (updated) setOperatorInput("");
  };

  const needsHuman =
    run.status === "WAITING_APPROVAL" || run.status === "WAITING_INPUT";
  const canRetry = run.status === "FAILED" || run.status === "INTERRUPTED";
  const canStart = run.status === "DRAFT";
  const canCancel = !isTerminalRun(run.status);

  return (
    <>
      <div className="view view--wide">
        {run.status === "WAITING_APPROVAL" ? (
          <div className="banner" role="status">
            <b>WAITING FOR YOU</b>
            <span>
              {approvalGateLabel(pending?.gate ?? "")} — the run is stopped
              until an operator decides. Nothing advances on its own.
            </span>
            {pending?.reason ? (
              <span className="faint small">reason: {pending.reason}</span>
            ) : null}
          </div>
        ) : null}
        {run.status === "WAITING_INPUT" ? (
          <div className="banner" role="status">
            <b>WAITING FOR YOU</b>
            <span>
              An agent is blocked on operator input. Supply the text below to
              continue the attempt.
            </span>
          </div>
        ) : null}
        {run.status === "FAILED" || run.status === "INTERRUPTED" ? (
          <div className="notice notice--error" role="alert">
            <span className="notice__icon" aria-hidden="true">
              !
            </span>
            <div>
              <b>{statusLabel(run.status)}</b> —{" "}
              {text(
                run.failureReason ?? run.interruptReason,
                "no reason recorded",
              )}
              . Resuming requires a deliberate retry with a reason; the failed
              attempt stays in the history.
            </div>
          </div>
        ) : null}
        {run.status === "DRAFT" ? (
          <div className="banner" role="status">
            <b>DRAFT</b>
            <span>
              This run is persisted but idle. Review the plan below, then start
              it explicitly.
            </span>
          </div>
        ) : null}

        <Card
          title={
            <>
              <ClampedText text={run.goal} className="goal-title" />
              <StatusPill status={run.status} />
            </>
          }
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={reload}
                disabled={detail.loading}
              >
                {detail.loading ? "Refreshing…" : "Refresh"}
              </Button>
              <Button
                size="sm"
                variant={logsOpen ? "primary" : "default"}
                onClick={() => setLogsOpen((current) => !current)}
              >
                {logsOpen ? "Hide logs" : "Show logs"}
              </Button>
            </>
          }
          hint={`${project?.name ?? run.projectId} · ${run.projectRoot} · created ${formatTimestamp(run.createdAt)} · updated ${relativeTime(run.updatedAt)}`}
        >
          <div className="statline">
            <span>
              template{" "}
              <b>
                {run.templateId} v{run.templateVersion}
              </b>
            </span>
            <span title={`${cycle.used} fix cycle(s) used of ${cycle.max}`}>
              <b>{cycle.label}</b>
              {cycle.used > 0
                ? ` · fixes run ${cycle.used}`
                : " · no fix cycle"}
            </span>
            <span>
              git policy <b>{run.policy.gitPolicy}</b>
            </span>
            <span>
              next stage <b>{text(run.nextStageKey, "none")}</b>
            </span>
            <span>
              attempts <b>{detail.data.attempts.length}</b>
            </span>
            <span>
              events <b>{mergedEvents.length}</b>
            </span>
          </div>
          {run.constraints.length > 0 ? (
            <details className="run-constraints">
              <summary>{run.constraints.length} recorded constraints</summary>
              <ul
                className="stack--tight"
                style={{ marginTop: 10, paddingLeft: 18 }}
              >
                {run.constraints.map((constraint) => (
                  <li key={constraint} className="small">
                    {constraint}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="faint small" style={{ marginTop: 8 }}>
              No constraints recorded for this run.
            </p>
          )}
        </Card>

        <Card title={pending ? "Your decision" : "Run controls"}>
          <div className="stack">
            {action.error ? <ErrorBox error={action.error} /> : null}
            {formError ? <ErrorBox error={formError} /> : null}
            {action.notice ? (
              <Notice tone="success">{action.notice}</Notice>
            ) : null}

            {canStart ? (
              <div className="row">
                <Button
                  variant="primary"
                  onClick={() => void action.run((c) => c.startRun(run.id))}
                  disabled={action.pending}
                >
                  {action.pending ? "Starting…" : "Start run"}
                </Button>
                <span className="faint small">
                  Launches the entry stage. Human gates still stop the run.
                </span>
              </div>
            ) : null}

            {pending && evidence ? (
              <ApprovalPanel
                evidence={evidence}
                options={decisions}
                selected={selectedDecision}
                reason={decisionReason}
                busy={action.pending}
                error={formError}
                onSelect={setSelectedDecision}
                onReasonChange={setDecisionReason}
                onCancel={() => {
                  setSelectedDecision(null);
                  setDecisionReason("");
                  setFormError(null);
                }}
                onConfirm={(decision) => void submitDecision(decision)}
              />
            ) : null}

            {run.status === "WAITING_INPUT" ? (
              <div className="operator-input">
                <div className="operator-question stack--tight">
                  <b>What the agent is asking</b>
                  {question.text ? (
                    <p className="wrap-anywhere">{question.text}</p>
                  ) : (
                    <p className="faint small">
                      The agent asked for input but no question text was
                      persisted. Read the attempt output before answering.
                    </p>
                  )}
                  <p className="faint small wrap-anywhere">
                    Source:{" "}
                    {question.source === "input.requested"
                      ? "persisted input request"
                      : question.source === "agent.waiting"
                        ? "agent waiting event"
                        : question.source === "attempt summary"
                          ? "waiting attempt summary"
                          : "nothing recorded"}
                    {question.attemptNumber !== null
                      ? ` · attempt #${question.attemptNumber}`
                      : ""}
                    {question.stageKey ? ` · stage ${question.stageKey}` : ""}
                    {question.at ? ` · ${formatTimestamp(question.at)}` : ""}
                  </p>
                </div>
                <div className="stack">
                  <Field
                    label="Your answer"
                    htmlFor="operator-input"
                    help="Delivered to the waiting attempt as its next input."
                  >
                    <TextArea
                      id="operator-input"
                      rows={3}
                      value={operatorInput}
                      onChange={setOperatorInput}
                      ariaLabel="Operator input"
                    />
                  </Field>
                  <div>
                    <Button
                      variant="primary"
                      onClick={() => void submitInput()}
                      disabled={action.pending || !operatorInput.trim()}
                    >
                      {action.pending ? "Sending…" : "Send input"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="row">
              {canRetry ? (
                <Button onClick={() => setShowRetry((current) => !current)}>
                  {showRetry ? "Hide retry form" : "Retry with reason"}
                </Button>
              ) : null}
              {canCancel ? (
                <Button
                  variant="danger"
                  onClick={() => setShowCancel((current) => !current)}
                >
                  {showCancel ? "Hide cancel form" : "Cancel run"}
                </Button>
              ) : (
                <span className="faint small">
                  This run is terminal and cannot be restarted.
                </span>
              )}
              <span className="faint small">
                {needsHuman
                  ? "A human decision is required before the engine can continue."
                  : "No human gate is currently pending."}
              </span>
            </div>

            {showRetry && canRetry ? (
              <div
                className="stack"
                style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
              >
                <Field
                  label="Retry reason (mandatory)"
                  htmlFor="retry-reason"
                  help="Stored on the new attempt as its immutable reason."
                >
                  <TextArea
                    id="retry-reason"
                    rows={2}
                    value={retryReason}
                    onChange={setRetryReason}
                  />
                </Field>
                <Field
                  label="Instruction for the retried attempt (optional)"
                  htmlFor="retry-instruction"
                >
                  <TextArea
                    id="retry-instruction"
                    rows={2}
                    value={retryInstruction}
                    onChange={setRetryInstruction}
                  />
                </Field>
                <div className="row">
                  <Button
                    variant="primary"
                    onClick={() => void submitRetry()}
                    disabled={action.pending || !retryReason.trim()}
                  >
                    {action.pending ? "Retrying…" : "Create retry attempt"}
                  </Button>
                  <span className="faint small">
                    The previous attempt is kept and never overwritten.
                  </span>
                </div>
              </div>
            ) : null}

            {showCancel && canCancel ? (
              <div
                className="stack"
                style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}
              >
                <Field
                  label="Cancellation reason (mandatory)"
                  htmlFor="cancel-reason"
                  help="Records intent, terminates only the process group AgentOps owns, then records the terminal state."
                >
                  <TextArea
                    id="cancel-reason"
                    rows={2}
                    value={cancelReason}
                    onChange={setCancelReason}
                  />
                </Field>
                <div className="row">
                  <Button
                    variant="danger"
                    onClick={() => void submitCancel()}
                    disabled={action.pending || !cancelReason.trim()}
                  >
                    {action.pending ? "Cancelling…" : "Confirm cancellation"}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <div className="grid grid--run">
          {rail ? (
            <StageRail
              rail={rail}
              runStatus={run.status}
              selectedKey={selectedStageKey}
              onSelect={(key) => {
                setSelectedStageKey(key);
                setSelectedAttemptId(null);
              }}
            />
          ) : null}
          <AttemptDetail
            detail={detail.data}
            stage={selectedStage}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={setSelectedAttemptId}
          />
          <Inspector
            client={client}
            detail={detail.data}
            refreshDetail={refreshAll}
          />
        </div>

        <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />
      </div>

      {logsOpen ? (
        <LogsDrawer
          events={mergedEvents}
          streamStatus={streamStatus}
          stages={detail.data.stages}
          tasks={detail.data.tasks}
          agents={detail.data.agents}
          attempts={detail.data.attempts.map((attempt) => ({
            id: attempt.id,
            attemptNumber: attempt.attemptNumber,
            stageKey: attempt.stageKey,
          }))}
          error={detail.error}
          onReload={reload}
        />
      ) : null}
    </>
  );
}
