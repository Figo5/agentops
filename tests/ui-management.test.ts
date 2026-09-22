/**
 * Unit tests for the management view-models: projects, agents, history, the
 * guided workflow and the device settings report.
 *
 * These are the pure decisions behind the screens, so they are asserted without
 * a browser: what a project header may claim about a branch, what an agent row
 * may claim about access, which runs a quick filter keeps, what a history row
 * shows, which wizard step is incomplete, and what the settings screen may say
 * about the local service.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRecord,
  ProjectRecord,
  RunRecord,
} from "../src/core/types.js";
import { buildStagePlan, builtinTemplate } from "../src/core/templates.js";
import {
  POLICY_ACKNOWLEDGEMENTS,
  WIZARD_STEPS,
  agentRowView,
  agentTechnicalRows,
  filterByQuickFilters,
  firstIncompleteStep,
  historyRowView,
  localServiceView,
  matchesQuickFilter,
  projectBranchState,
  projectRunSummary,
  projectTechnicalRows,
  runDurationMs,
  runNeedsHuman,
  runOutcomeLabel,
  searchSummary,
  wizardStepErrors,
  waitingStateLabel,
  type WizardInput,
} from "../src/ui/management.js";
import { formatTimestamp, relativeTime } from "../src/ui/view-model.js";

const project: ProjectRecord = {
  id: "project-1",
  name: "Greeting fixture",
  canonicalRoot: "/tmp/greeting",
  vcs: "git",
  defaultBranch: "main",
  verificationCommands: [{ name: "test", executable: "npm", args: ["test"] }],
  settings: {},
  archived: false,
  createdAt: "2026-09-20T09:00:00.000Z",
  updatedAt: "2026-09-20T09:00:00.000Z",
};

/** The shipped template's plan, so plan-derived copy is tested for real. */
const realPlan = buildStagePlan(builtinTemplate("implement-review")!);

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: project.id,
    projectRoot: project.canonicalRoot,
    templateId: "implement-review",
    templateVersion: 1,
    goal: "Add input validation",
    constraints: [],
    status: "RUNNING",
    roleMapping: { implementer: "agent-1" },
    policy: {
      templateId: "implement-review",
      templateVersion: 1,
      maxReviewCycles: 2,
      requireVerification: true,
      finalApprovalRequired: true,
      stopOnFailure: true,
      roleMapping: { implementer: "agent-1" },
      verificationCommands: [],
      gitPolicy: "read-only",
      stoppingRule: "stop at human gates",
    },
    plan: realPlan,
    nextStageKey: "implement",
    currentAttemptId: null,
    reviewCycle: 1,
    epoch: 0,
    failureReason: null,
    cancelReason: null,
    interruptReason: null,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:30:00.000Z",
    startedAt: "2026-09-22T10:05:00.000Z",
    endedAt: null,
    ...patch,
  };
}

test("a project branch line only claims what was recorded or fetched", () => {
  // Nothing recorded and nothing fetched: say so instead of inventing a branch.
  const bare = projectBranchState({ defaultBranch: null }, null);
  assert.equal(bare.branch, null);
  assert.equal(bare.clean, null);
  assert.equal(bare.label, "Branch not recorded");

  // A registered default branch is a recorded fact; cleanliness is not.
  const recorded = projectBranchState({ defaultBranch: "main" }, null);
  assert.equal(recorded.label, "main");
  assert.equal(recorded.clean, null);
  assert.match(recorded.detail ?? "", /has not been read yet/);

  // A fetched snapshot supplies both, and it wins over the record.
  const fetched = projectBranchState(
    { defaultBranch: "main" },
    { branch: "feature/x", head: "abcdef0123456789", dirty: false },
  );
  assert.equal(fetched.label, "feature/x · clean");
  assert.equal(fetched.clean, true);

  const dirty = projectBranchState(
    { defaultBranch: "main" },
    { head: null, branch: "feature/x", dirty: true },
  );
  assert.equal(dirty.label, "feature/x · dirty");
});

test("a project header states its active or latest run outcome, or says nothing ran", () => {
  const empty = projectRunSummary([]);
  assert.equal(empty.active, null);
  assert.equal(empty.latest, null);
  assert.match(empty.outcome, /No run has been started/);

  const running = run({ id: "run-running", status: "RUNNING" });
  const done = run({
    id: "run-done",
    status: "COMPLETED",
    updatedAt: "2026-09-22T12:00:00.000Z",
    endedAt: "2026-09-22T11:00:00.000Z",
  });
  const summary = projectRunSummary([running, done]);
  // The newest *unfinished* run is what the project is doing now, even though
  // the completed run has the later timestamp.
  assert.equal(summary.active?.id, "run-running");
  assert.equal(summary.latest?.id, "run-done");
  assert.match(summary.outcome, /Running now/);

  const failed = projectRunSummary([
    run({ status: "FAILED", failureReason: "verification failed" }),
  ]);
  assert.match(failed.outcome, /Failed · verification failed/);

  const waiting = projectRunSummary([run({ status: "WAITING_INPUT" })]);
  assert.match(waiting.outcome, /Waiting for your input/);

  const draft = projectRunSummary([
    run({ status: "DRAFT", startedAt: null, endedAt: null }),
  ]);
  assert.match(draft.outcome, /Draft, not started/);
});

test("run duration comes from the recorded start and end, never from a guess", () => {
  assert.equal(runDurationMs(run()), null);
  assert.equal(
    runDurationMs(
      run({
        startedAt: "2026-09-22T10:00:00.000Z",
        endedAt: "2026-09-22T10:02:30.000Z",
      }),
    ),
    150_000,
  );
  // An end before the start is not a duration.
  assert.equal(
    runDurationMs(
      run({
        startedAt: "2026-09-22T10:02:00.000Z",
        endedAt: "2026-09-22T10:00:00.000Z",
      }),
    ),
    null,
  );
  assert.equal(
    runDurationMs(
      run({ startedAt: null, endedAt: "2026-09-22T10:00:00.000Z" }),
    ),
    null,
  );
});

test("technical project facts keep ids, root and storage out of the main line", () => {
  const rows = projectTechnicalRows(project, null);
  const keys = rows.map(([key]) => key);
  assert.ok(keys.includes("Project ID"));
  assert.ok(keys.includes("Canonical root"));
  assert.ok(keys.includes("Storage"));
  assert.equal(
    rows.find(([key]) => key === "Canonical root")?.[1],
    "/tmp/greeting",
  );
  // A snapshot that was never fetched contributes no snapshot rows.
  assert.ok(!keys.includes("Snapshot HEAD"));
  const withSnapshot = projectTechnicalRows(project, {
    head: "abc123",
    branch: "main",
    error: "git unavailable",
  });
  assert.ok(withSnapshot.some(([key]) => key === "Snapshot HEAD"));
  assert.ok(withSnapshot.some(([key]) => key === "Snapshot error"));
});

test("an agent row is configuration: a glyph, a role, a neutral readiness", () => {
  const agent: AgentRecord = {
    id: "agent-1",
    name: "deepseek worker",
    roleHint: "implementer",
    adapterKind: "hermes-opencode",
    model: "deepseek-v4.1-flash",
    effort: "high",
    enabled: true,
    config: {
      executable: "hermes",
      args: ["--print"],
      provider: "opencode-go",
      allowHermesOneshot: false,
    },
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T09:00:00.000Z",
  };
  const row = agentRowView(agent);
  assert.equal(row.initial, "D");
  assert.equal(row.role, "Worker");
  assert.equal(row.secondary, "Hermes · deepseek-v4.1-flash · high effort");
  assert.equal(row.editLabel, "Edit deepseek worker");
  // Access is never asserted as verified, and the tone is never a success tone.
  assert.match(row.readiness, /configured/);
  assert.notEqual(row.readinessTone, "success");
  assert.equal(row.readinessTone, "muted");

  // An installed CLI still reads "access unchecked" and stays neutral.
  const installed = agentRowView({
    ...agent,
    availability: "INSTALLED",
  } as never);
  assert.equal(installed.readiness, "CLI installed · access unchecked");
  assert.equal(installed.readinessTone, "muted");

  // Only a recorded problem is a problem.
  const unavailable = agentRowView({
    ...agent,
    availability: "UNAVAILABLE",
  } as never);
  assert.equal(unavailable.readinessTone, "danger");

  // Missing pieces are stated, never defaulted to a plausible value.
  const bare = agentRowView({
    ...agent,
    name: "",
    roleHint: null,
    model: null,
    effort: null,
  });
  assert.equal(bare.initial, "?");
  assert.equal(bare.role, "role not set");
  assert.equal(bare.secondary, "Hermes · model not set");
  // The persisted identifiers are still shown, in the technical rows.
  const technical = agentTechnicalRows(agent);
  assert.ok(
    technical.some(([key, value]) => key === "Agent ID" && value === "agent-1"),
  );
  assert.ok(
    technical.some(
      ([key, value]) => key === "Adapter kind" && value === "hermes-opencode",
    ),
  );
  assert.ok(
    technical.some(
      ([key, value]) => key === "Role hint" && value === "implementer",
    ),
  );
  assert.ok(
    technical.some(
      ([key, value]) => key === "Hermes one-shot" && /not enabled/.test(value),
    ),
  );
});

test("quick filters keep exactly the runs they name", () => {
  const now = new Date("2026-09-22T15:00:00.000Z").getTime();
  const today = run({
    id: "today",
    status: "COMPLETED",
    createdAt: "2026-09-22T09:00:00.000Z",
  });
  const thisWeek = run({
    id: "week",
    status: "FAILED",
    createdAt: "2026-09-20T09:00:00.000Z",
  });
  const older = run({
    id: "old",
    status: "CANCELLED",
    createdAt: "2026-09-01T09:00:00.000Z",
  });
  const blocked = run({
    id: "blocked",
    status: "WAITING_APPROVAL",
    createdAt: "2026-09-22T08:00:00.000Z",
  });
  const all = [today, thisWeek, older, blocked];

  assert.deepEqual(
    filterByQuickFilters(all, [], now).map((entry) => entry.id),
    ["today", "week", "old", "blocked"],
  );
  assert.deepEqual(
    filterByQuickFilters(all, ["completed"], now).map((entry) => entry.id),
    ["today"],
  );
  assert.deepEqual(
    filterByQuickFilters(all, ["failed"], now).map((entry) => entry.id),
    ["week"],
  );
  assert.deepEqual(
    filterByQuickFilters(all, ["today"], now).map((entry) => entry.id),
    ["today", "blocked"],
  );
  assert.deepEqual(
    filterByQuickFilters(all, ["this_week"], now).map((entry) => entry.id),
    ["today", "week", "blocked"],
  );
  assert.deepEqual(
    filterByQuickFilters(all, ["needs_me"], now).map((entry) => entry.id),
    ["week", "blocked"],
  );
  // Filters compose as an intersection.
  assert.deepEqual(
    filterByQuickFilters(all, ["needs_me", "today"], now).map(
      (entry) => entry.id,
    ),
    ["blocked"],
  );
  assert.equal(runNeedsHuman({ status: "RUNNING" }), false);
  assert.equal(runNeedsHuman({ status: "INTERRUPTED" }), true);
  assert.equal(matchesQuickFilter(today, "completed", now), true);
});

test("a history row carries project, goal, outcome, when, duration, branch and agents", () => {
  const row = historyRowView(
    run({
      status: "FAILED",
      failureReason: "the verification command exited 1",
      startedAt: "2026-09-22T10:00:00.000Z",
      endedAt: "2026-09-22T10:00:45.000Z",
      branch: "feature/validation",
    } as never),
    {
      projectNames: { "project-1": "Greeting fixture" },
      agentNames: { "agent-1": "Deepseek worker" },
      now: new Date("2026-09-22T15:00:00.000Z").getTime(),
    },
  );
  assert.equal(row.project, "Greeting fixture");
  assert.equal(row.goal, "Add input validation");
  assert.match(row.outcome, /Failed · the verification command exited 1/);
  assert.equal(row.outcomeDetail, "the verification command exited 1");
  assert.equal(row.duration, "45.0 s");
  assert.equal(row.branch, "feature/validation");
  assert.equal(row.agents, "Worker: Deepseek worker");
  // Timestamps are rendered in local time, so the expectation is computed the
  // same way instead of hard-coding a zone.
  assert.equal(row.when, formatTimestamp("2026-09-22T10:00:00.000Z"));
  assert.equal(
    row.updated,
    relativeTime(
      "2026-09-22T10:30:00.000Z",
      new Date("2026-09-22T15:00:00.000Z").getTime(),
    ),
  );
  // Ids and raw timestamps live in the technical rows.
  assert.ok(
    row.technical.some(([key, value]) => key === "Run ID" && value === "run-1"),
  );
  assert.ok(row.technical.some(([key]) => key === "Project root"));

  // Nothing recorded reads as nothing recorded — and a run that is still going
  // is in progress rather than missing a duration.
  const bare = historyRowView(
    run({ status: "RUNNING", startedAt: null, endedAt: null }),
    { projectNames: {}, agentNames: {}, now: Date.now() },
  );
  assert.equal(bare.branch, "not recorded");
  assert.equal(bare.duration, "In progress");
  assert.equal(bare.outcomeDetail, null);
  // An unresolvable project keeps its id rather than inventing a name.
  assert.equal(bare.project, "project-1");

  // A finished run with no recorded timestamps shows a quiet dash.
  const finished = historyRowView(
    run({ status: "CANCELLED", startedAt: null, endedAt: null }),
    { projectNames: {}, agentNames: {}, now: Date.now() },
  );
  assert.equal(finished.duration, "—");

  // The verdict reads as a word, and a raw enum never reaches the row.
  const rejected = historyRowView(
    run({ status: "WAITING_APPROVAL", lastReviewVerdict: "REJECT" } as never),
    { projectNames: {}, agentNames: {}, now: Date.now() },
  );
  assert.equal(rejected.outcomeDetail, "Rejected");
  assert.equal(rejected.outcome, "Ready for review · Rejected");
  assert.equal(
    rejected.technical.find(([key]) => key === "Verdict")?.[1],
    "REJECT",
    "the persisted enum stays in the technical rows",
  );
  // An accepted run does not repeat its approval as a second half-sentence.
  const accepted = historyRowView(
    run({ status: "COMPLETED", lastReviewVerdict: "APPROVE" } as never),
    { projectNames: {}, agentNames: {}, now: Date.now() },
  );
  assert.equal(accepted.outcomeDetail, null);
  assert.equal(accepted.outcome, "Completed");
});

test("a waiting run's state word comes from its own frozen plan", () => {
  // The real frozen plan, so the assertion is about the shipped stage kinds.
  const plan = buildStagePlan(builtinTemplate("implement-review")!);
  const finalKey = plan.finalStageKey ?? "final";
  assert.equal(
    plan.stages.find((stage) => stage.key === finalKey)?.kind,
    "final_approval",
  );
  // The cursor on the human acceptance stage: the ask is to finish the run.
  assert.equal(
    waitingStateLabel({
      status: "WAITING_APPROVAL",
      nextStageKey: finalKey,
      plan,
    }),
    "Ready for final approval",
  );
  // Any other stage is a review…
  assert.equal(
    waitingStateLabel({
      status: "WAITING_APPROVAL",
      nextStageKey: "implement",
      plan,
    }),
    "Ready for review",
  );
  // …an unresolvable cursor keeps the generic word, and a run waiting on the
  // operator says what it is waiting for.
  assert.equal(
    waitingStateLabel({
      status: "WAITING_APPROVAL",
      nextStageKey: "gone",
      plan,
    }),
    "Waiting for you",
  );
  assert.equal(
    waitingStateLabel({
      status: "WAITING_INPUT",
      nextStageKey: null,
      plan,
    }),
    "Needs your input",
  );
  // A run that is not waiting keeps its own status word.
  assert.equal(
    waitingStateLabel({
      status: "COMPLETED",
      nextStageKey: null,
      plan,
    }),
    "Completed",
  );
});

test("the search summary states the filters in words, never a query string", () => {
  const parts = searchSummary(
    {
      q: "parser",
      projectId: "project-1",
      agentId: "agent-1",
      status: "FAILED",
      branch: "feature/x",
      verdict: "APPROVE_WITH_FIXES",
      from: "2026-09-01",
      to: "2026-09-22",
    },
    { "project-1": "Greeting fixture" },
    { "agent-1": "Deepseek worker" },
  );
  assert.deepEqual(parts, [
    "goal contains “parser”",
    "project Greeting fixture",
    "agent Deepseek worker",
    "status Failed",
    "branch “feature/x”",
    "verdict approve with fixes",
    "created on or after 2026-09-01",
    "created on or before 2026-09-22",
  ]);
  assert.ok(!parts.join(" ").includes("?"));
  assert.ok(!parts.join(" ").includes("="));
  assert.deepEqual(
    searchSummary(
      {
        q: "",
        projectId: "",
        agentId: "",
        status: "",
        branch: "",
        verdict: "",
        from: "",
        to: "",
      },
      {},
      {},
    ),
    [],
  );
});

test("the guided flow validates each step and cannot skip the acknowledgements", () => {
  const context = {
    requiredRoles: ["planner", "implementer"],
    availableAgentIds: ["agent-1", "agent-2"],
  };
  const base: WizardInput = {
    projectId: "project-1",
    goal: "",
    constraintsText: "",
    templateId: "implement-review",
    roleMapping: {},
    acknowledgements: [],
  };
  assert.deepEqual(Object.keys(wizardStepErrors("project", base, context)), [
    "goal",
  ]);
  assert.equal(
    Object.keys(wizardStepErrors("team", base, context)).length,
    2,
    "every required role is validated",
  );
  assert.deepEqual(
    Object.keys(wizardStepErrors("plan", base, context)),
    [],
    "a selected template passes the plan step",
  );
  assert.deepEqual(Object.keys(wizardStepErrors("policy", base, context)), [
    "acknowledgements",
  ]);

  const partial: WizardInput = {
    ...base,
    goal: "Add input validation",
    roleMapping: { planner: "agent-1", implementer: "agent-2" },
  };
  // A partially confirmed policy step is still incomplete.
  assert.equal(firstIncompleteStep(partial, context), "policy");
  assert.deepEqual(Object.keys(wizardStepErrors("review", partial, context)), [
    "acknowledgements",
  ]);

  const confirmed: WizardInput = {
    ...partial,
    acknowledgements: POLICY_ACKNOWLEDGEMENTS.map((entry) => entry.id),
  };
  assert.equal(firstIncompleteStep(confirmed, context), null);
  assert.deepEqual(
    Object.keys(wizardStepErrors("review", confirmed, context)),
    [],
  );

  // A role mapped to an agent that is no longer enabled is rejected.
  assert.match(
    wizardStepErrors(
      "team",
      {
        ...confirmed,
        roleMapping: { ...confirmed.roleMapping, planner: "gone" },
      },
      context,
    )["roleMapping.planner"] ?? "",
    /no longer enabled/,
  );

  // The steps are the five the brief names, in order.
  assert.deepEqual(
    WIZARD_STEPS.map((entry) => entry.label),
    [
      "Project & goal",
      "Team",
      "Plan",
      "Policy & approvals",
      "Review and start",
    ],
  );
});

test("the settings screen reports the real location and refuses to invent a data directory", () => {
  const view = localServiceView({
    location: { protocol: "http:", hostname: "127.0.0.1", port: "4317" },
    version: "1.0.0",
    reachable: true,
    error: null,
  });
  assert.equal(view.port, "4317");
  assert.equal(view.host, "127.0.0.1");
  assert.equal(view.status, "Connected");
  assert.match(view.statusDetail, /served by the local AgentOps server/);
  assert.notEqual(view.statusTone, "success");
  // The API exposes no data directory, so the screen says so instead of guessing.
  assert.equal(view.dataDirectory.available, false);
  assert.match(view.dataDirectory.label, /Not exposed/);
  assert.match(view.dataDirectory.detail, /no endpoint/);

  const unreachable = localServiceView({
    location: { protocol: "http:", hostname: "localhost", port: "" },
    version: null,
    reachable: false,
    error: "Cannot reach the AgentOps server",
  });
  assert.equal(
    unreachable.port,
    "80",
    "the default port is derived, not guessed",
  );
  assert.equal(unreachable.version, "UNKNOWN");
  assert.equal(unreachable.statusTone, "danger");
  assert.match(unreachable.statusDetail, /Cannot reach the AgentOps server/);
});
