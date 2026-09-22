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
  EventRecord,
  GitSnapshotRecord,
  ProjectRecord,
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
  UNKNOWN,
  agentStateLabel,
  agentToForm,
  approvalDecisionOptions,
  artifactView,
  buildRunSearchParams,
  buildStageRail,
  categoryCounts,
  classifyDiff,
  commandLine,
  diffLines,
  eventMessage,
  eventsForRun,
  filterEvents,
  formatBytes,
  formatCount,
  formatDuration,
  homeSections,
  lastEventId,
  mergeEvents,
  parseArgsJson,
  parseDiffStats,
  parseRoute,
  planRoleOptions,
  planRows,
  projectAllowedAdapters,
  projectPathHint,
  promptComparisons,
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
} from "../src/ui/view-model.js";

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
  assert.equal(statusLabel("WAITING_APPROVAL"), "WAITING FOR YOU");
  assert.equal(statusTone("WAITING_APPROVAL"), "warn");
  assert.equal(statusTone("RUNNING"), "active");
  assert.equal(statusTone("COMPLETED"), "success");
  assert.equal(statusTone("FAILED"), "danger");
  assert.equal(statusTone("SKIPPED"), "warn");
  assert.equal(statusLabel("SOMETHING_NEW"), "SOMETHING_NEW");
  assert.equal(verdictLabel(null, false), "INVALID VERDICT PAYLOAD");
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

/* ------------------------------ stage rail ----------------------------- */

test("stage rail separates the spine from the review/fix branch", () => {
  const stages = [
    stage("implement", {
      status: "COMPLETED",
      attemptCount: 1,
      summary: "done",
    }),
    stage("verify", { status: "COMPLETED" }),
    stage("review", {
      status: "WAITING_APPROVAL",
      cycle: 1,
      attemptCount: 2,
      overridden: true,
    }),
    stage("review.fix", { status: "COMPLETED", cycle: 1, attemptCount: 1 }),
    stage("review.retest", { status: "RUNNING", cycle: 1 }),
  ];
  const rail = buildStageRail(
    plan,
    stages,
    [task("implement")],
    agents,
    "review",
  );
  assert.deepEqual(
    rail.spine.map((node) => node.key),
    ["plan", "implement", "verify", "review", "final_verify", "final"],
  );
  assert.equal(rail.loops.length, 1);
  const loop = rail.loops[0]!;
  assert.equal(loop.reviewStageKey, "review");
  assert.deepEqual(
    loop.nodes.map((node) => node.loopPhase),
    ["fix", "retest"],
  );
  assert.equal(loop.activated, true);
  assert.equal(loop.maxReviewCycles, 2);
  assert.equal(loop.cycle, 1);
  const reviewNode = rail.spine.find((node) => node.key === "review")!;
  assert.equal(reviewNode.isCurrent, true);
  assert.equal(reviewNode.overridden, true);
  assert.equal(reviewNode.agentName, null);
  const implementNode = rail.spine.find((node) => node.key === "implement")!;
  assert.equal(implementNode.agentName, "DeepSeek V4.1 Flash");
  assert.equal(implementNode.attemptCount, 1);
  assert.deepEqual(rail.progress, { completed: 2, total: 6 });
});

test("a dormant loop branch is reported as dormant", () => {
  const rail = buildStageRail(
    plan,
    [stage("implement", { status: "RUNNING" })],
    [],
    agents,
    "implement",
  );
  const loop = rail.loops[0]!;
  assert.equal(loop.activated, false);
  assert.equal(loop.cycle, 0);
  assert.deepEqual(rail.progress, { completed: 0, total: 6 });
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
    /UNKNOWN \(counts not parsed confidently\)/,
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

test("home sections place each run in exactly one bucket", () => {
  const runs = [
    run("RUNNING", "2026-09-22T12:00:00.000Z", "r1"),
    run("WAITING_APPROVAL", "2026-09-22T11:00:00.000Z", "r2"),
    run("WAITING_INPUT", "2026-09-22T10:00:00.000Z", "r3"),
    run("FAILED", "2026-09-22T09:00:00.000Z", "r4"),
    run("COMPLETED", "2026-09-22T08:00:00.000Z", "r5"),
    run("CANCELLED", "2026-09-22T07:00:00.000Z", "r6"),
    run("DRAFT", "2026-09-22T06:00:00.000Z", "r7"),
  ];
  const sections = homeSections(runs);
  assert.deepEqual(
    sections.active.map((entry) => entry.id),
    ["r1"],
  );
  assert.deepEqual(
    sections.waiting.map((entry) => entry.id),
    ["r2", "r3"],
  );
  assert.deepEqual(
    sections.failed.map((entry) => entry.id),
    ["r4"],
  );
  assert.deepEqual(
    sections.recent.map((entry) => entry.id),
    ["r5", "r6", "r7"],
  );
  const total =
    sections.active.length +
    sections.waiting.length +
    sections.failed.length +
    sections.recent.length;
  assert.equal(total, runs.length);
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

  const rejectGate = approvalDecisionOptions({
    ...finalGate,
    gate: "review_reject",
    allowed: ["override", "retry", "reject"],
  });
  assert.deepEqual(
    rejectGate.map((option) => option.decision),
    ["retry", "override", "reject"],
  );
  assert.match(
    rejectGate.find((option) => option.decision === "override")!.label,
    /override/i,
  );
  assert.match(
    rejectGate.find((option) => option.decision === "override")!.detail,
    /cannot skip final verification/,
  );

  assert.equal(validateDecision("approve", "", options).ok, true);
  const rejected = validateDecision("reject", "   ", options);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.ok === false && rejected.errors["instruction"]);
  assert.equal(validateDecision("override", "take it", options).ok, false);
  assert.equal(approvalDecisionOptions(null).length, 0);
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
