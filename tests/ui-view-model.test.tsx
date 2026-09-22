/**
 * Pure view-model tests. These exercise the real exported helpers the React
 * components render — no DOM, no browser simulation, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStagePlan, builtinTemplate } from "../src/core/templates.js";
import type {
  AgentRecord,
  ArtifactRecord,
  AttemptRecord,
  EventRecord,
  GitSnapshotRecord,
  ProjectRecord,
  ReviewVerdictRecord,
  RunRecord,
  StageRecord,
  TaskRecord,
  TestRunRecord,
} from "../src/core/types.js";
import {
  AGENT_PRESETS,
  EMPTY_AGENT_FORM,
  EMPTY_PROJECT_FORM,
  EMPTY_RUN_SEARCH,
  TEST_COUNT_UNAVAILABLE,
  UNKNOWN,
  agentStateLabel,
  agentToForm,
  activeRowDetail,
  approvalDecisionOptions,
  approvalEvidenceView,
  approvalSummaryLine,
  artifactView,
  attemptCountsView,
  attentionStateLabel,
  buildRunSearchParams,
  categoryCounts,
  classifyDiff,
  commandLine,
  diffLines,
  eventMessage,
  eventsForRun,
  filterEvents,
  fixLoopCycleLabel,
  formatBytes,
  formatCount,
  formatDuration,
  EVIDENCE_MAX,
  greetingFor,
  homeSections,
  homeSummary,
  issueDisposition,
  issueTally,
  lastEventId,
  mergeEvents,
  runEvidenceLine,
  parseArgsJson,
  parseDiffStats,
  parseRoute,
  pendingInputQuestion,
  planRoleOptions,
  planRows,
  projectAllowedAdapters,
  projectPathHint,
  promptComparisons,
  reviewerIdentity,
  reviewerName,
  reviewerProvenanceLabel,
  reviewCycleView,
  routeHref,
  runMatchesSearch,
  serializeQuery,
  shellQuoteArgument,
  snapshotView,
  statusLabel,
  statusTone,
  testCountsLabel,
  usageView,
  validateAgentForm,
  validateArtifactForm,
  validateCancelReason,
  validateDecision,
  validateNewRunForm,
  validateProjectForm,
  validateRetryForm,
  verdictLabel,
  verdictTone,
  verificationCountsLabel,
  verificationLabel,
  verificationShortLabel,
} from "../src/ui/view-model.js";
import {
  activityEntries,
  activitySentence,
  activeWorkSentence,
  blockerFact,
  buildRunMilestones,
  changedFilesView,
  checksFact,
  diffFiles,
  eventSeverity,
  eventSeverityLabel,
  evidenceTabForStage,
  latestTestsForAttempt,
  rawLogEntries,
  reviewHistory,
  runStateView,
  runTabLabel,
  runTabs,
  verificationFailed,
  verificationHistory,
} from "../src/ui/run-view.js";

/* ------------------------------- fixtures ------------------------------ */

const plan = buildStagePlan(builtinTemplate("implement-review")!);

function stage(key: string, patch: Partial<StageRecord> = {}): StageRecord {
  const entry = plan.stages.find((candidate) => candidate.key === key)!;
  return {
    id: `stage-${key}`,
    runId: "run-1",
    key,
    name: entry.name,
    kind: entry.kind,
    role: entry.role,
    agentId: entry.kind === "task" ? "agent-impl" : null,
    orderIndex: entry.orderIndex,
    status: "PENDING",
    instructions: entry.instructions,
    dependsOn: entry.dependsOn,
    nextStageKey: entry.nextStageKey,
    loop: entry.loop,
    conditional: entry.conditional,
    skipReason: null,
    cycle: 0,
    attemptCount: 0,
    summary: null,
    failureReason: null,
    overridden: false,
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-09-22T10:00:00.000Z",
    ...patch,
  };
}

function task(key: string): TaskRecord {
  const entry = plan.stages.find((candidate) => candidate.key === key)!;
  return {
    id: `task-${key}`,
    runId: "run-1",
    stageKey: key,
    title: entry.name,
    kind: entry.kind,
    role: entry.role,
    agentId: entry.kind === "task" ? "agent-impl" : null,
    status: "PENDING",
    plan: {},
    attemptCount: 0,
    currentAttemptId: null,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  };
}

const agents: AgentRecord[] = [
  {
    id: "agent-impl",
    name: "DeepSeek V4.1 Flash",
    roleHint: "implementer",
    adapterKind: "hermes-opencode",
    model: "deepseek-v4.1-flash",
    effort: null,
    enabled: true,
    config: { executable: "hermes", provider: "opencode-go" },
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T09:00:00.000Z",
  },
];

function run(
  status: RunRecord["status"],
  updatedAt: string,
  id = `run-${updatedAt}`,
): RunRecord {
  return {
    id,
    projectId: "project-1",
    projectRoot: "/tmp/project",
    templateId: "implement-review",
    templateVersion: 1,
    goal: "goal",
    constraints: [],
    status,
    roleMapping: { implementer: "agent-impl" },
    policy: {
      templateId: "implement-review",
      templateVersion: 1,
      maxReviewCycles: 2,
      requireVerification: true,
      finalApprovalRequired: true,
      stopOnFailure: true,
      roleMapping: { implementer: "agent-impl" },
      verificationCommands: [],
      gitPolicy: "read-only",
      stoppingRule: "stop at human gates",
    },
    plan,
    nextStageKey: "implement",
    currentAttemptId: null,
    reviewCycle: 0,
    epoch: 0,
    failureReason: null,
    cancelReason: null,
    interruptReason: null,
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt,
    startedAt: null,
    endedAt: null,
  };
}

function event(id: number, patch: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    projectId: "project-1",
    runId: "run-1",
    taskId: "task-implement",
    attemptId: "attempt-1",
    stageKey: "implement",
    category: "agent",
    type: "AGENT_OUTPUT",
    actor: "agent",
    payload: { message: `line ${id}` },
    createdAt: "2026-09-22T10:00:00.000Z",
    ...patch,
  };
}

function attempt(
  id: string,
  attemptNumber: number,
  stageKey: string,
  verificationStatus: "passed" | "failed" | "unavailable" | null,
): AttemptRecord {
  return {
    id,
    taskId: `task-${stageKey}`,
    runId: "run-1",
    stageKey,
    attemptNumber,
    reason: null,
    previousAttemptId: null,
    kind: "agent",
    status: "COMPLETED",
    agentId: "agent-impl",
    adapterKind: "mock",
    agentSessionId: null,
    promptPacket: null,
    promptText: "prompt",
    inputs: [],
    resultStatus: "completed",
    resultSummary: null,
    exitCode: 0,
    usage: null,
    usageKnown: false,
    artifacts: [],
    reviewVerdictId: null,
    verification: verificationStatus
      ? {
          status: verificationStatus,
          summary: "1 command exited 0",
          reason: null,
          mode: "commands",
          commandCount: 1,
          counts: null,
        }
      : null,
    error: null,
    createdAt: "2026-09-22T10:00:00.000Z",
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: "2026-09-22T10:01:00.000Z",
  };
}

function testRun(
  id: string,
  attemptId: string,
  createdAt: string,
  total: number,
): TestRunRecord {
  return {
    id,
    runId: "run-1",
    taskId: null,
    attemptId,
    stageKey: "verify",
    framework: "node:test",
    status: "passed",
    passed: total,
    failed: 0,
    skipped: 0,
    total,
    parsedConfidently: true,
    summary: null,
    durationMs: 1200,
    createdAt,
  };
}

function verdictRecord(
  patch: Partial<ReviewVerdictRecord> & { id: string },
): ReviewVerdictRecord {
  const { id, ...rest } = patch;
  const base: ReviewVerdictRecord = {
    id,
    runId: "run-1",
    taskId: "task-review",
    attemptId: "attempt-review",
    stageKey: "review",
    cycle: 1,
    valid: true,
    validationErrors: [],
    verdict: "APPROVE",
    summary: null,
    issues: [],
    confidence: null,
    reviewer: null,
    raw: "{}",
    createdAt: "2026-09-22T10:00:00.000Z",
  };
  return { ...base, ...rest, id };
}
/* ------------------------------ formatting ----------------------------- */

test("unknown values never render as zero", () => {
  assert.equal(formatCount(null), UNKNOWN);
  assert.equal(formatBytes(null), UNKNOWN);
  assert.equal(formatDuration(null), UNKNOWN);
  assert.equal(formatCount(0), "0");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatDuration(0), "0 ms");
  assert.equal(formatDuration(1500), "1.5 s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatBytes(2048), "2.0 KB");
});

test("usage unknown is explicit and never zeros", () => {
  const unknown = usageView(null, false);
  assert.equal(unknown.known, false);
  assert.equal(unknown.total, UNKNOWN);
  assert.equal(unknown.cost, UNKNOWN);
  const known = usageView(
    {
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      costUsd: 0.0123,
      model: "m",
    },
    true,
  );
  assert.equal(known.total, "1,500");
  assert.equal(known.cost, "$0.0123");
  const partial = usageView(
    {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      model: null,
    },
    true,
  );
  assert.equal(partial.total, UNKNOWN);
  assert.equal(partial.model, UNKNOWN);
});

test("status labels and tones cover the persisted state machine", () => {
  assert.equal(statusLabel("WAITING_APPROVAL"), "Waiting for you");
  assert.equal(statusTone("WAITING_APPROVAL"), "warn");
  assert.equal(statusTone("RUNNING"), "active");
  assert.equal(statusTone("COMPLETED"), "success");
  assert.equal(statusTone("FAILED"), "danger");
  assert.equal(statusTone("SKIPPED"), "warn");
  assert.equal(statusLabel("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(verdictLabel(null, false), "Invalid verdict payload");
  assert.equal(verdictTone("REJECT"), "danger");
});

/* -------------------------------- events ------------------------------- */

test("event message prefers payload text and falls back to raw JSON", () => {
  assert.equal(
    eventMessage({ type: "X", payload: { message: "hello" } }),
    "hello",
  );
  assert.equal(
    eventMessage({ type: "X", payload: { text: "from text" } }),
    "from text",
  );
  assert.equal(eventMessage({ type: "X", payload: { error: "boom" } }), "boom");
  assert.equal(
    eventMessage({ type: "X", payload: { weird: 1 } }),
    'X {"weird":1}',
  );
  assert.equal(
    eventMessage({ type: "AGENT_STARTED", payload: {} }),
    "AGENT_STARTED",
  );
});

test("event filtering combines category, actor, attempt and text", () => {
  const events = [
    event(1, { category: "agent", actor: "agent" }),
    event(2, {
      category: "review",
      actor: "verifier",
      payload: { message: "verdict: REJECT" },
    }),
    event(3, { category: "agent", actor: "operator", attemptId: "attempt-2" }),
  ];
  assert.equal(filterEvents(events, { categories: ["agent"] }).length, 2);
  assert.equal(filterEvents(events, { actors: ["verifier"] }).length, 1);
  assert.equal(filterEvents(events, { attempts: ["attempt-2"] }).length, 1);
  assert.equal(filterEvents(events, { text: "reject" }).length, 1);
  assert.equal(filterEvents(events, {}).length, 3);
  assert.equal(
    filterEvents(events, { categories: ["agent"], actors: ["operator"] })
      .length,
    1,
  );
});

test("the event buffer never leaks across runs", () => {
  const events = [
    event(1, { runId: "run-1" }),
    event(2, { runId: "run-2" }),
    event(3, { runId: null, category: "system" }),
  ];
  assert.deepEqual(
    eventsForRun(events, "run-1").map((entry) => entry.id),
    [1, 3],
  );
  assert.deepEqual(
    eventsForRun(events, "run-9").map((entry) => entry.id),
    [3],
  );
});

test("events merge by id, stay ordered and respect the cap", () => {
  const merged = mergeEvents(
    [event(2), event(1)],
    [event(2, { payload: { message: "updated" } }), event(3)],
  );
  assert.deepEqual(
    merged.map((entry) => entry.id),
    [1, 2, 3],
  );
  assert.equal(eventMessage(merged[1]!), "updated");
  assert.equal(lastEventId(merged), 3);
  assert.equal(lastEventId([]), 0);
  const capped = mergeEvents(
    [],
    Array.from({ length: 10 }, (_, index) => event(index + 1)),
    4,
  );
  assert.deepEqual(
    capped.map((entry) => entry.id),
    [7, 8, 9, 10],
  );
  const counts = categoryCounts([
    event(1, { category: "agent" }),
    event(2, { category: "review" }),
    event(3),
  ]);
  assert.deepEqual(counts[0], { category: "agent", count: 2 });
});

/* ------------------------- run screen (pass 3) ------------------------- */

test("milestones group the frozen plan into plain, honest steps", () => {
  const stages = [
    stage("plan", { status: "COMPLETED", attemptCount: 1 }),
    stage("implement", {
      status: "COMPLETED",
      attemptCount: 1,
      summary: "done",
    }),
    stage("verify", { status: "COMPLETED" }),
    stage("review", { status: "WAITING_APPROVAL", cycle: 1, attemptCount: 2 }),
    stage("review.fix", { status: "COMPLETED", cycle: 1, attemptCount: 1 }),
    stage("review.retest", { status: "COMPLETED", cycle: 1 }),
  ];
  const milestones = buildRunMilestones(plan, stages, agents, "review");
  assert.deepEqual(
    milestones.map((milestone) => milestone.name),
    ["Plan", "Build", "Verify", "Review", "Final"],
  );
  assert.deepEqual(
    milestones.map((milestone) => milestone.state),
    ["complete", "complete", "complete", "current", "wait"],
  );
  const review = milestones[3]!;
  assert.deepEqual(
    review.stages.map((entry) => entry.key),
    ["review", "review.fix", "review.retest"],
  );
  // The review branch reads as a plain chronology with the cycle it belongs to.
  assert.equal(review.stages[1]!.loopLabel, "fixes from review cycle 1 of 2");
  assert.equal(review.stages[1]!.loopPhase, "fix");
  assert.equal(review.stages[2]!.name, "Structured review: re-verification");
  // The current stage's own status word is the only state word shown.
  assert.equal(review.statusWord, "Waiting for you");
  assert.equal(review.stages[0]!.statusWord, "Waiting for you");
  // No raw enum ever leaves the model as display copy.
  assert.ok(
    !milestones.some((milestone) =>
      /WAITING_APPROVAL/.test(milestone.stateWord),
    ),
  );
  // The last two plan stages are the final milestone, not a Verify step.
  assert.deepEqual(
    milestones[4]!.stages.map((entry) => entry.key),
    ["final_verify", "final"],
  );
});

test("a milestone with no stages is omitted instead of drawn empty", () => {
  const withoutFinal = {
    ...plan,
    stages: plan.stages.filter(
      (entry) =>
        entry.loop === null &&
        entry.kind !== "review" &&
        entry.kind !== "verify" &&
        entry.kind !== "final_approval",
    ),
  };
  const milestones = buildRunMilestones(
    withoutFinal,
    [stage("implement", { status: "FAILED", failureReason: "boom" })],
    agents,
    "implement",
  );
  assert.deepEqual(
    milestones.map((milestone) => milestone.name),
    ["Plan", "Build"],
  );
  assert.equal(milestones[1]!.state, "failed");
  assert.equal(milestones[1]!.icon, "!");
  assert.equal(milestones[1]!.stages[0]!.failureReason, "boom");
});

test("the final milestone is the last verification plus the human gate", () => {
  const withoutReview = {
    ...plan,
    stages: plan.stages.filter(
      (entry) => entry.loop === null && entry.kind !== "review",
    ),
  };
  const milestones = buildRunMilestones(
    withoutReview,
    [stage("verify", { status: "COMPLETED" })],
    agents,
    "final_verify",
  );
  assert.deepEqual(
    milestones.map((milestone) => milestone.name),
    ["Plan", "Build", "Verify", "Final"],
  );
  assert.deepEqual(
    milestones[3]!.stages.map((entry) => entry.key),
    ["final_verify", "final"],
  );
  assert.equal(milestones[2]!.state, "complete");
  assert.equal(milestones[3]!.state, "current");
});

test("the run state is the six semantic sentences, never the enum", () => {
  const implement = plan.stages.find((entry) => entry.key === "implement")!;
  const review = plan.stages.find((entry) => entry.key === "review")!;
  assert.equal(
    runStateView({
      status: "WAITING_APPROVAL",
      gate: "final_acceptance",
      stage: review,
    }).headline,
    "Ready for your review",
  );
  assert.equal(
    runStateView({ status: "WAITING_APPROVAL", gate: "review_reject" })
      .headline,
    "Changes requested",
  );
  assert.equal(
    runStateView({
      status: "WAITING_APPROVAL",
      gate: "review_cycle_exhausted",
    }).headline,
    "Changes requested",
  );
  assert.equal(
    runStateView({
      status: "RUNNING",
      stage: implement,
      agentName: "DeepSeek V4.1 Flash",
    }).headline,
    "DeepSeek V4.1 Flash is implementing",
  );
  assert.equal(
    runStateView({
      status: "WAITING_INPUT",
      stage: implement,
      agentName: "DeepSeek V4.1 Flash",
    }).headline,
    "DeepSeek V4.1 Flash needs your input",
  );
  assert.equal(
    runStateView({
      status: "FAILED",
      failedStageName: "Implementation",
    }).headline,
    "Implementation failed",
  );
  assert.equal(runStateView({ status: "COMPLETED" }).headline, "Completed");
  // A persisted enum is never used as the sentence.
  assert.ok(
    !runStateView({ status: "RUNNING", stage: review }).headline.includes(
      "RUNNING",
    ),
  );
});

test("tabs hide the panels that do not apply to this run", () => {
  assert.deepEqual(
    runTabs({
      hasChanges: true,
      hasVerification: true,
      hasReview: true,
    }).map((tab) => tab.label),
    ["Overview", "Changes", "Verification", "Review", "Activity"],
  );
  assert.deepEqual(
    runTabs({
      hasChanges: false,
      hasVerification: true,
      hasReview: false,
      counts: { verification: 2 },
    }).map((tab) => tab.id),
    ["overview", "verification", "activity"],
  );
  // A stage click lands on the tab that actually holds its evidence.
  assert.equal(evidenceTabForStage("verify"), "verification");
  assert.equal(evidenceTabForStage("review"), "review");
  assert.equal(evidenceTabForStage("task"), "overview");
  assert.equal(runTabLabel("activity"), "Activity");
});

test("activity sentences are lifecycle lines, never output frames", () => {
  const context = {
    stageNames: new Map([["implement", "Implementation"]]),
    attemptNumbers: new Map([["attempt-1", 2]]),
    agentNames: new Map([["agent-impl", "DeepSeek V4.1 Flash"]]),
  };
  const started = event(1, {
    category: "stage",
    type: "stage.started",
    payload: { agentId: "agent-impl" },
  });
  const output = event(2, {
    category: "agent",
    type: "agent.output",
    payload: { message: "raw protocol frame", stream: "stdout" },
  });
  const failed = event(3, {
    category: "agent",
    type: "agent.failed",
    payload: { agentId: "agent-impl", message: "adapter exited 1" },
  });
  const heartbeat = event(4, { category: "system", type: "HEARTBEAT" });

  assert.equal(
    activitySentence(started, context),
    "DeepSeek V4.1 Flash started Implementation",
  );
  assert.equal(activitySentence(output, context), null);
  assert.equal(
    activitySentence(failed, context),
    "DeepSeek V4.1 Flash failed on Implementation: adapter exited 1",
  );
  assert.equal(activitySentence(heartbeat, context), null);

  const entries = activityEntries(
    [started, output, failed, heartbeat],
    context,
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [1, 3],
  );
  // Only the failed line is flagged as something that went wrong.
  assert.deepEqual(
    activityEntries([started, output, failed], context, {
      attentionOnly: true,
    }).map((entry) => entry.id),
    [3],
  );

  // The raw log stream keeps every frame, with its stream and severity.
  const raw = rawLogEntries([started, output, failed], context);
  assert.equal(raw.length, 3);
  assert.equal(raw[1]!.stream, "stdout");
  assert.equal(raw[1]!.severity, "detail");
  assert.equal(raw[1]!.stageName, "Implementation");
  assert.equal(raw[1]!.attemptNumber, 2);
  assert.equal(raw[0]!.severity, "progress");
  assert.equal(raw[2]!.severity, "attention");
  assert.equal(eventSeverityLabel("attention"), "Needs attention");
  assert.equal(eventSeverityLabel("detail"), "Output");
  assert.equal(eventSeverity(output), "detail");
});

test("one action is one activity line, not three bookkeeping rows", () => {
  const context = {
    stageNames: new Map([["implement", "Implementation"]]),
    attemptNumbers: new Map([["attempt-1", 1]]),
    agentNames: new Map([["agent-impl", "DeepSeek V4.1 Flash"]]),
  };
  const bookkeeping = [
    event(1, {
      category: "attempt",
      type: "attempt.created",
      payload: { attemptNumber: 1, agentId: "agent-impl" },
    }),
    event(2, {
      category: "stage",
      type: "stage.attempt_started",
      payload: { attemptNumber: 1 },
    }),
    event(3, {
      category: "agent",
      type: "agent.started",
      payload: { agentId: "agent-impl" },
    }),
    event(4, {
      category: "stage",
      type: "stage.completed",
      payload: { summary: "done" },
    }),
    event(5, {
      category: "agent",
      type: "agent.completed",
      payload: { agentId: "agent-impl" },
    }),
  ];
  const entries = activityEntries(bookkeeping, context);
  assert.deepEqual(
    entries.map((entry) => entry.sentence),
    [
      "DeepSeek V4.1 Flash started Implementation",
      "DeepSeek V4.1 Flash finished Implementation",
    ],
  );
  // The raw log stream still holds every one of the five events.
  assert.equal(rawLogEntries(bookkeeping, context).length, 5);
});

test("the active-work sentence names the real work", () => {
  const implement = plan.stages.find((entry) => entry.key === "implement")!;
  const verify = plan.stages.find((entry) => entry.key === "verify")!;
  const review = plan.stages.find((entry) => entry.key === "review")!;
  const planStage = plan.stages.find((entry) => entry.key === "plan")!;
  assert.equal(
    activeWorkSentence(planStage, "DeepSeek V4.1 Flash"),
    "DeepSeek V4.1 Flash is planning",
  );
  assert.equal(
    activeWorkSentence(implement, "DeepSeek V4.1 Flash"),
    "DeepSeek V4.1 Flash is implementing",
  );
  assert.equal(
    activeWorkSentence(verify, "DeepSeek V4.1 Flash"),
    "DeepSeek V4.1 Flash is running verification",
  );
  assert.equal(activeWorkSentence(verify, null), "Verification is running");
  assert.equal(
    activeWorkSentence(review, "Claude Opus 4.8"),
    "Claude Opus 4.8 is reviewing",
  );
  assert.equal(activeWorkSentence(review, null), "Review is running");
  assert.equal(activeWorkSentence(null, null), "Implementation is running");
});

test("a unified diff splits into per-file sections without losing a line", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-drop",
    "+added",
    "+also added",
    "diff --git a/src/b.ts b/src/b.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  const sections = diffFiles(diff);
  assert.deepEqual(
    sections.map((section) => section.path),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(sections[0]!.additions, 2);
  assert.equal(sections[0]!.removals, 1);
  assert.equal(sections[1]!.additions, 1);
  assert.equal(sections[1]!.removals, 1);
  // Every input line is still represented, including the headers.
  assert.equal(
    sections.reduce((total, section) => total + section.lines.length, 0),
    13,
  );
  assert.deepEqual(diffFiles(""), []);
});

test("verification history is one entry per attempt and newest first", () => {
  const attempts: AttemptRecord[] = [
    attempt("attempt-1", 1, "verify", "passed"),
    attempt("attempt-2", 2, "final_verify", "passed"),
    attempt("attempt-3", 1, "implement", null),
  ];
  const tests: TestRunRecord[] = [
    testRun("t1", "attempt-1", "2026-09-22T10:00:00.000Z", 7),
    testRun("t2", "attempt-2", "2026-09-22T12:00:00.000Z", 7),
  ];
  const history = verificationHistory({ attempts, tests, commands: [] });
  assert.deepEqual(
    history.map((entry) => entry.attemptId),
    ["attempt-2", "attempt-1"],
  );
  assert.equal(history[0]!.latest, true);
  assert.equal(history[1]!.latest, false);
  // The newest attempt's counts are its own 7 — never the two records added up.
  assert.equal(history[0]!.counts!.total, 7);
  assert.equal(history[0]!.shortLabel, "7 tests passed");
  // The attempt with no verification, tests or commands is not listed at all.
  assert.ok(!history.some((entry) => entry.attemptId === "attempt-3"));
});

test("a later attempt shadows an earlier one and older ones stay collapsed", () => {
  const attempts: AttemptRecord[] = [
    attempt("attempt-1", 1, "verify", "failed"),
    attempt("attempt-2", 2, "verify", "passed"),
  ];
  const history = verificationHistory({ attempts, tests: [], commands: [] });
  assert.equal(history.length, 2);
  assert.equal(verificationFailed(history[0]!), false);
  assert.equal(verificationFailed(history[1]!), true);
});

test("review history keeps every finding with its path and severity", () => {
  const verdicts: ReviewVerdictRecord[] = [
    verdictRecord({
      id: "rev-1",
      cycle: 1,
      createdAt: "2026-09-22T10:00:00.000Z",
      verdict: "REJECT",
      reviewer: null,
      summary: "the parser drops empty input",
      issues: [
        {
          severity: "blocking",
          description: "empty input throws",
          path: "src/parser.ts",
          line: 42,
        },
      ],
    }),
    verdictRecord({
      id: "rev-2",
      cycle: 2,
      createdAt: "2026-09-22T12:00:00.000Z",
      verdict: "APPROVE",
      reviewer: "Claude Opus 4.8",
      summary: "clean",
      issues: [
        { severity: "nit", description: "naming", path: "src/a.ts", line: 3 },
        { severity: "nit", description: "comment", path: null, line: null },
      ],
    }),
  ];
  const history = reviewHistory({
    verdicts,
    attempts: [
      { id: "attempt-review", agentId: "agent-reviewer" },
    ] as AttemptRecord[],
    agents: [
      { id: "agent-reviewer", name: "Claude Opus 4.8" },
    ] as AgentRecord[],
  });
  assert.deepEqual(
    history.map((entry) => entry.id),
    ["rev-2", "rev-1"],
  );
  assert.equal(history[0]!.label, "Approve");
  assert.equal(history[0]!.blockers, 0);
  assert.equal(history[0]!.suggestions, 2);
  assert.equal(history[0]!.reviewer, "Claude Opus 4.8");
  // A later verdict's kind is preserved even when the reviewer field is absent.
  assert.equal(history[1]!.reviewer, "Claude Opus 4.8");
  assert.equal(history[1]!.reviewerSource, "reviewer attempt agent");
  assert.equal(history[1]!.issues[0]!.disposition, "blocker");
  assert.equal(history[1]!.issues[0]!.location, "src/parser.ts:42");
  assert.equal(history[1]!.issues[0]!.severity, "blocking");
});

test("decision facts never claim a pass that was not recorded", () => {
  const reviewCycle = reviewCycleView({
    reviewCycle: 2,
    policy: { maxReviewCycles: 2 },
  });
  const base = {
    reviewCycle,
    verdicts: [] as ReviewVerdictRecord[],
    attempts: [attempt("attempt-1", 1, "review", "passed")],
    tests: [testRun("t1", "attempt-1", "2026-09-22T10:00:00.000Z", 7)],
    agents: [{ id: "agent-reviewer", name: "Claude" }] as AgentRecord[],
  };
  const evidence = approvalEvidenceView({
    approval: { gate: "final_acceptance", reason: null, stageKey: "final" },
    ...base,
  })!;
  // Passing tests alone: the recorded verification status is what is reported,
  // and a verification recorded on another stage says where it came from.
  assert.equal(
    checksFact(evidence).label,
    "Latest verification: 7 tests passed",
  );
  assert.match(checksFact(evidence).detail!, /not on this gate's stage/);
  assert.ok(!/all checks passed/i.test(checksFact(evidence).label));

  const onGateStage = approvalEvidenceView({
    approval: { gate: "review_reject", reason: null, stageKey: "review" },
    ...base,
  })!;
  assert.equal(checksFact(onGateStage).label, "7 tests passed");
  assert.match(checksFact(onGateStage).detail!, /Command passed/);

  const failed = approvalEvidenceView({
    approval: { gate: "final_acceptance", reason: null, stageKey: "final" },
    ...base,
    attempts: [
      {
        ...attempt("attempt-1", 1, "review", "failed"),
      },
    ],
  })!;
  assert.match(checksFact(failed).label, /Verification failed/);

  const invalid = approvalEvidenceView({
    approval: { gate: "review_reject", reason: null, stageKey: "review" },
    ...base,
    verdicts: [
      verdictRecord({
        id: "rev-bad",
        cycle: 1,
        valid: false,
        validationErrors: ["verdict: expected one of APPROVE"],
        createdAt: "2026-09-22T10:00:00.000Z",
      }),
    ],
  })!;
  assert.equal(
    blockerFact(invalid).label,
    "Reviewer payload failed validation",
  );
  assert.equal(blockerFact(invalid).tone, "danger");
  assert.match(blockerFact(invalid).detail!, /unvalidated/);
});

test("changed-file counts come from the recorded paths, never a false zero", () => {
  assert.equal(changedFilesView({}).count, null);
  assert.equal(changedFilesView({}).label, "Changed files UNKNOWN");
  // The dogfood case: a stat that does not parse, but two recorded paths.
  const recorded = changedFilesView({
    snapshot: {
      id: "s1",
      runId: "run-1",
      stageKey: "implement",
      attemptId: null,
      phase: "after",
      headSha: null,
      branch: "main",
      detached: false,
      dirty: true,
      stagedPaths: [],
      unstagedPaths: ["greeting.mjs", "greeting.test.mjs"],
      untrackedPaths: [],
      diffStat: "+40 / −1",
      localCommits: [],
      ahead: null,
      behind: null,
      unavailableReason: null,
      capturedAt: "2026-09-22T10:05:00.000Z",
    },
  });
  assert.equal(recorded.count, 2);
  assert.equal(recorded.label, "2 files changed");
  // A parseable stat alone is still used when no paths were recorded.
  const statOnly = changedFilesView({
    diffStat: " 2 files changed, 10 insertions(+), 4 deletions(-)",
  });
  assert.equal(statOnly.count, 2);
  assert.equal(statOnly.label, "2 files changed");
  assert.equal(statOnly.detail, "+10 / −4");
  // An unparseable stat with no paths stays explicitly unknown.
  assert.equal(changedFilesView({ diffStat: "unavailable" }).count, null);
});

test("the decision sheet shows the latest tests of one attempt only", () => {
  const tests: TestRunRecord[] = Array.from({ length: 14 }, (_, index) =>
    testRun(
      `t${index}`,
      index < 7 ? "attempt-1" : "attempt-2",
      `2026-09-22T10:${String(index).padStart(2, "0")}:00.000Z`,
      index,
    ),
  );
  const view = latestTestsForAttempt(tests, "attempt-2", 7);
  assert.equal(view.rows.length, 7);
  assert.equal(view.hidden, 0);
  // Newest first, and only the correlated attempt's rows.
  assert.ok(view.rows.every((row) => /^t(7|8|9|1[0-3])$/.test(row.id)));
  assert.equal(view.rows[0]!.id, "t13");
  const capped = latestTestsForAttempt(tests, "attempt-2", 3);
  assert.equal(capped.rows.length, 3);
  assert.equal(capped.hidden, 4);
  assert.deepEqual(latestTestsForAttempt(tests, null), {
    rows: [],
    hidden: 0,
  });
});

test("a dormant skipped loop stage never contradicts a completed review", () => {
  const stages = [
    stage("plan", { status: "COMPLETED" }),
    stage("implement", { status: "COMPLETED" }),
    stage("verify", { status: "COMPLETED" }),
    stage("review", { status: "COMPLETED", cycle: 1 }),
    stage("review.fix", { status: "SKIPPED", skipReason: "not activated" }),
    stage("review.retest", {
      status: "SKIPPED",
      skipReason: "not activated",
    }),
  ];
  const milestones = buildRunMilestones(plan, stages, agents, "final_verify");
  const verify = milestones.find((entry) => entry.name === "Verify")!;
  const review = milestones.find((entry) => entry.name === "Review")!;
  // The re-verification loop stage belongs to Review only — Verify must not
  // report the loop's own skip beside the completed verification.
  assert.deepEqual(
    verify.stages.map((entry) => entry.key),
    ["verify"],
  );
  assert.equal(verify.state, "complete");
  assert.equal(verify.statusWord, "Completed");
  assert.deepEqual(
    review.stages.map((entry) => entry.key),
    ["review", "review.fix", "review.retest"],
  );
  assert.equal(review.state, "complete");
  assert.equal(
    review.statusWord,
    "Completed",
    "a skipped dormant fix stage does not label the review as skipped",
  );
});

test("role mapping only covers agent-backed stages", () => {
  const roles = planRoleOptions(plan);
  assert.deepEqual(
    roles.map((entry) => entry.role),
    ["implementer", "planner", "reviewer"],
  );
  // Verification runs commands and final acceptance is human: neither is mappable.
  assert.ok(
    !roles.some((entry) => entry.role === "verifier" || entry.role === "human"),
  );
  const rows = planRows(plan);
  assert.equal(rows.length, plan.stages.length);
  assert.equal(rows.filter((row) => row.branching).length, 2);
});

/* --------------------------------- diff -------------------------------- */

test("line diff reports real additions and removals", () => {
  const diff = diffLines("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(
    diff.map((line) => line.kind),
    ["same", "remove", "add", "same", "add"],
  );
  assert.equal(diff[0]!.text, "a");
  assert.equal(diffLines("", "").length, 0);
  assert.deepEqual(
    diffLines("", "x").map((line) => line.kind),
    ["add"],
  );
  assert.deepEqual(
    diffLines("x", "").map((line) => line.kind),
    ["remove"],
  );
});

test("prompt comparison pairs attempts of the same task only", () => {
  const comparisons = promptComparisons([
    {
      id: "a1",
      taskId: "t1",
      stageKey: "implement",
      attemptNumber: 1,
      previousAttemptId: null,
      promptText: "do the thing",
    },
    {
      id: "a2",
      taskId: "t1",
      stageKey: "implement",
      attemptNumber: 2,
      previousAttemptId: "a1",
      promptText: "do the thing\nwith the fix",
    },
    {
      id: "b1",
      taskId: "t2",
      stageKey: "review",
      attemptNumber: 1,
      previousAttemptId: null,
      promptText: "review it",
    },
  ]);
  assert.equal(comparisons.length, 1);
  const comparison = comparisons[0]!;
  assert.equal(comparison.attemptNumber, 2);
  assert.equal(comparison.previousAttemptNumber, 1);
  assert.equal(comparison.changed, true);
  assert.equal(comparison.addedLines, 1);
  assert.equal(comparison.removedLines, 0);
  assert.equal(comparison.previousPrompt, "do the thing");
});

test("unified diff classification keeps every input line", () => {
  const diff = [
    "diff --git a/x b/x",
    "index 111..222 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    " context",
    "-old",
    "+new",
  ].join("\n");
  const lines = classifyDiff(diff);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["meta", "meta", "meta", "meta", "hunk", "context", "remove", "add"],
  );
  assert.equal(lines[5]!.text, "context");
  assert.equal(lines[6]!.leftLine, 2);
  assert.equal(lines[7]!.rightLine, 2);
  assert.deepEqual(classifyDiff(""), []);
});

test("diff stat parsing is null-safe and never invents counts", () => {
  assert.equal(parseDiffStats(null), null);
  assert.equal(parseDiffStats("   "), null);
  const stats = parseDiffStats(
    [
      " src/a.ts | 4 ++--",
      " src/b.ts | 2 ++",
      " 2 files changed, 5 insertions(+), 2 deletions(-)",
    ].join("\n"),
  )!;
  assert.equal(stats.files.length, 2);
  assert.equal(stats.files[0]!.path, "src/a.ts");
  assert.equal(stats.files[0]!.insertions, 2);
  assert.equal(stats.files[0]!.deletions, 2);
  assert.equal(stats.filesChanged, 2);
  assert.equal(stats.insertions, 5);
  assert.equal(stats.deletions, 2);
});

/* ------------------------------ snapshots ------------------------------ */

test("snapshot view exposes UNKNOWN for null divergence and stats", () => {
  const snapshot: GitSnapshotRecord = {
    id: "snap-1",
    runId: "run-1",
    stageKey: "implement",
    attemptId: "attempt-1",
    phase: "after",
    headSha: "abcdef0123456789",
    branch: null,
    detached: true,
    dirty: true,
    stagedPaths: ["a.ts"],
    unstagedPaths: ["b.ts"],
    untrackedPaths: ["c.ts"],
    diffStat: null,
    localCommits: [{ sha: "abcdef0123456789", subject: "fixture" }],
    ahead: null,
    behind: null,
    unavailableReason: null,
    capturedAt: "2026-09-22T10:00:00.000Z",
  };
  const view = snapshotView(snapshot);
  assert.equal(view.head, "abcdef01");
  assert.equal(view.branch, "detached HEAD");
  assert.equal(view.dirtyLabel, "dirty");
  assert.equal(view.staged + view.unstaged + view.untracked, 3);
  assert.equal(view.ahead, UNKNOWN);
  assert.equal(view.diffStats, null);
  assert.deepEqual(view.changedPaths, ["a.ts", "b.ts", "c.ts"]);
});

/* --------------------------- tests / commands -------------------------- */

test("test counts are only reported when parsed confidently", () => {
  const unparsed: TestRunRecord = {
    id: "t1",
    runId: "run-1",
    taskId: null,
    attemptId: null,
    stageKey: "verify",
    framework: "node:test",
    status: "unknown",
    passed: null,
    failed: null,
    skipped: null,
    total: null,
    parsedConfidently: false,
    summary: null,
    durationMs: null,
    createdAt: "2026-09-22T10:00:00.000Z",
  };
  assert.match(
    testCountsLabel(unparsed),
    /Test count unavailable \(counts not parsed confidently\)/,
  );
  assert.equal(
    testCountsLabel({
      ...unparsed,
      parsedConfidently: true,
      passed: 12,
      failed: 1,
      skipped: 0,
      total: 13,
    }),
    "12 passed / 1 failed / 13 total",
  );
});

test("command display quotes arguments and never builds a shell string", () => {
  assert.equal(commandLine({ executable: "npm", args: ["test"] }), "npm test");
  assert.equal(
    commandLine({ executable: "node", args: ["--test", "a b"] }),
    "node --test 'a b'",
  );
  assert.equal(shellQuoteArgument("plain"), "plain");
  assert.equal(shellQuoteArgument("it's"), `'it'\\''s'`);
});

test("a passed command with unparsed counts still reads as passed", () => {
  assert.equal(TEST_COUNT_UNAVAILABLE, "Test count unavailable");
  assert.equal(
    verificationLabel({
      status: "passed",
      summary: "command exited 0",
      counts: null,
    }),
    "Command passed · Test count unavailable",
  );
  assert.equal(
    verificationLabel({
      status: "failed",
      summary: "command exited 1",
      counts: null,
    }),
    "Command failed · Test count unavailable",
  );
  assert.equal(
    verificationLabel({
      status: "passed",
      summary: "7 tests",
      counts: { passed: 7, failed: 0, skipped: 0, total: 7 },
    }),
    "Command passed · 7/7 passed",
  );
  assert.equal(
    verificationLabel({
      status: "unavailable",
      summary: "no commands configured",
      counts: null,
    }),
    "verification unavailable · no commands configured",
  );
  assert.equal(verificationLabel(null), `verification ${UNKNOWN}`);
  assert.equal(verificationCountsLabel(null), TEST_COUNT_UNAVAILABLE);
  assert.equal(
    verificationCountsLabel({ passed: 12, failed: 1, total: 13 }),
    "12 passed / 1 failed / 13 total",
  );
});

/* --------------------- review cycle and reviewer identity --------------- */

test("the run review counter matches the rail's fix-cycle numbering", () => {
  // A fresh run is on review pass 1; the store seeds review_cycle = 1.
  const fresh = reviewCycleView({
    reviewCycle: 1,
    policy: { maxReviewCycles: 2 },
  });
  assert.equal(fresh.cycle, 1);
  assert.equal(fresh.used, 0);
  assert.equal(fresh.exhausted, false);
  assert.equal(fresh.label, "review cycle 1 of 2");

  // After the first fix loop the run is on pass 2 while exactly one fix cycle
  // ran — the rail's loop counter and `used` therefore agree.
  const afterFixes = reviewCycleView({
    reviewCycle: 2,
    policy: { maxReviewCycles: 2 },
  });
  assert.equal(afterFixes.cycle, 2);
  assert.equal(afterFixes.used, 1);
  assert.equal(afterFixes.exhausted, true);
  assert.equal(afterFixes.label, "review cycle 2 of 2");
  assert.equal(fixLoopCycleLabel(1, 2), "fixes from review cycle 1 of 2");
  assert.equal(fixLoopCycleLabel(0, 2), "no fix cycle has run yet (max 2)");
  // Out-of-range values are clamped rather than shown as a contradiction.
  assert.equal(
    reviewCycleView({ reviewCycle: 7, policy: { maxReviewCycles: 2 } }).cycle,
    2,
  );
});

test("reviewer identity resolves to a plain name and never invents one", () => {
  const agents = [{ id: "agt_7d58", name: "Claude Opus 4.8" }];
  assert.equal(reviewerName("agt_7d58", agents), "Claude Opus 4.8");
  assert.equal(reviewerName("Claude Opus 4.8", agents), "Claude Opus 4.8");
  assert.equal(reviewerName(null, agents), "reviewer not recorded");
  assert.equal(reviewerName("   ", agents), "reviewer not recorded");
  assert.equal(reviewerName(undefined), "reviewer not recorded");
});

/* ------------------------------ search/home ---------------------------- */

test("run search params map the form onto the API query contract", () => {
  const params = buildRunSearchParams({
    ...EMPTY_RUN_SEARCH,
    q: "parser",
    projectId: "p1",
    status: "FAILED",
    branch: "feature/x",
    verdict: "REJECT",
    from: "2026-09-01",
    to: "2026-09-22",
  });
  assert.equal(params["q"], "parser");
  assert.equal(params["projectId"], "p1");
  assert.equal(params["status"], "FAILED");
  assert.equal(params["branch"], "feature/x");
  assert.equal(params["verdict"], "REJECT");
  assert.equal(
    params["from"],
    new Date("2026-09-01T00:00:00.000").toISOString(),
  );
  assert.equal(params["to"], new Date("2026-09-22T23:59:59.999").toISOString());
  assert.equal(serializeQuery(buildRunSearchParams(EMPTY_RUN_SEARCH)), "");
  assert.match(serializeQuery(params), /^\?/);
});

test("client-side run matching mirrors the server filters", () => {
  const record = {
    ...run("FAILED", "2026-09-22T12:00:00.000Z"),
    branch: "main",
    lastReviewVerdict: "REJECT" as const,
  };
  assert.equal(runMatchesSearch(record, EMPTY_RUN_SEARCH), true);
  assert.equal(
    runMatchesSearch(record, { ...EMPTY_RUN_SEARCH, status: "COMPLETED" }),
    false,
  );
  assert.equal(
    runMatchesSearch(record, { ...EMPTY_RUN_SEARCH, branch: "other" }),
    false,
  );
  assert.equal(
    runMatchesSearch(record, { ...EMPTY_RUN_SEARCH, verdict: "REJECT" }),
    true,
  );
  assert.equal(
    runMatchesSearch(record, { ...EMPTY_RUN_SEARCH, agentId: "agent-impl" }),
    true,
  );
  assert.equal(
    runMatchesSearch(record, { ...EMPTY_RUN_SEARCH, from: "2026-09-23" }),
    false,
  );
});

test("home summary keeps only actionable sections and counts attention", () => {
  const runs = [
    run("RUNNING", "2026-09-22T12:00:00.000Z", "r1"),
    run("WAITING_APPROVAL", "2026-09-22T11:00:00.000Z", "r2"),
    run("WAITING_INPUT", "2026-09-22T10:00:00.000Z", "r3"),
    run("FAILED", "2026-09-22T09:00:00.000Z", "r4"),
    run("COMPLETED", "2026-09-22T08:00:00.000Z", "r5"),
    run("CANCELLED", "2026-09-22T07:00:00.000Z", "r6"),
    run("DRAFT", "2026-09-22T06:00:00.000Z", "r7"),
  ];
  const summary = homeSummary(runs);
  // Gates and failures both mean "an operator has to do something" — newest
  // first, and never double-counted with the running list.
  assert.deepEqual(
    summary.needsYou.map((entry) => entry.id),
    ["r2", "r3", "r4"],
  );
  assert.deepEqual(
    summary.running.map((entry) => entry.id),
    ["r1"],
  );
  assert.deepEqual(
    summary.recent.map((entry) => entry.id),
    ["r5", "r6", "r7"],
  );
  assert.equal(summary.attention, 4);
  // The attention sentence names the unit, never a bare count.
  assert.equal(
    summary.attentionLabel,
    "3 runs need your attention · 1 running",
  );

  const quiet = homeSummary([runs[4]!]);
  assert.deepEqual(quiet.needsYou, []);
  assert.deepEqual(quiet.running, []);
  assert.equal(quiet.attention, 0);
  assert.equal(quiet.attentionLabel, "Nothing needs you right now");

  const runningOnly = homeSummary([runs[0]!]);
  assert.equal(
    runningOnly.attentionLabel,
    "Nothing needs you right now · 1 running",
  );

  const single = homeSummary([runs[1]!]);
  assert.equal(single.attentionLabel, "1 run needs your attention");

  // The greeting is deterministic from the clock the caller supplies.
  assert.equal(greetingFor(new Date("2026-09-22T02:00:00")), "Still up");
  assert.equal(greetingFor(new Date("2026-09-22T09:00:00")), "Good morning");
  assert.equal(greetingFor(new Date("2026-09-22T14:00:00")), "Good afternoon");
  assert.equal(greetingFor(new Date("2026-09-22T20:00:00")), "Good evening");
});

test("the home states persisted evidence for a blocked row, or nothing", () => {
  const base = {
    reviewCycle: 1,
    policy: { maxReviewCycles: 2 },
    failureReason: null,
    interruptReason: null,
    pendingApproval: null,
    reviewVerdicts: [],
    attempts: [],
    tests: [],
    agents: [],
    events: [],
  };

  // A gate states who reviewed and what the verification recorded, using the
  // same durable verdict→attempt→agent path the run screen uses.
  const gate = runEvidenceLine({
    ...base,
    status: "WAITING_APPROVAL",
    pendingApproval: {
      gate: "review_reject",
      reason: null,
      stageKey: "review",
    },
    attempts: [attempt("attempt-review", 1, "review", "passed")],
    tests: [testRun("test-1", "attempt-review", "2026-09-22T10:05:00.000Z", 7)],
    agents: [{ id: "agent-impl", name: "Claude Opus 4.8" }],
    reviewVerdicts: [
      verdictRecord({ id: "verdict-1", verdict: "REJECT", cycle: 1 }),
    ],
  });
  assert.equal(gate, "Claude Opus 4.8 rejected · 7 tests passed");

  // No verdict and no verification: absent evidence is not "clean".
  assert.equal(
    runEvidenceLine({
      ...base,
      status: "WAITING_APPROVAL",
      pendingApproval: {
        gate: "final_acceptance",
        reason: null,
        stageKey: "human",
      },
    }),
    null,
  );

  // The agent's own question, verbatim, is the input gate's evidence.
  const question = runEvidenceLine({
    ...base,
    status: "WAITING_INPUT",
    attempts: [
      {
        ...attempt("attempt-1", 1, "implement", null),
        status: "WAITING_INPUT",
      },
    ],
    events: [
      event(1, {
        type: "agent.waiting",
        payload: { message: "Which branch should I target?" },
      }),
    ],
  });
  assert.equal(question, "Agent asked: Which branch should I target?");

  // A failed run states its recorded reason; with no reason, the last
  // verification outcome stands in, and with neither the answer is null.
  assert.equal(
    runEvidenceLine({
      ...base,
      status: "FAILED",
      failureReason: "verification command exited 1",
    }),
    "verification command exited 1",
  );
  assert.equal(
    runEvidenceLine({
      ...base,
      status: "FAILED",
      attempts: [attempt("attempt-verify", 1, "verify", "passed")],
      tests: [
        testRun("test-2", "attempt-verify", "2026-09-22T10:06:00.000Z", 5),
      ],
    }),
    "Command passed · 5/5 passed",
  );
  assert.equal(runEvidenceLine({ ...base, status: "FAILED" }), null);

  // Long records are truncated rather than wrapped or silently dropped.
  const long = runEvidenceLine({
    ...base,
    status: "FAILED",
    failureReason: "x".repeat(400),
  })!;
  assert.ok(
    long.length <= EVIDENCE_MAX,
    `expected truncation, got ${long.length}`,
  );
  assert.match(long, /…$/);
});

test("a blocked row's state word comes from the persisted gate", () => {
  // The gate decides the word: a final acceptance gate is not a generic wait.
  assert.equal(
    attentionStateLabel({
      status: "WAITING_APPROVAL",
      gate: "final_acceptance",
    }),
    "Ready for final approval",
  );
  assert.equal(
    attentionStateLabel({ status: "WAITING_APPROVAL", gate: "review_reject" }),
    "Changes requested",
  );
  assert.equal(
    attentionStateLabel({
      status: "WAITING_APPROVAL",
      gate: "review_cycle_exhausted",
    }),
    "Fix cycles exhausted",
  );
  assert.equal(
    attentionStateLabel({ status: "WAITING_APPROVAL", gate: "some_new_gate" }),
    "Ready for review",
  );
  assert.equal(
    attentionStateLabel({ status: "WAITING_INPUT", gate: null }),
    "Needs your input",
  );
  // Nothing known: the row keeps the run's own status word instead of guessing.
  assert.equal(
    attentionStateLabel({ status: "WAITING_APPROVAL", gate: null }),
    null,
  );
  assert.equal(attentionStateLabel({ status: "FAILED", gate: null }), null);
  assert.equal(attentionStateLabel({ status: "RUNNING", gate: null }), null);
});

test("a running row names the stage and the agent from the run's own plan", () => {
  const record = run("RUNNING", "2026-09-22T12:00:00.000Z", "r1");
  assert.equal(
    activeRowDetail({
      nextStageKey: record.nextStageKey,
      plan: record.plan,
      roleMapping: record.roleMapping,
      agentNames: { "agent-impl": "Claude Opus 4.8" },
    }),
    "Implementation · Claude Opus 4.8",
  );
  // An agent that no longer exists is shown by its id, never a made-up name.
  assert.equal(
    activeRowDetail({
      nextStageKey: "implement",
      plan: record.plan,
      roleMapping: { implementer: "agent-gone" },
      agentNames: {},
    }),
    "Implementation · agent-gone",
  );
  // Nothing to resolve: no line at all, so the row keeps its status word.
  assert.equal(
    activeRowDetail({
      nextStageKey: null,
      plan: record.plan,
      roleMapping: {},
    }),
    null,
  );
  assert.equal(
    activeRowDetail({
      nextStageKey: "not-in-this-plan",
      plan: record.plan,
      roleMapping: {},
    }),
    null,
  );
});

/* -------------------------------- routing ------------------------------ */

test("hash routes round-trip and reject unknown paths", () => {
  assert.deepEqual(parseRoute("#/"), { view: "home" });
  assert.deepEqual(parseRoute("#/nonsense"), { view: "home" });
  assert.deepEqual(parseRoute("#/projects/p1"), {
    view: "projects",
    projectId: "p1",
  });
  assert.deepEqual(parseRoute("#/run/r9"), { view: "run", runId: "r9" });
  assert.equal(parseRoute("#/run").view, "runs");
  const runsRoute = parseRoute("#/runs?q=parser&status=FAILED");
  assert.equal(runsRoute.view, "runs");
  assert.equal(runsRoute.view === "runs" ? runsRoute.search.q : null, "parser");
  assert.equal(routeHref({ view: "run", runId: "r 9" }), "#/run/r%209");
  assert.equal(routeHref({ view: "new-run", projectId: null }), "#/new-run");
  const href = routeHref({
    view: "runs",
    search: { ...EMPTY_RUN_SEARCH, q: "a b" },
  });
  const roundTripped = parseRoute(href);
  assert.equal(roundTripped.view, "runs");
  assert.equal(
    roundTripped.view === "runs" ? roundTripped.search.q : null,
    "a b",
  );
});

/* --------------------------------- forms ------------------------------- */

test("verification arguments must be a JSON array, never a shell string", () => {
  assert.deepEqual(parseArgsJson('["test", "--runInBand"]'), {
    ok: true,
    args: ["test", "--runInBand"],
  });
  assert.deepEqual(parseArgsJson(""), { ok: true, args: [] });
  assert.equal(parseArgsJson("npm test").ok, false);
  assert.equal(parseArgsJson('{"a":1}').ok, false);
  assert.equal(parseArgsJson('["ok", 3]').ok, false);
  assert.equal(parseArgsJson('["ok", "a\u0000b"]').ok, false);
  assert.equal(parseArgsJson("not json").ok, false);
});

test("project form validation rejects relative paths and duplicate command kinds", () => {
  const good = validateProjectForm({
    ...EMPTY_PROJECT_FORM,
    name: "AgentOps",
    path: "/Users/x/code/agentops",
    verificationCommands: [
      { name: "test", executable: "npm", argsJson: '["test"]' },
    ],
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok ? good.value.verificationCommands[0] : null, {
    name: "test",
    executable: "npm",
    args: ["test"],
  });

  const relative = validateProjectForm({
    ...EMPTY_PROJECT_FORM,
    name: "x",
    path: "code/agentops",
  });
  assert.equal(relative.ok, false);
  assert.ok(relative.ok === false && relative.errors["path"]);

  const duplicate = validateProjectForm({
    ...EMPTY_PROJECT_FORM,
    name: "x",
    path: "/tmp/x",
    verificationCommands: [
      { name: "test", executable: "npm", argsJson: '["test"]' },
      { name: "test", executable: "pnpm", argsJson: '["test"]' },
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.ok(
    duplicate.ok === false && duplicate.errors["verificationCommands.1.name"],
  );

  const badKind = validateProjectForm({
    ...EMPTY_PROJECT_FORM,
    name: "x",
    path: "/tmp/x",
    verificationCommands: [
      { name: "deploy", executable: "npm", argsJson: "[]" },
    ],
  });
  assert.equal(badKind.ok, false);
  assert.ok(
    badKind.ok === false && badKind.errors["verificationCommands.0.name"],
  );

  const shellString = validateProjectForm({
    ...EMPTY_PROJECT_FORM,
    name: "x",
    path: "/tmp/x",
    verificationCommands: [
      {
        name: "test",
        executable: "npm test && rm -rf /",
        argsJson: "npm test",
      },
    ],
  });
  assert.equal(shellString.ok, false);
  assert.ok(
    shellString.ok === false &&
      shellString.errors["verificationCommands.0.args"],
  );
});

test("project path helper warns about relative and duplicate roots", () => {
  const projects: ProjectRecord[] = [
    {
      id: "p1",
      name: "Existing",
      canonicalRoot: "/tmp/existing",
      vcs: "git",
      defaultBranch: "main",
      verificationCommands: [],
      settings: { allowedAdapters: ["mock"], notes: "hello" },
      archived: false,
      createdAt: "2026-09-22T09:00:00.000Z",
      updatedAt: "2026-09-22T09:00:00.000Z",
    },
  ];
  assert.match(
    projectPathHint(projects, "/tmp/existing")!,
    /Already registered/,
  );
  assert.match(
    projectPathHint(projects, "relative/path")!,
    /Relative paths are rejected/,
  );
  assert.match(
    projectPathHint(projects, "/tmp/other")!,
    /Symlink and traversal escapes are rejected/,
  );
  assert.equal(projectPathHint(projects, "  "), null);
  assert.deepEqual(projectAllowedAdapters(projects[0]!), ["mock"]);
  assert.deepEqual(
    projectAllowedAdapters({
      ...projects[0]!,
      settings: { allowedAdapters: "mock" },
    }),
    [],
  );
});

test("agent form validation encodes manual mode, mock scenario and the Hermes one-shot opt-in", () => {
  const mock = validateAgentForm({
    ...EMPTY_AGENT_FORM,
    name: "Mock",
    scenario: "success",
  });
  assert.equal(mock.ok, true);
  assert.deepEqual(mock.ok ? mock.value.config : null, { scenario: "success" });

  const missingExecutable = validateAgentForm({
    ...EMPTY_AGENT_FORM,
    name: "Hermes",
    adapterKind: "hermes-opencode",
  });
  assert.equal(missingExecutable.ok, false);
  assert.ok(
    missingExecutable.ok === false && missingExecutable.errors["executable"],
  );

  const hermes = validateAgentForm({
    ...EMPTY_AGENT_FORM,
    name: "DeepSeek",
    adapterKind: "hermes-opencode",
    model: "deepseek-v4.1-flash",
    executable: "hermes",
    provider: "opencode-go",
    allowHermesOneshot: true,
  });
  assert.equal(hermes.ok, true);
  assert.deepEqual(hermes.ok ? hermes.value.config : null, {
    executable: "hermes",
    provider: "opencode-go",
    allowHermesOneshot: true,
  });

  const manual = validateAgentForm({
    ...EMPTY_AGENT_FORM,
    name: "Human",
    adapterKind: "generic-cli",
    manual: true,
  });
  assert.equal(manual.ok, true);
  assert.deepEqual(manual.ok ? manual.value.config : null, { manual: true });

  const badScenario = validateAgentForm({
    ...EMPTY_AGENT_FORM,
    name: "Mock",
    scenario: "explode",
  });
  assert.equal(badScenario.ok, false);
  assert.ok(badScenario.ok === false && badScenario.errors["scenario"]);
});

test("agent presets pre-fill the form without claiming availability", () => {
  assert.equal(AGENT_PRESETS.length, 4);
  const astra = AGENT_PRESETS.find((preset) => preset.id === "astra-codex")!;
  assert.equal(astra.form.model, "gpt-6-astra");
  assert.match(astra.caveat, /Verify the model ID/);
  const hermes = AGENT_PRESETS.find(
    (preset) => preset.id === "deepseek-hermes",
  )!;
  assert.equal(hermes.form.allowHermesOneshot, false);
  assert.match(hermes.caveat, /bypass/);
  const claude = AGENT_PRESETS.find((preset) => preset.id === "claude-opus")!;
  assert.equal(claude.form.model, "claude-opus-5");
  for (const preset of AGENT_PRESETS) {
    const result = validateAgentForm(preset.form);
    assert.equal(
      result.ok,
      true,
      `${preset.id} must validate: ${JSON.stringify(result.ok ? {} : result.errors)}`,
    );
  }
});

test("agent records round-trip through the edit form", () => {
  const form = agentToForm(agents[0]!);
  assert.equal(form.adapterKind, "hermes-opencode");
  assert.equal(form.provider, "opencode-go");
  assert.equal(form.manual, false);
  assert.equal(agentStateLabel(agents[0]!), "configured, enabled");
  assert.equal(
    agentStateLabel({ ...agents[0]!, config: { manual: true } }),
    "manual handoff",
  );
  assert.equal(
    agentStateLabel({ ...agents[0]!, enabled: false }),
    "configured, disabled",
  );
  const roundTripped = validateAgentForm(form);
  assert.equal(roundTripped.ok, true);
  assert.equal(
    roundTripped.ok ? roundTripped.value.config["provider"] : null,
    "opencode-go",
  );
});

test("artifact registration rejects escaping paths", () => {
  assert.equal(
    validateArtifactForm({ path: "reports/run.md", kind: "report" }).ok,
    true,
  );
  assert.equal(
    validateArtifactForm({ path: "/etc/passwd", kind: "report" }).ok,
    false,
  );
  assert.equal(
    validateArtifactForm({ path: "../outside.txt", kind: "report" }).ok,
    false,
  );
  assert.equal(validateArtifactForm({ path: "ok.txt", kind: "" }).ok, false);
  const artifact: ArtifactRecord = {
    id: "a1",
    runId: "run-1",
    taskId: null,
    attemptId: null,
    stageKey: "implement",
    path: "reports/run.md",
    kind: "report",
    creator: "agent",
    exists: true,
    sizeBytes: null,
    note: null,
    createdAt: "2026-09-22T10:00:00.000Z",
  };
  assert.equal(artifactView(artifact).size, UNKNOWN);
  assert.equal(artifactView(artifact).exists, "present");
});

test("new run validation requires every agent-backed role and a goal", () => {
  const requiredRoles = planRoleOptions(plan).map((entry) => entry.role);
  const missing = validateNewRunForm(
    {
      projectId: "p1",
      templateId: "implement-review",
      goal: "",
      constraintsText: "",
      roleMapping: {},
    },
    requiredRoles,
    ["agent-impl"],
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.ok === false && missing.errors["goal"]);
  assert.ok(missing.ok === false && missing.errors["roleMapping.implementer"]);

  const complete = validateNewRunForm(
    {
      projectId: "p1",
      templateId: "implement-review",
      goal: "  do it  ",
      constraintsText: "no new deps\n\n  keep it minimal  ",
      roleMapping: {
        planner: "agent-impl",
        implementer: "agent-impl",
        reviewer: "agent-impl",
      },
    },
    requiredRoles,
    ["agent-impl"],
  );
  assert.equal(complete.ok, true);
  assert.equal(complete.ok ? complete.value.goal : null, "do it");
  assert.deepEqual(complete.ok ? complete.value.constraints : null, [
    "no new deps",
    "keep it minimal",
  ]);

  const unknownAgent = validateNewRunForm(
    {
      projectId: "p1",
      templateId: "implement-review",
      goal: "x",
      constraintsText: "",
      roleMapping: { implementer: "nope", reviewer: "agent-impl" },
    },
    requiredRoles,
    ["agent-impl"],
  );
  assert.equal(unknownAgent.ok, false);
});

/* ------------------------------- approvals ----------------------------- */

test("approval decisions follow the server allow-list and demand instructions", () => {
  const finalGate = {
    id: "ap1",
    runId: "run-1",
    stageKey: "final",
    taskId: null,
    attemptId: null,
    gate: "final_acceptance" as const,
    status: "PENDING" as const,
    allowed: ["approve", "reject"] as const,
    reason: null,
    requestedAt: "2026-09-22T10:00:00.000Z",
    decision: null,
    instruction: null,
    actor: null,
    decidedAt: null,
  };
  const options = approvalDecisionOptions({
    ...finalGate,
    allowed: [...finalGate.allowed],
  });
  assert.deepEqual(
    options.map((option) => option.decision),
    ["approve", "reject"],
  );
  assert.equal(options[0]!.requiresInstruction, false);
  assert.equal(options[1]!.requiresInstruction, true);
  // The final human gate reads as an explicit acceptance, not a generic
  // "approve".
  assert.equal(options[0]!.label, "Accept run");
  assert.match(options[0]!.detail, /final human gate/);
  // Only reason-requiring decisions carry reason copy.
  assert.equal(options[0]!.reasonLabel, null);
  assert.equal(options[0]!.reasonHelp, null);
  assert.equal(options[1]!.reasonLabel, "Reason for rejecting");
  assert.match(options[1]!.reasonHelp!, /Mandatory/);

  const rejectGate = approvalDecisionOptions({
    ...finalGate,
    gate: "review_reject",
    allowed: ["override", "retry", "reject"],
  });
  assert.deepEqual(
    rejectGate.map((option) => option.decision),
    ["retry", "override", "reject"],
  );
  const override = rejectGate.find((option) => option.decision === "override")!;
  assert.equal(override.label, "Override rejection and continue");
  assert.match(override.detail, /cannot skip final verification/);
  assert.equal(override.requiresInstruction, true);
  assert.equal(override.reasonLabel, "Reason for overriding the rejection");
  assert.match(override.reasonHelp!, /Mandatory/);
  assert.ok(
    !rejectGate.some((option) => /Reject with override/.test(option.label)),
    "the contradictory 'Reject with override' copy is gone",
  );
  // A non-final gate keeps the plain approve wording.
  assert.equal(
    approvalDecisionOptions({
      ...finalGate,
      gate: "review_reject",
      allowed: ["approve", "reject"],
    })[0]!.label,
    "Approve",
  );

  assert.equal(validateDecision("approve", "", options).ok, true);
  const rejected = validateDecision("reject", "   ", options);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.ok === false && rejected.errors["instruction"]);
  assert.equal(validateDecision("override", "take it", options).ok, false);
  assert.equal(approvalDecisionOptions(null).length, 0);
});

test("approval evidence is read from the persisted record", () => {
  const evidence = approvalEvidenceView({
    approval: {
      gate: "review_reject",
      reason: "reviewer rejected the work: human decision required",
      stageKey: "review",
    },
    reviewCycle: reviewCycleView({
      reviewCycle: 2,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [
      {
        id: "rev-1",
        runId: "run-1",
        taskId: "task-review",
        attemptId: "attempt-1",
        stageKey: "review",
        cycle: 1,
        valid: true,
        validationErrors: [],
        verdict: "REJECT",
        summary: "the parser drops empty input",
        issues: [
          {
            severity: "blocking",
            description: "empty input throws",
            path: "src/parser.ts",
            line: 42,
          },
        ],
        confidence: 0.4,
        reviewer: null,
        raw: "{}",
        createdAt: "2026-09-22T11:00:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "review",
        agentId: "agt_reviewer",
        reviewVerdictId: "rev-1",
        verification: {
          status: "passed",
          mode: "commands",
          commandCount: 1,
          counts: null,
          summary: "1 command exited 0",
          reason: null,
        },
      },
    ],
    tests: [
      {
        attemptId: "attempt-1",
        framework: "node:test",
        passed: 7,
        failed: 0,
        skipped: 0,
        total: 7,
        parsedConfidently: true,
        createdAt: "2026-09-22T11:00:01.000Z",
      },
    ],
    agents: [{ id: "agt_reviewer", name: "Claude Opus 4.8" }],
  })!;
  assert.equal(evidence.gateLabel, "Review rejected — human decision required");
  assert.equal(evidence.stageKey, "review");
  assert.equal(evidence.cycle.label, "review cycle 2 of 2");
  assert.equal(evidence.verdict!.label, "Reject");
  assert.equal(evidence.verdict!.tone, "danger");
  assert.equal(evidence.verdict!.stageKey, "review");
  // The real payloads omit `reviewer`, but the verdict records the attempt that
  // produced it — that recorded relationship names the reviewer.
  assert.equal(evidence.verdict!.reviewer, "Claude Opus 4.8");
  assert.equal(evidence.verdict!.reviewerSource, "reviewer attempt agent");
  assert.equal(evidence.verdict!.issues[0]!.location, "src/parser.ts:42");
  // The persisted verification has counts: null, while the normalized test run
  // for the same attempt was parsed confidently: the counts are used, never
  // invented, and the source is reported.
  assert.equal(evidence.verification!.label, "Command passed · 7/7 passed");
  assert.equal(evidence.verification!.countsSource, "normalized test run");
  assert.equal(evidence.verification!.framework, "node:test");
  assert.equal(evidence.verification!.attemptNumber, 1);
  assert.equal(evidence.verification!.stageKey, "review");
  assert.equal(evidence.verification!.onGateStage, true);

  // Without a confidently parsed row for that attempt the counts stay absent.
  const unparsed = approvalEvidenceView({
    approval: {
      gate: "review_reject",
      reason: null,
      stageKey: "review",
    },
    reviewCycle: reviewCycleView({
      reviewCycle: 1,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "review",
        agentId: "agt_reviewer",
        reviewVerdictId: null,
        verification: {
          status: "passed",
          mode: "commands",
          commandCount: 1,
          counts: null,
          summary: "1 command exited 0",
          reason: null,
        },
      },
    ],
    tests: [
      {
        attemptId: "attempt-1",
        framework: "node:test",
        passed: null,
        failed: null,
        skipped: null,
        total: null,
        parsedConfidently: false,
        createdAt: "2026-09-22T11:00:01.000Z",
      },
    ],
  })!;
  assert.equal(
    unparsed.verification!.label,
    "Command passed · Test count unavailable",
  );
  assert.equal(unparsed.verification!.countsSource, "none");
  assert.equal(unparsed.verdict, null);

  // The final acceptance gate is opened by the human stage itself: the evidence
  // falls back to the last verification the run recorded and says where it came
  // from instead of claiming there is none.
  const finalEvidence = approvalEvidenceView({
    approval: { gate: "final_acceptance", reason: null, stageKey: "final" },
    reviewCycle: reviewCycleView({
      reviewCycle: 1,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [],
    attempts: [
      {
        id: "attempt-2",
        attemptNumber: 1,
        stageKey: "final_verify",
        agentId: null,
        reviewVerdictId: null,
        verification: {
          status: "passed",
          mode: "commands",
          commandCount: 1,
          counts: null,
          summary: "1 command exited 0",
          reason: null,
        },
      },
    ],
    tests: [
      {
        attemptId: "attempt-2",
        framework: "node:test",
        passed: 7,
        failed: 0,
        skipped: 0,
        total: 7,
        parsedConfidently: true,
        createdAt: "2026-09-22T12:00:00.000Z",
      },
      // A stale row for a different attempt must never be counted.
      {
        attemptId: "attempt-1",
        framework: "node:test",
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 4,
        parsedConfidently: true,
        createdAt: "2026-09-22T11:00:00.000Z",
      },
    ],
  })!;
  assert.equal(finalEvidence.verdict, null);
  assert.equal(finalEvidence.verification!.stageKey, "final_verify");
  assert.equal(finalEvidence.verification!.onGateStage, false);
  assert.equal(
    finalEvidence.verification!.label,
    "Command passed · 7/7 passed",
  );
  assert.equal(finalEvidence.verification!.countsSource, "normalized test run");

  // No approval record means no evidence block at all.
  assert.equal(
    approvalEvidenceView({
      approval: null,
      reviewCycle: reviewCycleView({
        reviewCycle: 1,
        policy: { maxReviewCycles: 2 },
      }),
      verdicts: [],
      attempts: [],
    }),
    null,
  );
});

test("the concise gate summary uses the durable reviewer and one verification attempt", () => {
  // The shape the real dogfood run persists: the verdict omits `reviewer`
  // (resolved through the verdict's attempt to the agent record), the review
  // carries two `nit` findings, and the run has TWO 7-test records (verify and
  // final_verify) which must never be added up to 14.
  const attempts = [
    {
      id: "att_verify",
      attemptNumber: 1,
      stageKey: "verify",
      agentId: null,
      reviewVerdictId: null,
      verification: {
        status: "passed" as const,
        mode: "commands",
        commandCount: 1,
        counts: null,
        summary: "test: 7 passed, 0 failed",
        reason: null,
      },
    },
    {
      id: "att_review",
      attemptNumber: 1,
      stageKey: "review",
      agentId: "agt_claude",
      reviewVerdictId: "rev-1",
      verification: null,
    },
    {
      id: "att_final_verify",
      attemptNumber: 1,
      stageKey: "final_verify",
      agentId: null,
      reviewVerdictId: null,
      verification: {
        status: "passed" as const,
        mode: "commands",
        commandCount: 1,
        counts: null,
        summary: "test: 7 passed, 0 failed",
        reason: null,
      },
    },
  ];
  const tests = [
    {
      attemptId: "att_verify",
      framework: "node:test",
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      parsedConfidently: true,
      createdAt: "2026-09-22T17:51:06.107Z",
    },
    {
      attemptId: "att_final_verify",
      framework: "node:test",
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      parsedConfidently: true,
      createdAt: "2026-09-22T17:51:22.176Z",
    },
  ];
  const evidence = approvalEvidenceView({
    // The final human gate: the gate stage itself is `final` and has no
    // verification of its own, so the evidence falls back to the newest
    // verification in the run and names it.
    approval: { gate: "final_acceptance", reason: null, stageKey: "final" },
    reviewCycle: reviewCycleView({
      reviewCycle: 1,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [
      {
        id: "rev-1",
        runId: "run-1",
        taskId: "task-review",
        attemptId: "att_review",
        stageKey: "review",
        cycle: 1,
        valid: true,
        validationErrors: [],
        verdict: "APPROVE",
        summary: "greeting.mjs implements exactly the requested validation.",
        issues: [
          {
            severity: "nit",
            description: "TypeError message for null reads 'received object'.",
            path: "greeting.mjs",
            line: 3,
          },
          {
            severity: "nit",
            description: "Tests assert the error class but not the message.",
            path: "greeting.test.mjs",
            line: 8,
          },
        ],
        confidence: 0.93,
        reviewer: null,
        raw: "{}",
        createdAt: "2026-09-22T17:51:21.716Z",
      },
    ],
    attempts,
    tests,
    agents: [{ id: "agt_claude", name: "Claude" }],
  })!;

  // Identity comes from the recorded attempt, not from a missing field.
  assert.equal(evidence.verdict!.reviewer, "Claude");
  assert.equal(evidence.verdict!.reviewerSource, "reviewer attempt agent");
  assert.match(
    reviewerProvenanceLabel({
      name: "Claude",
      source: "reviewer attempt agent",
      agentId: "agt_claude",
    }),
    /resolved through the verdict's attempt \(agt_claude\)/,
  );
  // Two `nit` findings are two suggestions, and the severity word survives.
  assert.equal(evidence.verdict!.tally.label, "2 suggestions");
  assert.equal(evidence.verdict!.tally.blockers, 0);
  assert.deepEqual(
    evidence.verdict!.issues.map((issue) => issueDisposition(issue.severity)),
    ["suggestion", "suggestion"],
  );
  assert.equal(evidence.verdict!.issues[0]!.location, "greeting.mjs:3");
  // One verification attempt, never a sum of the two 7-test records.
  assert.equal(evidence.verification!.stageKey, "final_verify");
  assert.equal(evidence.verification!.shortLabel, "7 tests passed");
  assert.equal(
    approvalSummaryLine(evidence),
    "Claude approved · 7 tests passed",
  );

  // The gate with no verdict and no verification says so plainly, without
  // boilerplate about a reason that was never recorded.
  const bare = approvalEvidenceView({
    approval: { gate: "review_reject", reason: null, stageKey: "review" },
    reviewCycle: reviewCycleView({
      reviewCycle: 2,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [],
    attempts: [],
  })!;
  assert.equal(
    approvalSummaryLine(bare),
    "No review verdict recorded for this gate · No verification recorded",
  );
  assert.equal(bare.reason, null);
});

test("issue dispositions and short verification labels stay honest about counts", () => {
  assert.equal(issueDisposition("blocking"), "blocker");
  assert.equal(issueDisposition("BLOCKING"), "blocker");
  assert.equal(issueDisposition("blocking "), "blocker");
  for (const severity of ["major", "minor", "nit", "cosmetic"])
    assert.equal(issueDisposition(severity), "suggestion");
  assert.deepEqual(
    issueTally([
      { severity: "blocking" },
      { severity: "nit" },
      { severity: "minor" },
    ]),
    {
      blockers: 1,
      suggestions: 2,
      empty: false,
      label: "1 blocker · 2 suggestions",
    },
  );
  assert.equal(issueTally([]).empty, true);
  assert.equal(issueTally([]).label, "No issues recorded");

  // A single test is not "1 tests"; a failed count is reported as a fraction.
  assert.equal(
    verificationShortLabel({
      status: "passed",
      counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
    }),
    "1 test passed",
  );
  assert.equal(
    verificationShortLabel({
      status: "failed",
      counts: { passed: 5, failed: 2, skipped: 0, total: 7 },
    }),
    "5 of 7 tests passed",
  );
  // Counts that were never parsed are absent, not zero.
  assert.equal(
    verificationShortLabel({ status: "passed", counts: null }),
    "Command passed, test count unavailable",
  );
});

test("the operator input gate shows the agent's own question", () => {
  const requested = pendingInputQuestion({
    events: [
      {
        id: 1,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-1",
        stageKey: "implement",
        category: "input",
        type: "input.requested",
        actor: "agent",
        payload: { summary: "Which environment should I target?" },
        createdAt: "2026-09-22T10:00:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "implement",
        status: "WAITING_INPUT",
        resultSummary: "waiting for operator input",
      },
    ],
  });
  assert.equal(requested.text, "Which environment should I target?");
  assert.equal(requested.source, "input.requested");
  assert.equal(requested.attemptNumber, 1);
  assert.equal(requested.stageKey, "implement");

  const waitingEvent = pendingInputQuestion({
    events: [
      {
        id: 2,
        projectId: null,
        runId: "run-1",
        taskId: null,
        attemptId: "attempt-2",
        stageKey: "implement",
        category: "agent",
        type: "agent.waiting",
        actor: "agent",
        payload: { message: "Should I overwrite the fixture?" },
        createdAt: "2026-09-22T10:05:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-2",
        attemptNumber: 2,
        stageKey: "implement",
        status: "WAITING_INPUT",
        resultSummary: "waiting",
      },
    ],
  });
  assert.equal(waitingEvent.text, "Should I overwrite the fixture?");
  assert.equal(waitingEvent.source, "agent.waiting");

  // The agent's own waiting message wins over the engine's wrapper summary, and
  // the question is scoped to the attempt that is actually waiting: attempt 1's
  // stale question must never be shown for attempt 2.
  const scopedToWaitingAttempt = pendingInputQuestion({
    events: [
      {
        id: 3,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-1",
        stageKey: "implement",
        category: "input",
        type: "input.requested",
        actor: "agent",
        payload: {
          summary:
            "mock agent is waiting for operator input: Which environment should I target?",
        },
        createdAt: "2026-09-22T10:00:00.000Z",
      },
      {
        id: 4,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-1",
        stageKey: "implement",
        category: "agent",
        type: "agent.waiting",
        actor: "agent",
        payload: { message: "Which environment should I target?" },
        createdAt: "2026-09-22T10:00:01.000Z",
      },
      {
        id: 5,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-2",
        stageKey: "implement",
        category: "agent",
        type: "agent.waiting",
        actor: "agent",
        payload: { message: "Should I keep the retry history?" },
        createdAt: "2026-09-22T10:10:00.000Z",
      },
      {
        id: 6,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-2",
        stageKey: "implement",
        category: "input",
        type: "input.requested",
        actor: "agent",
        payload: {
          summary:
            "mock agent is waiting for operator input: Should I keep the retry history?",
        },
        createdAt: "2026-09-22T10:10:01.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "implement",
        status: "COMPLETED",
        resultSummary: "attempt 1 finished",
      },
      {
        id: "attempt-2",
        attemptNumber: 2,
        stageKey: "implement",
        status: "WAITING_INPUT",
        resultSummary: "waiting",
      },
    ],
  });
  assert.equal(scopedToWaitingAttempt.text, "Should I keep the retry history?");
  assert.equal(scopedToWaitingAttempt.source, "agent.waiting");
  assert.equal(scopedToWaitingAttempt.attemptNumber, 2);
  assert.equal(scopedToWaitingAttempt.stageKey, "implement");

  // With no waiting attempt, the newest persisted input request is still shown
  // with the attempt that produced it (an already-answered gate).
  const answered = pendingInputQuestion({
    events: [
      {
        id: 7,
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-implement",
        attemptId: "attempt-1",
        stageKey: "implement",
        category: "input",
        type: "input.requested",
        actor: "agent",
        payload: { summary: "Which environment should I target?" },
        createdAt: "2026-09-22T10:00:00.000Z",
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "implement",
        status: "COMPLETED",
        resultSummary: "attempt 1 finished",
      },
    ],
  });
  assert.equal(answered.text, "Which environment should I target?");
  assert.equal(answered.attemptNumber, 1);

  const fromSummary = pendingInputQuestion({
    events: [],
    attempts: [
      {
        id: "attempt-1",
        attemptNumber: 1,
        stageKey: "implement",
        status: "WAITING_INPUT",
        resultSummary: "mock agent is waiting for operator input: pick a port",
      },
    ],
  });
  assert.equal(
    fromSummary.text,
    "mock agent is waiting for operator input: pick a port",
  );
  assert.equal(fromSummary.source, "attempt summary");

  const nothing = pendingInputQuestion({ events: [], attempts: [] });
  assert.equal(nothing.text, "");
  assert.equal(nothing.source, "none");
});

test("reviewer identity resolves through the recorded verdict attempt", () => {
  const agents = [{ id: "agt_7d58", name: "Claude Opus 4.8" }];
  const attempts = [{ id: "attempt-9", agentId: "agt_7d58" }];
  // Real payload: no reviewer string, but the verdict records its attempt.
  assert.deepEqual(
    reviewerIdentity({
      reviewer: null,
      attemptId: "attempt-9",
      attempts,
      agents,
    }),
    {
      name: "Claude Opus 4.8",
      source: "reviewer attempt agent",
      agentId: "agt_7d58",
    },
  );
  // The verdict field wins when it is present and resolves.
  assert.deepEqual(
    reviewerIdentity({
      reviewer: "agt_7d58",
      attemptId: "attempt-9",
      attempts,
      agents,
    }),
    { name: "Claude Opus 4.8", source: "verdict field", agentId: "agt_7d58" },
  );
  // An unresolvable field is shown verbatim, never replaced.
  assert.deepEqual(
    reviewerIdentity({ reviewer: "Claude Opus 4.8", attempts, agents }),
    { name: "Claude Opus 4.8", source: "verdict field", agentId: null },
  );
  // An attempt whose agent is unknown still names the recorded agent id.
  assert.deepEqual(
    reviewerIdentity({
      attemptId: "attempt-9",
      attempts: [{ id: "attempt-9", agentId: "agt_missing" }],
      agents,
    }),
    {
      name: "agt_missing",
      source: "reviewer attempt agent",
      agentId: "agt_missing",
    },
  );
  // Nothing recorded stays explicitly absent.
  assert.deepEqual(
    reviewerIdentity({ attemptId: "attempt-1", attempts, agents }),
    {
      name: "reviewer not recorded",
      source: "none",
      agentId: null,
    },
  );
});

test("attempt counts prefer the record and fall back to the normalized test run", () => {
  const verification = {
    status: "passed" as const,
    mode: "commands",
    commandCount: 1,
    counts: null,
    summary: "1 command exited 0",
    reason: null,
  };
  const tests = [
    {
      attemptId: "attempt-1",
      framework: "node:test",
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      parsedConfidently: true,
      createdAt: "2026-09-22T11:00:00.000Z",
    },
    {
      attemptId: "attempt-2",
      framework: "vitest",
      passed: 9,
      failed: 1,
      skipped: 0,
      total: 10,
      parsedConfidently: true,
      createdAt: "2026-09-22T12:00:00.000Z",
    },
  ];
  const fromTests = attemptCountsView({
    attemptId: "attempt-1",
    verification,
    tests,
  });
  assert.deepEqual(fromTests.counts, {
    passed: 7,
    failed: 0,
    skipped: 0,
    total: 7,
  });
  assert.equal(fromTests.source, "normalized test run");
  assert.equal(fromTests.framework, "node:test");
  // Another attempt's rows are never counted.
  assert.equal(
    attemptCountsView({ attemptId: "attempt-3", verification, tests }).counts,
    null,
  );
  // The persisted record wins when it carries counts.
  const fromRecord = attemptCountsView({
    attemptId: "attempt-1",
    verification: {
      ...verification,
      counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
    },
    tests,
  });
  assert.equal(fromRecord.source, "verification record");
  assert.deepEqual(fromRecord.counts, {
    passed: 1,
    failed: 0,
    skipped: 0,
    total: 1,
  });
  assert.equal(
    attemptCountsView({ attemptId: "attempt-1", verification: null, tests: [] })
      .source,
    "none",
  );
});

test("retry and cancel reasons are mandatory", () => {
  assert.equal(validateRetryForm({ reason: "   ", instruction: "" }).ok, false);
  const retry = validateRetryForm({
    reason: " flaky test ",
    instruction: "  fix it ",
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.ok ? retry.value : null, {
    reason: "flaky test",
    instruction: "fix it",
  });
  assert.equal(
    validateRetryForm({ reason: "ok", instruction: "" }).ok && true,
    true,
  );
  assert.equal(validateCancelReason("  ").ok, false);
  assert.equal(validateCancelReason("user stopped it").ok, true);
});
