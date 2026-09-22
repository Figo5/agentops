/**
 * Run view — the mission-control screen for one run.
 *
 * The page answers, in order: what is this run (project, goal), what is
 * happening right now (one semantic state), how far along is it (horizontal
 * Plan · Build · Verify · Review · Final progress), and what does the operator
 * have to do (one decision sheet with recorded evidence above a single filled
 * action).
 *
 * Everything the old three-column layout exposed is still here, in one of five
 * main tabs — Overview, Changes, Verification, Review, Activity — with IDs,
 * raw payloads, prompts and historical attempts kept behind disclosures. The
 * engine still owns execution; this view only submits explicit actions: start,
 * retry (with a mandatory reason), cancel (with a mandatory reason), approval
 * decisions limited to `pendingApproval.allowed`, and operator input.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type {
  ApprovalDecision,
  EventRecord,
  StageRecord,
} from "../../core/types.js";
import type { AgentOpsClient, Bootstrap } from "../api.js";
import { useAction, useRunDetail } from "../hooks.js";
import { reducedMotionNow } from "../preferences.js";
import {
  approvalDecisionOptions,
  approvalEvidenceView,
  classNames,
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
import {
  buildRunMilestones,
  changedFilesView,
  decisionFacts,
  evidenceTabForStage,
  latestTestsForAttempt,
  runStateView,
  runTabs,
  verificationHistory,
  type RunMilestoneView,
  type RunTabId,
} from "../run-view.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { ApprovalPanel, ApprovalEvidenceDetails } from "./ApprovalPanel.js";
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
  TabPanel,
  Tabs,
  TextArea,
} from "./Bits.js";
import { ChangesPanel } from "./ChangesPanel.js";
import {
  FailureEvidence,
  InputRequest,
  RetryForm,
  StartRunBlock,
} from "./DecisionSheet.js";
import { OverviewPanel } from "./OverviewPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { RunProgress } from "./RunProgress.js";
import { VerificationPanel } from "./VerificationPanel.js";

const RUN_TABS_ID = "run-sections";

const FAILURE_STATUSES = new Set(["FAILED", "INTERRUPTED", "CANCELLED"]);

/**
 * Explicit evidence navigation: bring the run's tab list to the top of the
 * viewport, just below the sticky top bar, so the panel the operator asked for
 * gets the screen instead of hanging below the whole summary. scroll-margin
 * (not a fixed top offset) is what keeps the list clear of the sticky bar, and
 * the bar's real height is measured rather than assumed.
 *
 * Only ever called from an explicit navigation — a tab click, a keyboard tab
 * selection or an evidence button. The initial load of a run stays at the top
 * of the page, so the header is still the first thing an operator sees.
 *
 * Motion is resolved through the same preference every other surface uses: an
 * explicit device preference (Settings → Display) wins, and `system` defers to
 * the OS. This is an imperative scroll, so it cannot rely on the CSS rule — it
 * reads the applied preference itself.
 */
function revealRunTabs(): void {
  if (typeof document === "undefined") return;
  const list = document.getElementById(RUN_TABS_ID);
  if (!list || typeof list.scrollIntoView !== "function") return;
  const bar = document.querySelector<HTMLElement>(".topbar");
  const offset = bar ? Math.ceil(bar.getBoundingClientRect().height) + 12 : 76;
  list.style.scrollMarginTop = `${offset}px`;
  // The panels below the list inherit the same measured offset: an evidence
  // panel uses it to keep the viewport height the reveal asked for, and the tab
  // button a keyboard selection focuses uses it for its own scroll-into-view.
  list
    .closest<HTMLElement>(".run-view")
    ?.style.setProperty("--sticky-offset", `${offset}px`);
  list.scrollIntoView({
    block: "start",
    inline: "nearest",
    behavior: reducedMotionNow() ? "auto" : "smooth",
  });
}

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
  const [tab, setTab] = useState<RunTabId>("overview");
  /**
   * Bumped by every explicit evidence navigation. The reveal itself runs in an
   * effect, after the requested panel has been committed: a new tab's content
   * is what gives the page the room to scroll, so scrolling during the click
   * would leave the panel below the fold on a compact run.
   */
  const [revealRequest, setRevealRequest] = useState(0);
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    null,
  );
  const [evidenceOpen, setEvidenceOpen] = useState(false);
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
    setTab("overview");
    setSelectedStageKey(null);
    setSelectedAttemptId(null);
    setEvidenceOpen(false);
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

  // Explicit evidence navigation: reveal the tab list in the same commit that
  // renders the requested panel. A layout effect runs after React has committed
  // the new panel and before the browser paints, so the page already has the
  // panel's height and the scroll lands without a visible jump.
  useLayoutEffect(() => {
    if (revealRequest === 0) return;
    revealRunTabs();
  }, [revealRequest]);

  const run = detail.data?.run ?? null;
  const project =
    detail.data?.project ??
    bootstrap.projects.find((candidate) => candidate.id === run?.projectId) ??
    null;

  const milestones: RunMilestoneView[] = useMemo(() => {
    if (!detail.data) return [];
    return buildRunMilestones(
      detail.data.plan,
      detail.data.stages,
      detail.data.agents,
      detail.data.run.nextStageKey,
    );
  }, [detail.data]);

  /**
   * Every verification the run recorded, newest first.
   *
   * Declared with the other hooks, above the loading/error returns: a hook must
   * never sit after a conditional return, or the loaded render has a different
   * hook order than the loading one (React error 310 on a real run route).
   */
  const verification = useMemo(() => {
    const loaded = detail.data;
    if (!loaded) return [];
    return verificationHistory({
      attempts: loaded.attempts,
      tests: loaded.tests,
      commands: loaded.commands,
      stages: loaded.stages,
    });
  }, [detail.data]);

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

  const data = detail.data;
  const cycle = reviewCycleView(run);
  const pending = data.pendingApproval;
  const decisions = approvalDecisionOptions(pending);
  const evidence = approvalEvidenceView({
    approval: pending,
    reviewCycle: cycle,
    verdicts: data.reviewVerdicts,
    attempts: data.attempts,
    tests: data.tests,
    agents: data.agents,
  });
  const question = pendingInputQuestion({
    events: mergedEvents,
    attempts: data.attempts,
  });

  // Built per render rather than memoised: this sits after the loading guards,
  // so it must not be a hook. The arrays are small (stages, attempts, agents).
  const activityContext = {
    stageNames: new Map(data.stages.map((stage) => [stage.key, stage.name])),
    attemptNumbers: new Map(
      data.attempts.map((attempt) => [attempt.id, attempt.attemptNumber]),
    ),
    agentNames: new Map(data.agents.map((agent) => [agent.id, agent.name])),
    // An agent event carries no agent id of its own; the attempt it belongs to
    // names the agent the sentence should use. An attempt whose agent is not
    // recorded stays unresolved rather than being given a generic name here.
    attemptAgents: new Map(
      data.attempts.flatMap((attempt) => {
        const name = data.agents.find(
          (agent) => agent.id === attempt.agentId,
        )?.name;
        return name ? [[attempt.id, name] as const] : [];
      }),
    ),
  };

  const runningStage =
    data.stages.find((stage) => stage.status === "RUNNING") ?? null;
  const waitingStage =
    data.stages.find(
      (stage) =>
        stage.status === "WAITING_APPROVAL" || stage.status === "WAITING_INPUT",
    ) ?? null;
  const nextStage =
    data.stages.find((stage) => stage.key === run.nextStageKey) ?? null;
  const activeStage = runningStage ?? waitingStage ?? nextStage ?? null;
  const failedStage =
    [...data.stages]
      .filter((stage) => FAILURE_STATUSES.has(stage.status))
      .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0] ??
    null;

  const activeAttempt =
    data.attempts.find((attempt) => attempt.id === run.currentAttemptId) ??
    (activeStage
      ? ([...data.attempts]
          .filter((attempt) => attempt.stageKey === activeStage.key)
          .sort((a, b) => b.attemptNumber - a.attemptNumber)[0] ?? null)
      : null);
  const activeAgentName =
    data.agents.find(
      (agent) => agent.id === (activeAttempt?.agentId ?? activeStage?.agentId),
    )?.name ?? null;

  const state = runStateView({
    status: run.status,
    gate: pending?.gate ?? null,
    stage: activeStage,
    agentName: activeAgentName,
    failedStageName: failedStage?.name ?? null,
  });

  // What the run recorded about the work in flight. The header already states
  // the state itself ("DeepSeek is implementing"), so this is the only line the
  // Overview adds while a run is active.
  const activeSummary =
    run.status === "RUNNING"
      ? (activeAttempt?.resultSummary ?? activeStage?.summary ?? null)
      : null;

  const tabs = runTabs({
    hasChanges: (project?.vcs ?? "none") === "git" || data.snapshots.length > 0,
    // A tab appears when there is evidence behind it. A planned stage stays
    // reachable through Workflow details, not as an empty tab.
    hasVerification:
      data.tests.length > 0 ||
      data.commands.length > 0 ||
      data.attempts.some((attempt) => attempt.verification !== null),
    hasReview: data.reviewVerdicts.length > 0,
    counts: {
      changes:
        changedFilesView({
          snapshot:
            [...data.snapshots].sort((a, b) =>
              a.capturedAt.localeCompare(b.capturedAt),
            )[Math.max(0, data.snapshots.length - 1)] ?? null,
        }).count ?? undefined,
      review: data.reviewVerdicts.length,
    },
  });
  const hasTab = (id: RunTabId) => tabs.some((entry) => entry.id === id);

  const facts = evidence
    ? decisionFacts({ evidence, snapshots: data.snapshots })
    : [];
  const testView = evidence?.verification
    ? latestTestsForAttempt(
        data.tests,
        evidence.verification.attemptId,
        evidence.verification.attemptNumber,
      )
    : { rows: [], hidden: 0 };

  const selectedStage =
    data.stages.find((stage) => stage.key === selectedStageKey) ?? null;

  const canRetry = run.status === "FAILED" || run.status === "INTERRUPTED";
  const canStart = run.status === "DRAFT";
  const canCancel = !isTerminalRun(run.status);
  const isFailure = canRetry && !pending && run.status !== "WAITING_INPUT";

  /**
   * Explicit evidence navigation: bring the run's tab list to the top of the
   * viewport, just below the sticky top bar, so the panel the operator asked
   * for gets the screen instead of hanging below the whole summary. Only ever
   * called from an explicit navigation — a tab click, a keyboard tab selection
   * or an evidence button; the initial load of a run stays at the top of the
   * page so the header is the first thing an operator sees.
   */
  const openTab = (id: RunTabId) => {
    setTab(hasTab(id) ? id : "overview");
    // Bumped, never set to a tab id: the reveal runs in an effect after the
    // requested panel has been committed. Scrolling before that render could
    // not reach the target — the new panel's height is what makes the room.
    setRevealRequest((current) => current + 1);
  };

  const selectStage = (key: string, milestone?: RunMilestoneView) => {
    setSelectedStageKey(key);
    setSelectedAttemptId(null);
    setEvidenceOpen(true);
    const kind =
      data.stages.find((stage) => stage.key === key)?.kind ??
      data.plan.stages.find((stage) => stage.key === key)?.kind ??
      "task";
    openTab(milestone ? milestone.tab : evidenceTabForStage(kind));
  };

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
    if (updated) setCancelReason("");
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

  const showsDecision =
    Boolean(pending && evidence) ||
    run.status === "WAITING_INPUT" ||
    canStart ||
    isFailure;

  return (
    <div className="view view--wide run-view">
      <header className="run-head">
        <p className="run-head__crumb">
          <span>{project?.name ?? run.projectId}</span>
          <span aria-hidden="true"> · </span>
          <span title="Local AgentOps server: the client talks only to the same-origin process that served it.">
            Local
          </span>
          <span aria-hidden="true"> · </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={reload}
            disabled={detail.loading}
          >
            {detail.loading ? "Refreshing…" : "Refresh"}
          </Button>
        </p>
        <div className="run-head__title">
          <h1 className="page-title">
            <ClampedText text={run.goal} />
          </h1>
        </div>
        <div className="run-head__state">
          <h2 className={classNames("run-state", `run-state--${state.tone}`)}>
            {state.headline}
          </h2>
          {state.detail ? <p className="faint small">{state.detail}</p> : null}
        </div>
      </header>

      <RunProgress
        milestones={milestones}
        selectedStageKey={selectedStageKey}
        onSelectStage={(key, milestone) => selectStage(key, milestone)}
        onOpenMilestone={(milestone) => openTab(milestone.tab)}
      />

      {showsDecision ? (
        <Card
          elevated={Boolean(pending)}
          title={
            pending
              ? undefined
              : run.status === "WAITING_INPUT"
                ? "Your answer"
                : canStart
                  ? "Ready to start"
                  : undefined
          }
        >
          <div className="stack">
            {action.error ? <ErrorBox error={action.error} /> : null}
            {formError ? <ErrorBox error={formError} /> : null}
            {action.notice ? (
              <Notice tone="success">{action.notice}</Notice>
            ) : null}

            {pending && evidence ? (
              <ApprovalPanel
                evidence={evidence}
                options={decisions}
                facts={facts}
                latestTests={testView.rows}
                testsHidden={testView.hidden}
                selected={selectedDecision}
                reason={decisionReason}
                busy={action.pending}
                error={formError}
                onSelect={setSelectedDecision}
                onReasonChange={setDecisionReason}
                onReviewChanges={
                  pending.gate === "final_acceptance" && hasTab("changes")
                    ? () => openTab("changes")
                    : undefined
                }
                onOpenReview={
                  pending.gate !== "final_acceptance" &&
                  evidence.verdict &&
                  hasTab("review")
                    ? () => openTab("review")
                    : undefined
                }
                showDetails={false}
                onCancel={() => {
                  setSelectedDecision(null);
                  setDecisionReason("");
                  setFormError(null);
                }}
                onConfirm={(decision) => void submitDecision(decision)}
              />
            ) : null}

            {run.status === "WAITING_APPROVAL" && !pending ? (
              <StateLine status={run.status} tone="accent">
                This run is stopped until an operator decides, but the gate
                payload has not loaded yet.
              </StateLine>
            ) : null}

            {run.status === "WAITING_INPUT" ? (
              <InputRequest
                question={question}
                stageName={activeStage?.name ?? null}
                value={operatorInput}
                onChange={setOperatorInput}
                onSubmit={() => void submitInput()}
                busy={action.pending}
              />
            ) : null}

            {isFailure ? (
              <div className="stack">
                <h2 className="run-sheet__headline">{state.headline}</h2>
                <FailureEvidence
                  stage={failedStage}
                  reason={run.failureReason ?? run.interruptReason}
                  attempts={data.attempts.length}
                />
                {showRetry ? (
                  <RetryForm
                    reason={retryReason}
                    instruction={retryInstruction}
                    onReasonChange={setRetryReason}
                    onInstructionChange={setRetryInstruction}
                    onSubmit={() => void submitRetry()}
                    busy={action.pending}
                  />
                ) : (
                  <div className="row">
                    <Button
                      variant="primary"
                      onClick={() => setShowRetry(true)}
                      disabled={action.pending}
                    >
                      Retry with reason
                    </Button>
                    <span className="faint small">
                      Resuming needs a deliberate retry with a reason. The
                      failed attempt is kept and never overwritten.
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            {canStart ? (
              <StartRunBlock
                onStart={() => void action.run((c) => c.startRun(run.id))}
                busy={action.pending}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      <Tabs
        idBase={RUN_TABS_ID}
        // The tab list carries the run-sections id so explicit navigation can
        // scroll it (and the selected panel below it) to the top of the page.
        id={RUN_TABS_ID}
        label="Run sections"
        active={tab}
        onChange={(id) => openTab(id as RunTabId)}
        tabs={tabs}
      />

      <TabPanel
        idBase={RUN_TABS_ID}
        id="overview"
        selected={tab === "overview"}
      >
        {tab === "overview" ? (
          <OverviewPanel
            client={client}
            detail={data}
            events={mergedEvents}
            activityContext={activityContext}
            activeSummary={activeSummary}
            showOutcome={run.status === "COMPLETED" && !showsDecision}
            selectedStage={selectedStage}
            selectedStageKey={selectedStageKey}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={setSelectedAttemptId}
            onSelectStage={(key) => selectStage(key)}
            onOpenTab={openTab}
            evidenceOpen={evidenceOpen}
            onEvidenceOpen={setEvidenceOpen}
            refreshDetail={refreshAll}
          />
        ) : null}
      </TabPanel>
      {/* The four evidence panels are the ones explicit navigation opens: each
          keeps the viewport height it was opened for, so a short panel — or one
          whose diff is still loading — still gives the page the room the reveal
          needs. Overview keeps its natural height: it is the top of the page. */}
      <TabPanel
        idBase={RUN_TABS_ID}
        id="changes"
        selected={tab === "changes"}
        className="run-evidence"
      >
        {tab === "changes" ? (
          <ChangesPanel client={client} detail={data} />
        ) : null}
      </TabPanel>
      <TabPanel
        idBase={RUN_TABS_ID}
        id="verification"
        selected={tab === "verification"}
        className="run-evidence"
      >
        {tab === "verification" ? <VerificationPanel detail={data} /> : null}
      </TabPanel>
      <TabPanel
        idBase={RUN_TABS_ID}
        id="review"
        selected={tab === "review"}
        className="run-evidence"
      >
        {tab === "review" ? <ReviewPanel detail={data} /> : null}
      </TabPanel>
      <TabPanel
        idBase={RUN_TABS_ID}
        id="activity"
        selected={tab === "activity"}
        className="run-evidence"
      >
        {tab === "activity" ? (
          <ActivityPanel
            events={mergedEvents}
            streamStatus={streamStatus}
            stages={data.stages}
            tasks={data.tasks}
            agents={data.agents}
            attempts={data.attempts.map((attempt) => ({
              id: attempt.id,
              attemptNumber: attempt.attemptNumber,
              stageKey: attempt.stageKey,
              agentId: attempt.agentId,
            }))}
            error={detail.error}
            onReload={reload}
          />
        ) : null}
      </TabPanel>

      <Disclosure summary="Technical details">
        {pending && evidence ? (
          <ApprovalEvidenceDetails
            evidence={evidence}
            options={decisions}
            facts={facts}
            latestTests={testView.rows}
            testsHidden={testView.hidden}
          />
        ) : null}
        {canCancel ? (
          <div className="stack">
            <span className="faint small">Stop this run</span>
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
          </div>
        ) : (
          <p className="faint small">
            This run is terminal and cannot be restarted.
          </p>
        )}
        <dl className="kv">
          <dt>Project</dt>
          <dd>{project?.name ?? run.projectId}</dd>
          <dt>Repository</dt>
          <dd className="mono wrap-anywhere">{run.projectRoot}</dd>
          <dt>Template</dt>
          <dd>
            {run.templateId} v{run.templateVersion}
          </dd>
          <dt>Persisted status</dt>
          <dd>
            {statusLabel(run.status)}{" "}
            <span className="mono small">({run.status})</span>
          </dd>
          {pending ? (
            <>
              <dt>Approval gate key</dt>
              <dd className="mono">{pending.gate}</dd>
            </>
          ) : null}
          <dt>Review cycle</dt>
          <dd>{cycle.label}</dd>
          <dt>Git policy</dt>
          <dd>{run.policy.gitPolicy}</dd>
          <dt>Next stage</dt>
          <dd className="mono">{text(run.nextStageKey, "none")}</dd>
          <dt>Attempts</dt>
          <dd>{data.attempts.length}</dd>
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

      <ErrorBox error={detail.error} onRetry={() => void detail.reload()} />
    </div>
  );
}
