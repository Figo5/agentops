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
  Disclosure,
  ErrorBox,
  Field,
  Loading,
  Notice,
  StateLine,
  StatusMark,
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

  const canRetry = run.status === "FAILED" || run.status === "INTERRUPTED";
  const canStart = run.status === "DRAFT";
  const canCancel = !isTerminalRun(run.status);

  return (
    <>
      <div className="view view--wide">
        {/* Page header: the goal is the 30px page title, state sits beside it. */}
        <header className="page-head">
          <div className="page-head__title">
            <h1 className="page-title">
              <ClampedText text={run.goal} />
            </h1>
            <StatusMark status={run.status} size="lg" />
            <div className="page-head__actions">
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
                variant="ghost"
                onClick={() => setLogsOpen((current) => !current)}
              >
                {logsOpen ? "Hide logs" : "Show logs"}
              </Button>
            </div>
          </div>
          {/* The project stays visible; path, id and dates are quiet below. */}
          <p className="page-head__meta">{project?.name ?? run.projectId}</p>
        </header>

        {/*
         * A waiting gate is described by the decision sheet itself, so the
         * banner is only rendered when there is no decision to show.
         */}
        {run.status === "WAITING_APPROVAL" && !pending ? (
          <StateLine status={run.status} tone="accent">
            The run is stopped until an operator decides.
          </StateLine>
        ) : null}
        {run.status === "WAITING_INPUT" ? (
          <StateLine status={run.status} tone="accent">
            An agent is blocked on operator input. Supply the text below to
            continue the attempt.
          </StateLine>
        ) : null}
        {run.status === "FAILED" || run.status === "INTERRUPTED" ? (
          <StateLine status={run.status} tone="danger">
            {text(
              run.failureReason ?? run.interruptReason,
              "no reason recorded",
            )}
            . Resuming requires a deliberate retry with a reason.
          </StateLine>
        ) : null}
        {run.status === "DRAFT" ? (
          <StateLine status={run.status} tone="neutral">
            This run is persisted but idle. Review the plan below, then start it
            explicitly.
          </StateLine>
        ) : null}

        {/* The single human decision sheet is the one elevated surface. */}
        <Card
          elevated={Boolean(pending)}
          title={pending ? undefined : "Run controls"}
        >
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

            {/* Quiet, secondary run controls: never a loud competitor to the
                decision above. */}
            <div className="run-quiet-controls">
              {canRetry ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowRetry((current) => !current)}
                >
                  {showRetry ? "Hide retry form" : "Retry with reason"}
                </Button>
              ) : null}
              {!canCancel ? (
                <span className="faint small">
                  This run is terminal and cannot be restarted.
                </span>
              ) : null}
            </div>

            {showRetry && canRetry ? (
              <div className="run-form">
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

            {/* Cancellation is a quiet disclosure, never an always-visible
                destructive primary competitor to the decision above. */}
            {canCancel ? (
              <Disclosure summary="Cancel this run">
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
                    size="sm"
                    onClick={() => void submitCancel()}
                    disabled={action.pending || !cancelReason.trim()}
                  >
                    {action.pending ? "Cancelling…" : "Confirm cancellation"}
                  </Button>
                </div>
              </Disclosure>
            ) : null}
          </div>
        </Card>

        {/* Run metadata and constraints: quiet, one level down. */}
        <section className="run-details">
          <Disclosure summary="Run details">
            <dl className="kv">
              <dt>Project</dt>
              <dd>{project?.name ?? run.projectId}</dd>
              <dt>Repository</dt>
              <dd className="mono wrap-anywhere">{run.projectRoot}</dd>
              <dt>Template</dt>
              <dd>
                {run.templateId} v{run.templateVersion}
              </dd>
              <dt>Review cycle</dt>
              <dd title={`${cycle.used} fix cycle(s) used of ${cycle.max}`}>
                {cycle.label}
                {cycle.used > 0
                  ? ` · fixes run ${cycle.used}`
                  : " · no fix cycle"}
              </dd>
              <dt>Git policy</dt>
              <dd>{run.policy.gitPolicy}</dd>
              <dt>Next stage</dt>
              <dd>{text(run.nextStageKey, "none")}</dd>
              <dt>Attempts</dt>
              <dd>{detail.data.attempts.length}</dd>
              <dt>Events</dt>
              <dd>{mergedEvents.length}</dd>
              <dt>Run id</dt>
              <dd className="mono wrap-anywhere">{run.id}</dd>
              <dt>Created</dt>
              <dd>
                {formatTimestamp(run.createdAt)} · updated{" "}
                {relativeTime(run.updatedAt)}
              </dd>
              <dt>Constraints</dt>
              <dd>
                {run.constraints.length > 0 ? (
                  <ul
                    className="stack--tight"
                    style={{ margin: 0, paddingLeft: 18 }}
                  >
                    {run.constraints.map((constraint) => (
                      <li key={constraint}>{constraint}</li>
                    ))}
                  </ul>
                ) : (
                  "No constraints recorded for this run."
                )}
              </dd>
            </dl>
          </Disclosure>
        </section>

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
