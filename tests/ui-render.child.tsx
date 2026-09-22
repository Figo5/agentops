/**
 * Render harness for the UI (executed as a child process by
 * `ui-render.test.tsx`).
 *
 * Why a child process: `tsx` resolves JSX settings from the tsconfig of the
 * current working directory (the repo root, which has no `jsx` setting), while
 * Vite compiles the UI with `src/ui/tsconfig.json` (jsx: react-jsx). Running this
 * file with `TSX_TSCONFIG_PATH=src/ui/tsconfig.json` renders the components under
 * exactly the same JSX transform the browser build uses, without adding a
 * compatibility import to production files.
 *
 * It performs server-rendered markup assertions only: no DOM, no browser, no
 * click simulation. Fixtures below are synthetic test inputs; the application
 * ships no sample data.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentRecord,
  AttemptRecord,
  EventRecord,
  ProjectRecord,
  RunRecord,
  StageRecord,
  TaskRecord,
} from "../src/core/types.js";
import { buildStagePlan, builtinTemplate } from "../src/core/templates.js";
import type { Bootstrap } from "../src/ui/api.js";
import { App } from "../src/ui/App.js";
import { ActivityPanel } from "../src/ui/components/ActivityPanel.js";
import { ApprovalPanel } from "../src/ui/components/ApprovalPanel.js";
import { ClampedText, TabPanel, Tabs } from "../src/ui/components/Bits.js";
import { InputRequest } from "../src/ui/components/DecisionSheet.js";
import { Home } from "../src/ui/components/Home.js";
import { Nav } from "../src/ui/components/Nav.js";
import { OverviewPanel } from "../src/ui/components/OverviewPanel.js";
import { ReviewPanel } from "../src/ui/components/ReviewPanel.js";
import { RunProgress } from "../src/ui/components/RunProgress.js";
import { RunRow } from "../src/ui/components/RunRow.js";
import { VerificationPanel } from "../src/ui/components/VerificationPanel.js";
import type { RunDetailResponse } from "../src/ui/api.js";
import {
  approvalDecisionOptions,
  approvalEvidenceView,
  pendingInputQuestion,
  reviewCycleView,
} from "../src/ui/view-model.js";
import {
  buildRunMilestones,
  decisionFacts,
  runStateView,
} from "../src/ui/run-view.js";

const plan = buildStagePlan(builtinTemplate("implement-review")!);

const project: ProjectRecord = {
  id: "project-fixture",
  name: "Fixture project",
  canonicalRoot: "/tmp/fixture-project",
  vcs: "git",
  defaultBranch: "main",
  verificationCommands: [{ name: "test", executable: "npm", args: ["test"] }],
  settings: { allowedAdapters: ["mock"], notes: "fixture" },
  archived: false,
  createdAt: "2026-09-22T09:00:00.000Z",
  updatedAt: "2026-09-22T09:00:00.000Z",
};

const agent: AgentRecord = {
  id: "agent-fixture",
  name: "Fixture agent",
  roleHint: "implementer",
  adapterKind: "mock",
  model: null,
  effort: null,
  enabled: true,
  config: { scenario: "success" },
  createdAt: "2026-09-22T09:00:00.000Z",
  updatedAt: "2026-09-22T09:00:00.000Z",
};

function run(
  status: RunRecord["status"],
  id: string,
  goal: string,
  updatedAt: string,
): RunRecord {
  return {
    id,
    projectId: project.id,
    projectRoot: project.canonicalRoot,
    templateId: "implement-review",
    templateVersion: 1,
    goal,
    constraints: [],
    status,
    roleMapping: { implementer: agent.id },
    policy: {
      templateId: "implement-review",
      templateVersion: 1,
      maxReviewCycles: 2,
      requireVerification: true,
      finalApprovalRequired: true,
      stopOnFailure: true,
      roleMapping: { implementer: agent.id },
      verificationCommands: [
        { name: "test", executable: "npm", args: ["test"] },
      ],
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

function bootstrapFixture(runs: RunRecord[]): Bootstrap {
  return {
    token: "fixture-token",
    projects: [project],
    agents: [agent],
    templates: [
      {
        id: "implement-review",
        name: "Implement and review",
        description:
          "Implement a goal, verify it, review it, then require human final acceptance.",
        version: 1,
        builtin: true,
        defaultMaxReviewCycles: 2,
        createdAt: "2026-09-22T09:00:00.000Z",
        updatedAt: "2026-09-22T09:00:00.000Z",
        plan,
      },
    ],
    runs,
    version: "0.1.0-fixture",
  };
}

const emptyBootstrap: Bootstrap = {
  token: "fixture-token",
  projects: [],
  agents: [],
  templates: [],
  runs: [],
  version: "0.1.0-fixture",
};

function stage(
  key: string,
  status: StageRecord["status"],
  patch: Partial<StageRecord> = {},
): StageRecord {
  const entry = plan.stages.find((candidate) => candidate.key === key)!;
  return {
    id: `stage-${key}`,
    runId: "run-waiting",
    key,
    name: entry.name,
    kind: entry.kind,
    role: entry.role,
    agentId: null,
    orderIndex: entry.orderIndex,
    status,
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
    updatedAt: "2026-09-22T09:00:00.000Z",
    ...patch,
  };
}

const checks: { label: string; run: () => void }[] = [];
function check(label: string, body: () => void): void {
  checks.push({ label, run: body });
}

check("first-run empty state offers one useful action", () => {
  const markup = renderToStaticMarkup(
    Home({ bootstrap: emptyBootstrap }) as never,
  );
  assert.match(markup, /Add your first project/);
  assert.match(markup, />Add project</);
  // One action, and no inventory of empty categories.
  assert.ok(
    !/Configure agents|Start a workflow|No agents configured|Templates/.test(
      markup,
    ),
    "the first-run page is one concise action, not an inventory",
  );
  // The claim is about where the record lives, not about what an agent does:
  // real adapters contact their model provider.
  assert.match(markup, /Run history stays on this machine/);
  assert.ok(
    !/Everything an agent does/.test(markup),
    "no claim that an agent's work never leaves the machine",
  );
  assert.match(markup, /Nothing needs you right now/);
});

check(
  "dashboard groups runs into needs you, running and recent sections",
  () => {
    const bootstrap = bootstrapFixture([
      run(
        "WAITING_APPROVAL",
        "run-waiting",
        "Ship the review loop",
        "2026-09-22T12:00:00.000Z",
      ),
      run(
        "RUNNING",
        "run-active",
        "Refactor the rail",
        "2026-09-22T11:00:00.000Z",
      ),
      run("FAILED", "run-failed", "Broken fixture", "2026-09-22T10:30:00.000Z"),
      run("COMPLETED", "run-done", "Earlier work", "2026-09-22T09:30:00.000Z"),
    ]);
    const markup = renderToStaticMarkup(
      Home({
        bootstrap,
        now: new Date("2026-09-22T14:00:00.000Z"),
      }) as never,
    );
    // Time-appropriate greeting and the attention sentence: the unit is named,
    // never a bare count, and the project count is not repeated here.
    assert.match(markup, /class="page-title"/);
    assert.match(markup, /Good (morning|afternoon|evening)|Still up/);
    assert.match(markup, /2 runs need your attention · 1 running/);
    assert.ok(
      !/need you</.test(markup),
      "the attention sentence names the unit",
    );
    assert.ok(
      !/Mission control/.test(markup),
      "the dashboard states no second page title",
    );
    assert.ok(
      !/project ·|1 project/.test(markup.replace(/home-foot[\s\S]*$/, "")),
      "the project count lives in the footer only",
    );
    // Three calm sections, each with its rows.
    assert.match(markup, /Needs you/);
    assert.match(markup, /Running/);
    assert.match(markup, /Recent/);
    assert.match(markup, /Ship the review loop/);
    assert.match(markup, /Refactor the rail/);
    assert.match(markup, /Broken fixture/);
    assert.match(markup, /Earlier work/);
    // Primary project name, secondary goal, one semantic status, one action.
    assert.match(markup, /class="run-row__project">Fixture project</);
    assert.match(
      markup,
      /class="run-row__goal" title="Ship the review loop">Ship the review loop/,
    );
    assert.ok(
      markup.indexOf('class="run-row__project"') <
        markup.indexOf('class="run-row__goal"'),
      "the project is the row's primary line and the goal is secondary",
    );
    assert.match(markup, /title="Waiting for you \(WAITING_APPROVAL\)"/);
    // The running row names the stage and the agent the plan maps to it, from
    // the run's own record — no extra request, no invented progress.
    assert.match(
      markup,
      /class="run-row__detail">Implementation · Fixture agent</,
    );
    assert.ok(
      !/run-row__evidence/.test(markup),
      "no evidence line without an evidence state",
    );
    assert.match(
      markup,
      /class="run-row__link" href="#\/run\/run-waiting" aria-label="Review Fixture project">Review/,
    );
    assert.match(
      markup,
      /class="run-row__link" href="#\/run\/run-failed" aria-label="Retry Fixture project">Retry/,
    );
    assert.match(
      markup,
      /class="run-row__link" href="#\/run\/run-done" aria-label="View Fixture project">View/,
    );
    // No inventory, no template/stage identifiers, and no implementation-policy
    // prose under the section headings — the headings and rows suffice.
    assert.ok(
      !/Workspace|Templates on this server|plan stages|agents \(/.test(markup),
      "the operational home is not an inventory",
    );
    assert.ok(
      !/implement-review|v1 ·|8 stages|plan stages/.test(markup),
      "no template or stage identifiers on the home rows",
    );
    assert.ok(
      !/Gates and failures|One active workflow per repository|Terminal runs are read-only/.test(
        markup,
      ),
      "no implementation-policy hints under the section headings",
    );
    assert.ok(!/home-section__hint/.test(markup));
    // The wait is stated once per row (the status word), never repeated as a
    // second badge, banner or meta chip; the title keeps the raw enum.
    assert.equal(
      (markup.match(/>Waiting for you</g) ?? []).length,
      1,
      "the waiting status appears exactly once per waiting row",
    );
    assert.ok(
      !/WAITING FOR YOU/.test(markup),
      "no shouted uppercase status anywhere on the home",
    );
    // Below the sections: one small projects link, and nothing else to count.
    assert.match(markup, /class="home-foot"/);
    assert.match(
      markup,
      /class="home-foot__projects" href="#\/projects">1 project</,
    );
    assert.equal(
      (markup.match(/class="home-foot__projects"/g) ?? []).length,
      1,
      "one projects link, not a footer inventory",
    );
    assert.ok(
      !/Run history<\/a>|same-origin|template\(s\)/.test(markup),
      "no duplicated history link or footer inventory",
    );
  },
);

check("empty categories are not rendered as placeholder sections", () => {
  const bootstrap = bootstrapFixture([
    run("COMPLETED", "run-done", "Earlier work", "2026-09-22T09:30:00.000Z"),
  ]);
  const markup = renderToStaticMarkup(Home({ bootstrap }) as never);
  assert.match(markup, /Recent/);
  assert.ok(!/Needs you/.test(markup), "no empty Needs you section");
  assert.ok(!/class="home-section__head"><h2>Running/.test(markup));
  assert.match(markup, /Nothing needs you right now/);
});

check(
  "needs-you rows carry one persisted evidence line, or say why not",
  () => {
    const bootstrap = bootstrapFixture([
      run(
        "WAITING_APPROVAL",
        "run-waiting",
        "Ship the review loop",
        "2026-09-22T12:00:00.000Z",
      ),
      run("FAILED", "run-failed", "Broken fixture", "2026-09-22T10:30:00.000Z"),
      run("COMPLETED", "run-done", "Earlier work", "2026-09-22T09:30:00.000Z"),
    ]);
    const markup = renderToStaticMarkup(
      Home({
        bootstrap,
        evidence: {
          "run-waiting": {
            status: "ready",
            line: "Claude Opus 4.8 rejected · 7 tests passed",
            state: "Ready for final approval",
          },
          "run-failed": { status: "unavailable", line: null },
        },
      }) as never,
    );
    assert.match(markup, /class="run-row__evidence"/);
    assert.match(markup, /Claude Opus 4\.8 rejected · 7 tests passed/);
    // The state word comes from the persisted gate, not a generic wait.
    assert.match(markup, /class="status__word">Ready for final approval</);
    assert.match(
      markup,
      /title="Ready for final approval \(WAITING_APPROVAL\)"/,
    );
    assert.ok(
      !/Waiting for you/.test(markup),
      "a known gate never falls back to the generic waiting word",
    );
    // A failed lookup says so rather than implying a clean run…
    assert.match(markup, /Evidence unavailable/);
    // …and the finished row carries no evidence line at all.
    const done = markup.slice(markup.indexOf("run-done"));
    assert.ok(!/run-row__evidence/.test(done));

    // Nothing recorded: no evidence line, and never a fabricated one.
    const bare = renderToStaticMarkup(
      Home({
        bootstrap,
        evidence: { "run-waiting": { status: "ready", line: null } },
      }) as never,
    );
    assert.ok(!/run-row__evidence/.test(bare));
    // With no gate read, the row keeps the run's own status word.
    assert.match(bare, /class="status__word">Waiting for you</);
    // Loading is stated while the bounded detail request is in flight, and the
    // word stays the run's own status until the gate is actually known.
    const loading = renderToStaticMarkup(
      Home({
        bootstrap,
        evidence: { "run-waiting": { status: "loading", line: null } },
      }) as never,
    );
    assert.match(loading, /Loading evidence…/);
    assert.match(loading, /class="status__word">Waiting for you</);
  },
);

check(
  "the sidebar navigates and names blocked projects, with no inventory",
  () => {
    const blocked = bootstrapFixture([
      run(
        "WAITING_APPROVAL",
        "run-waiting",
        "Ship the review loop",
        "2026-09-22T12:00:00.000Z",
      ),
      run(
        "WAITING_INPUT",
        "run-input",
        "Answer the plan",
        "2026-09-22T11:30:00.000Z",
      ),
      run("FAILED", "run-failed", "Broken fixture", "2026-09-22T11:00:00.000Z"),
      run(
        "INTERRUPTED",
        "run-interrupted",
        "Stopped run",
        "2026-09-22T10:30:00.000Z",
      ),
      run(
        "RUNNING",
        "run-active",
        "Refactor the rail",
        "2026-09-22T10:00:00.000Z",
      ),
      run("COMPLETED", "run-done", "Earlier work", "2026-09-22T09:30:00.000Z"),
    ]);
    const markup = renderToStaticMarkup(
      Nav({ bootstrap: blocked, route: { view: "home" } as never }) as never,
    );
    // Wordmark and the four destinations.
    assert.match(markup, /AGENT<span>OPS<\/span>/);
    assert.match(markup, /href="#\/" aria-current="page">Today</);
    assert.match(markup, /href="#\/projects">Projects</);
    assert.match(markup, /href="#\/agents">Agents</);
    assert.match(markup, /href="#\/runs">History</);
    // One hairline separates navigation from what needs the operator.
    assert.match(markup, /nav__section nav__section--ruled/);
    assert.match(markup, /class="nav__label">Needs you</);
    // Blocked runs are named by project, capped, with the goal as the title.
    assert.match(markup, /title="Fixture project — Ship the review loop"/);
    assert.equal(
      (markup.match(/class="nav__item nav__item--needs"/g) ?? []).length,
      3,
      "at most a few blocked runs are named",
    );
    assert.match(markup, /href="#\/">1 more on Today</);
    // Starting work sits at the bottom; no counters or inventories anywhere.
    assert.match(markup, /class="nav__item nav__item--new" href="#\/new-run"/);
    assert.match(markup, />\+<\/span> New workflow</);
    assert.ok(
      !/nav__count|nav__project|Open runs|event stream|v0\.1/.test(markup),
      "the sidebar shows no counters, no project list and no run inventory",
    );

    // A quiet workspace says so in one line, and claims no counts at all.
    const quiet = renderToStaticMarkup(
      Nav({
        bootstrap: emptyBootstrap,
        route: { view: "agents" } as never,
      }) as never,
    );
    assert.match(quiet, /class="nav__empty">Nothing needs you</);
    assert.match(quiet, /href="#\/agents" aria-current="page">Agents</);
    assert.ok(!/nav__item--needs|nav__more/.test(quiet));
  },
);

check(
  "the shell renders no footer inventory and no duplicate home title",
  () => {
    const globals = globalThis as { window?: unknown };
    const previous = globals.window;
    globals.window = {
      location: { hash: "#/" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    try {
      const markup = renderToStaticMarkup(createElement(App));
      // The old footer printed project/agent/template/run counts plus a
      // same-origin note above every screen: navigation and rows say enough.
      assert.ok(
        !/agent\(s\)|template\(s\)|run\(s\)|same-origin client|project\(s\)/.test(
          markup,
        ),
        "no footer inventory line in the shell",
      );
      // The dashboard's only page title is the greeting in the view itself.
      assert.ok(!/Mission control/.test(markup));
      assert.match(markup, /href="#\/" aria-current="page">Today</);
    } finally {
      globals.window = previous;
    }
  },
);

check(
  "a run row renders the persisted record and omits absent derived fields",
  () => {
    const record = run(
      "FAILED",
      "run-failed",
      "Broken fixture",
      "2026-09-22T10:30:00.000Z",
    );
    const bare = renderToStaticMarkup(
      RunRow({ run: record, projectName: "Fixture project" }) as never,
    );
    assert.match(bare, /Broken fixture/);
    assert.match(bare, /#\/run\/run-failed/);
    assert.match(bare, /Failed/);
    assert.match(bare, /class="run-row__project">Fixture project</);
    assert.match(
      bare,
      /class="run-row__link" href="#\/run\/run-failed" aria-label="Retry Fixture project">Retry/,
    );
    // The link's accessible name says what it does and to which project.
    assert.match(bare, /aria-label="Retry Fixture project"/);
    assert.ok(
      !/Loading evidence|Evidence unavailable/.test(bare),
      "a row with no evidence state claims nothing",
    );
    assert.ok(
      !/feature\//.test(bare),
      "no branch chip when the server sends no branch",
    );

    const withDerived = renderToStaticMarkup(
      RunRow({
        run: {
          ...record,
          branch: "feature/review-loop",
          lastReviewVerdict: "REJECT",
        },
        projectName: "Fixture project",
      }) as never,
    );
    // Derived fields the row no longer prints must not reappear: the row states
    // the run's own status once, with no branch or verdict chips.
    assert.ok(!/feature\/review-loop/.test(withDerived));
    assert.ok(!/Reject/.test(withDerived) || !/REJECT/.test(withDerived));
  },
);

check("a row states its evidence, its loading state or its failure", () => {
  const record = run(
    "WAITING_APPROVAL",
    "run-waiting",
    "Ship the review loop",
    "2026-09-22T12:00:00.000Z",
  );
  // Evidence is never replaced by progress, and progress never invents evidence.
  const both = renderToStaticMarkup(
    RunRow({
      run: record,
      projectName: "Fixture project",
      detail: "Implementation · Fixture agent",
      evidence: {
        status: "ready",
        line: "Claude approved",
        state: "Ready for final approval",
      },
    }) as never,
  );
  assert.match(both, /class="run-row__evidence">Claude approved</);
  assert.ok(
    !/run-row__detail/.test(both),
    "a row shows one note, not two competing lines",
  );
  const detailOnly = renderToStaticMarkup(
    RunRow({
      run: { ...record, status: "RUNNING" },
      projectName: "Fixture project",
      detail: "Implementation · Fixture agent",
    }) as never,
  );
  assert.match(
    detailOnly,
    /class="run-row__detail">Implementation · Fixture agent</,
  );
  const withEvidence = renderToStaticMarkup(
    RunRow({
      run: record,
      projectName: "Fixture project",
      evidence: {
        status: "ready",
        line: "Claude Opus 4.8 rejected · 7 tests passed",
        state: "Changes requested",
      },
    }) as never,
  );
  assert.match(
    withEvidence,
    /class="run-row__evidence">Claude Opus 4\.8 rejected · 7 tests passed</,
  );
  assert.match(withEvidence, /class="status__word">Changes requested</);
  assert.ok(
    !/Waiting for you/.test(withEvidence),
    "the row states the persisted decision, not a generic wait",
  );
  const loading = renderToStaticMarkup(
    RunRow({
      run: record,
      projectName: "Fixture project",
      evidence: { status: "loading", line: null },
    }) as never,
  );
  assert.match(loading, /class="run-row__evidence">Loading evidence…</);
  const unavailable = renderToStaticMarkup(
    RunRow({
      run: record,
      projectName: "Fixture project",
      evidence: { status: "unavailable", line: null },
    }) as never,
  );
  assert.match(unavailable, /class="run-row__evidence">Evidence unavailable</);
});

/* --------------------- run screen fixtures (pass 3) -------------------- */

const reviewerAgent: AgentRecord = {
  ...agent,
  id: "agent-reviewer",
  name: "Claude Opus 4.8",
  roleHint: "reviewer",
};

/**
 * One run's detail payload in the shape the real server persists: the
 * verification record carries `counts: null` while the normalized test runs for
 * the same attempt were parsed confidently, and the verdict omits its reviewer
 * string (it resolves through the recorded attempt's agent).
 */
function detailFixture(): RunDetailResponse {
  const runRecord = run(
    "WAITING_APPROVAL",
    "run-review",
    "Exercise the rejection gate",
    "2026-09-22T12:00:00.000Z",
  );
  const stages: StageRecord[] = [
    stage("plan", "COMPLETED", { attemptCount: 1 }),
    stage("implement", "COMPLETED", {
      attemptCount: 1,
      agentId: agent.id,
      summary: "implemented the goal",
    }),
    stage("verify", "COMPLETED", { attemptCount: 1, agentId: agent.id }),
    stage("review", "WAITING_APPROVAL", {
      cycle: 2,
      attemptCount: 2,
      agentId: reviewerAgent.id,
    }),
    stage("review.fix", "COMPLETED", { cycle: 1, attemptCount: 1 }),
    stage("review.retest", "COMPLETED", { cycle: 1, attemptCount: 1 }),
    stage("final_verify", "COMPLETED", { attemptCount: 1, agentId: agent.id }),
  ];
  const tests = [
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `test-verify-${index}`,
      runId: runRecord.id,
      taskId: null,
      attemptId: "attempt-verify",
      stageKey: "verify",
      framework: "node:test",
      status: "passed" as const,
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      parsedConfidently: true,
      summary: "all fixture checks passed",
      durationMs: 1200,
      createdAt: `2026-09-22T10:0${index}:00.000Z`,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `test-final-${index}`,
      runId: runRecord.id,
      taskId: null,
      attemptId: "attempt-final",
      stageKey: "final_verify",
      framework: "node:test",
      status: "passed" as const,
      passed: 7,
      failed: 0,
      skipped: 0,
      total: 7,
      parsedConfidently: true,
      summary: null,
      durationMs: 900,
      createdAt: `2026-09-22T12:0${index}:00.000Z`,
    })),
  ];
  const attempts: AttemptRecord[] = [
    {
      id: "attempt-implement",
      taskId: "task-implement",
      runId: runRecord.id,
      stageKey: "implement",
      attemptNumber: 1,
      reason: null,
      previousAttemptId: null,
      kind: "agent" as const,
      status: "COMPLETED" as const,
      agentId: agent.id,
      adapterKind: "mock",
      agentSessionId: null,
      promptPacket: null,
      promptText: "Implement the goal exactly as the plan describes.",
      inputs: [],
      resultStatus: "completed",
      resultSummary: "implemented",
      exitCode: 0,
      usage: null,
      usageKnown: false,
      artifacts: [],
      reviewVerdictId: null,
      verification: null,
      error: null,
      createdAt: "2026-09-22T10:00:00.000Z",
      startedAt: "2026-09-22T10:00:00.000Z",
      endedAt: "2026-09-22T10:05:00.000Z",
    },
    {
      id: "attempt-verify",
      taskId: "task-verify",
      runId: runRecord.id,
      stageKey: "verify",
      attemptNumber: 1,
      reason: null,
      previousAttemptId: null,
      kind: "verification" as const,
      status: "COMPLETED" as const,
      agentId: null,
      adapterKind: null,
      agentSessionId: null,
      promptPacket: null,
      promptText: null,
      inputs: [],
      resultStatus: "completed",
      resultSummary: null,
      exitCode: null,
      usage: null,
      usageKnown: false,
      artifacts: [],
      reviewVerdictId: null,
      verification: {
        status: "passed" as const,
        summary: "1 command exited 0",
        reason: null,
        mode: "commands",
        commandCount: 1,
        counts: null,
      },
      error: null,
      createdAt: "2026-09-22T10:08:00.000Z",
      startedAt: "2026-09-22T10:08:00.000Z",
      endedAt: "2026-09-22T10:09:00.000Z",
    },
    {
      id: "attempt-review",
      taskId: "task-review",
      runId: runRecord.id,
      stageKey: "review",
      attemptNumber: 2,
      reason: "reviewer requested changes",
      previousAttemptId: "attempt-review-1",
      kind: "agent" as const,
      status: "COMPLETED" as const,
      agentId: reviewerAgent.id,
      adapterKind: "mock",
      agentSessionId: null,
      promptPacket: null,
      promptText: "Review the frozen change.",
      inputs: [],
      resultStatus: "completed",
      resultSummary: null,
      exitCode: 0,
      usage: null,
      usageKnown: false,
      artifacts: [],
      reviewVerdictId: "rev-2",
      verification: null,
      error: null,
      createdAt: "2026-09-22T11:00:00.000Z",
      startedAt: "2026-09-22T11:00:00.000Z",
      endedAt: "2026-09-22T11:02:00.000Z",
    },
    {
      id: "attempt-final",
      taskId: "task-final-verify",
      runId: runRecord.id,
      stageKey: "final_verify",
      attemptNumber: 1,
      reason: null,
      previousAttemptId: null,
      kind: "verification" as const,
      status: "COMPLETED" as const,
      agentId: null,
      adapterKind: null,
      agentSessionId: null,
      promptPacket: null,
      promptText: null,
      inputs: [],
      resultStatus: "completed",
      resultSummary: null,
      exitCode: null,
      usage: null,
      usageKnown: false,
      artifacts: [],
      reviewVerdictId: null,
      verification: {
        status: "passed" as const,
        summary: "1 command exited 0",
        reason: null,
        mode: "commands",
        commandCount: 1,
        counts: null,
      },
      error: null,
      createdAt: "2026-09-22T12:03:00.000Z",
      startedAt: "2026-09-22T12:03:00.000Z",
      endedAt: "2026-09-22T12:04:00.000Z",
    },
  ];
  return {
    run: runRecord,
    plan,
    stages,
    tasks: [],
    attempts,
    tests,
    approvals: [],
    pendingApproval: {
      id: "approval-final",
      runId: runRecord.id,
      stageKey: "final",
      taskId: null,
      attemptId: null,
      gate: "final_acceptance",
      status: "PENDING",
      allowed: ["approve", "reject"],
      reason: null,
      requestedAt: "2026-09-22T12:05:00.000Z",
      decision: null,
      instruction: null,
      actor: null,
      decidedAt: null,
    },
    reviewVerdicts: [
      {
        id: "rev-1",
        runId: runRecord.id,
        taskId: "task-review",
        attemptId: "attempt-review-1",
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
        confidence: null,
        reviewer: null,
        raw: '{"verdict":"REJECT"}',
        createdAt: "2026-09-22T10:30:00.000Z",
      },
      {
        id: "rev-2",
        runId: runRecord.id,
        taskId: "task-review",
        attemptId: "attempt-review",
        stageKey: "review",
        cycle: 2,
        valid: true,
        validationErrors: [],
        verdict: "APPROVE",
        summary: "the fix is correct and the change is small",
        issues: [
          {
            severity: "nit",
            description: "naming could be clearer",
            path: "src/parser.ts",
            line: 12,
          },
          {
            severity: "nit",
            description: "add a comment for the fallback",
            path: null,
            line: null,
          },
        ],
        confidence: null,
        reviewer: null,
        raw: '{"verdict":"APPROVE"}',
        createdAt: "2026-09-22T11:02:00.000Z",
      },
    ],
    events: [
      {
        id: 1,
        projectId: project.id,
        runId: runRecord.id,
        taskId: null,
        attemptId: "attempt-implement",
        stageKey: "implement",
        category: "stage",
        type: "stage.started",
        actor: "engine",
        payload: { agentId: agent.id },
        createdAt: "2026-09-22T10:00:00.000Z",
      },
      {
        id: 2,
        projectId: project.id,
        runId: runRecord.id,
        taskId: null,
        attemptId: "attempt-implement",
        stageKey: "implement",
        category: "agent",
        type: "agent.output",
        actor: "agent",
        payload: { stream: "stdout", message: "raw protocol frame" },
        createdAt: "2026-09-22T10:00:30.000Z",
      },
      {
        id: 3,
        projectId: project.id,
        runId: runRecord.id,
        taskId: null,
        attemptId: "attempt-implement",
        stageKey: "implement",
        category: "agent",
        type: "agent.failed",
        actor: "agent",
        payload: { agentId: agent.id, message: "adapter exited 1" },
        createdAt: "2026-09-22T10:01:00.000Z",
      },
      {
        id: 4,
        projectId: project.id,
        runId: runRecord.id,
        taskId: null,
        attemptId: null,
        stageKey: null,
        category: "system",
        type: "HEARTBEAT",
        actor: "system",
        payload: { message: "still alive" },
        createdAt: "2026-09-22T10:02:00.000Z",
      },
    ],
    snapshots: [
      {
        id: "snapshot-1",
        runId: runRecord.id,
        stageKey: "implement",
        attemptId: "attempt-implement",
        phase: "after",
        headSha: "0123456789abcdef",
        branch: "main",
        detached: false,
        dirty: true,
        stagedPaths: [],
        unstagedPaths: ["src/parser.ts"],
        untrackedPaths: [],
        diffStat: " 1 file changed, 3 insertions(+), 1 deletion(-)",
        localCommits: [],
        ahead: null,
        behind: null,
        unavailableReason: null,
        capturedAt: "2026-09-22T10:05:00.000Z",
      },
    ],
    commands: [
      {
        id: "command-final",
        runId: runRecord.id,
        taskId: null,
        attemptId: "attempt-final",
        stageKey: "final_verify",
        testRunId: null,
        name: "test",
        executable: "npm",
        args: ["test"],
        cwd: null,
        status: "passed" as const,
        exitCode: 0,
        durationMs: 900,
        stdoutExcerpt: "# pass 7\n# fail 0\n# tests 7",
        stderrExcerpt: null,
        truncated: false,
        createdAt: "2026-09-22T12:03:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "artifact-1",
        runId: runRecord.id,
        stageKey: "implement",
        taskId: null,
        attemptId: null,
        path: "reports/run-summary.md",
        kind: "report",
        sizeBytes: 2048,
        exists: true,
        creator: "operator",
        note: null,
        createdAt: "2026-09-22T10:06:00.000Z",
      },
    ],
    project,
    agents: [agent, reviewerAgent],
  };
}

const detail = detailFixture();

/**
 * The Activity context the run page builds: an agent event names its agent
 * through the attempt it belongs to, so the sentences never fall back to a
 * generic "Agent" when the run recorded a real one.
 */
function activityContextFor(source: RunDetailResponse) {
  return {
    stageNames: new Map(source.stages.map((stage) => [stage.key, stage.name])),
    attemptNumbers: new Map(
      source.attempts.map((attempt) => [attempt.id, attempt.attemptNumber]),
    ),
    agentNames: new Map(source.agents.map((agent) => [agent.id, agent.name])),
    attemptAgents: new Map(
      source.attempts.flatMap((attempt) => {
        const name = source.agents.find(
          (agent) => agent.id === attempt.agentId,
        )?.name;
        return name ? [[attempt.id, name] as const] : [];
      }),
    ),
  };
}

/* --------------------------- run screen checks -------------------------- */

check("stage progress is compact and its chronology is folded", () => {
  const milestones = buildRunMilestones(
    detail.plan,
    detail.stages,
    detail.agents,
    "final",
  );
  const markup = renderToStaticMarkup(
    createElement(RunProgress, {
      milestones,
      selectedStageKey: "review",
      onSelectStage: () => undefined,
      onOpenMilestone: () => undefined,
    }),
  );
  const bar = markup.slice(0, markup.indexOf("<details"));
  // Plain names, in plan order, one button each with an icon and a state word.
  for (const name of ["Plan", "Build", "Verify", "Review", "Final"]) {
    assert.match(bar, new RegExp(`progress__name">${name}<`));
  }
  assert.equal((bar.match(/class="progress__button /g) ?? []).length, 5);
  assert.match(bar, /progress__icon--complete"[^>]*>✓</);
  assert.match(bar, /progress__icon--current"[^>]*>●</);
  assert.ok(
    !/progress__meta|attempts</.test(bar),
    "the progression itself carries no attempt counts or record rows",
  );
  assert.ok(!/<details/.test(bar), "no milestone is expanded by default");
  assert.ok(
    !/>[^<]*WAITING_APPROVAL[^<]*</.test(markup),
    "no persisted enum is rendered as visible text",
  );
  // The chronology — including the review → fix → re-verification branch — is
  // reachable, collapsed, with the cycle it belongs to.
  assert.match(markup, /Workflow details/);
  assert.match(markup, /Structured review: fixes/);
  assert.match(markup, /Structured review: re-verification/);
  assert.match(markup, /fixes from review cycle 1 of 2/);
  assert.match(
    markup,
    /aria-label="Structured review review reviewer Claude Opus 4\.8 Waiting for you"/,
  );
  assert.ok(
    !/>cycle 1</.test(markup),
    "no bare cycle counter competing with the run-level one",
  );
  assert.ok(
    !/<details class="disclosure" open/.test(markup),
    "workflow details start collapsed",
  );
});

check("the run state headline is the semantic sentence, not the enum", () => {
  assert.equal(
    runStateView({
      status: "WAITING_APPROVAL",
      gate: "final_acceptance",
      stage: detail.stages.find((entry) => entry.key === "final") ?? null,
    }).headline,
    "Ready for your review",
  );
  assert.equal(
    runStateView({
      status: "RUNNING",
      stage: detail.stages.find((entry) => entry.key === "implement") ?? null,
      agentName: agent.name,
    }).headline,
    "Fixture agent is implementing",
  );
  assert.equal(
    runStateView({
      status: "FAILED",
      failedStageName: "Implementation",
    }).headline,
    "Implementation failed",
  );
  assert.equal(runStateView({ status: "COMPLETED" }).headline, "Completed");
});

check("activity lists lifecycle sentences, not output frames", () => {
  const markup = renderToStaticMarkup(
    createElement(ActivityPanel, {
      events: detail.events,
      streamStatus: "live",
      stages: detail.stages,
      tasks: detail.tasks,
      agents: detail.agents,
      attempts: detail.attempts.map((entry) => ({
        id: entry.id,
        attemptNumber: entry.attemptNumber,
        stageKey: entry.stageKey,
        agentId: entry.agentId,
      })),
    }),
  );
  // Operator sentences, newest first, with a time and no category/type column.
  assert.match(markup, /aria-label="Run activity"/);
  assert.match(markup, /Newest first/);
  const failedAt = markup.indexOf("Fixture agent failed on Implementation");
  const startedAt = markup.indexOf("Fixture agent started Implementation");
  assert.ok(
    failedAt >= 0 && startedAt > failedAt,
    "the newest event is listed first",
  );
  // The activity list itself carries no protocol frame text.
  const list = markup.slice(
    markup.indexOf('aria-label="Run activity"'),
    markup.indexOf("</ol>"),
  );
  assert.ok(
    !/raw protocol frame/.test(list),
    "output frames stay out of Activity",
  );
  assert.ok(!/agent\.output/.test(list), "no event type column in Activity");
  assert.match(markup, /Problems only/);
  // The raw log stream keeps every frame, with its own filters and follow.
  assert.match(markup, /Raw logs \(4 lines, 2 output frames\)/);
  assert.match(markup, /aria-label="Filter by stream"/);
  assert.match(markup, /aria-label="Filter by severity"/);
  assert.match(markup, />Following</);
  assert.match(markup, /Advanced filters/);
  assert.match(markup, /aria-label="Filter by actor"/);
  assert.ok(!/Jump to latest/.test(markup), "nothing is paused yet");
});

check("verification leads with command rows and folds the raw output", () => {
  const markup = renderToStaticMarkup(
    createElement(VerificationPanel, { detail }),
  );
  const latestAt = markup.indexOf("Latest verification");
  assert.ok(latestAt === -1, "no record-inspector heading");
  assert.match(markup, /Final verification/);
  assert.match(markup, /Verified /);
  // One row per command: what ran, its status word, its counts, its duration.
  assert.match(markup, /npm test/);
  assert.match(markup, /Passed/);
  assert.match(markup, /7 passed \/ 0 failed \/ 7 total/);
  assert.match(markup, /900 ms/);
  // The parsed test count is stated exactly once in the default body — on the
  // command row. There is no second summary line repeating it, and the
  // normalized test rows themselves sit under Technical details.
  const defaultBody = markup.slice(0, markup.indexOf("Technical details"));
  assert.equal(
    (defaultBody.match(/7 passed \/ 0 failed \/ 7 total/g) ?? []).length,
    1,
    "the normalized count is presented once, on the command row",
  );
  assert.ok(
    !/7 tests passed/.test(defaultBody),
    "no second test-count summary line in the default body",
  );
  assert.ok(
    !/1 command exited 0/.test(defaultBody),
    "the recorded summary is not repeated in the default body",
  );
  // The two seven-test attempts are never added up into fourteen.
  assert.ok(!/14 tests/.test(markup), "counts are not summed across attempts");
  assert.ok(!/14\/14/.test(markup));
  // Raw output exists and is folded.
  assert.match(markup, /Raw output/);
  assert.match(markup, /# pass 7/);
  assert.ok(
    !/<details class="disclosure" open/.test(markup),
    "raw output stays folded",
  );
  // Database-level facts live under Technical details, not in the default body.
  assert.match(markup, /Technical details/);
  assert.match(markup, /Count source/);
  assert.match(markup, /Recorded summary/);
  assert.match(markup, /Earlier verifications/);
  // The earlier verification is headed by the attempt and its persisted
  // outcome; its parsed count is not repeated a second time there either.
  const earlier = markup.slice(markup.indexOf("Earlier verifications"));
  assert.match(earlier, /Verification · Passed · /);
  assert.ok(
    !/Verification · 7 tests passed/.test(earlier),
    "no parsed test count in the earlier verification heading",
  );
});

check("a passed command with unparsed counts still reads as passed", () => {
  const unparsed: RunDetailResponse = {
    ...detail,
    tests: detail.tests.map((test) =>
      test.attemptId === "attempt-final"
        ? {
            ...test,
            passed: null,
            failed: null,
            skipped: null,
            total: null,
            parsedConfidently: false,
            status: "unknown" as const,
            summary: "command output could not be counted",
          }
        : test,
    ),
  };
  const markup = renderToStaticMarkup(
    createElement(VerificationPanel, { detail: unparsed }),
  );
  // The command still shows its real status and duration…
  assert.match(markup, /npm test/);
  assert.match(markup, /Passed/);
  // …while the count it could not parse is stated as unavailable, never as 0.
  assert.match(markup, /Test count unavailable/);
  assert.ok(
    !/0 passed/.test(markup),
    "an unknown count is never written as zero",
  );
  // The recorded summary is kept — under Technical details, not as a second
  // summary line in front of the operator.
  assert.match(
    markup.slice(markup.indexOf("Technical details")),
    /1 command exited 0/,
  );
  assert.ok(
    !/1 command exited 0/.test(
      markup.slice(0, markup.indexOf("Technical details")),
    ),
    "the recorded summary is not repeated in the default body",
  );
});

check(
  "a multi-command verification never stamps one count on every command",
  () => {
    // Mixed verification: a test command that prints counts and a build command
    // that prints none. The single attempt-level count must not be attributed to
    // the build command.
    const mixed: RunDetailResponse = {
      ...detail,
      commands: [
        {
          ...detail.commands[0]!,
          id: "command-test",
          name: "test",
          executable: "npm",
          args: ["test"],
        },
        {
          ...detail.commands[0]!,
          id: "command-build",
          name: "build",
          executable: "npm",
          args: ["run", "build"],
          stdoutExcerpt: "vite build done in 182ms",
          durationMs: 182,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(VerificationPanel, { detail: mixed }),
    );
    const buildAt = markup.indexOf("npm run build");
    assert.ok(buildAt >= 0, "the build command is listed");
    const buildRow = markup.slice(
      buildAt,
      markup.indexOf("</div></div>", buildAt),
    );
    assert.ok(
      !/7 tests passed|7 passed/.test(buildRow),
      "the test counts are not attributed to the build command",
    );
    assert.match(buildRow, /182 ms/);
    // The counts appear once, at verification level, with the limitation stated.
    assert.match(markup, /for this verification as a whole/);
    const testAt = markup.indexOf("npm test");
    const testRow = markup.slice(testAt, buildAt);
    assert.ok(
      !/7 tests passed|7 passed/.test(testRow),
      "no per-command counts when the attempt has several commands",
    );
  },
);

check("review leads with reviewer and findings, prose one level down", () => {
  const markup = renderToStaticMarkup(createElement(ReviewPanel, { detail }));
  assert.match(markup, /Review verdicts/);
  // Reviewer, verdict and finding counts come first.
  assert.match(markup, /Claude Opus 4\.8/);
  assert.match(markup, /Approve/);
  assert.match(markup, /0 blockers · 2 suggestions/);
  assert.match(markup, /Suggestions \(2\)/);
  assert.match(markup, /naming could be clearer/);
  assert.match(markup, /src\/parser\.ts:12/);
  assert.match(markup, /add a comment for the fallback/);
  // The prose sits behind Read full review, not in front of the findings.
  const findingsAt = markup.indexOf("Suggestions (2)");
  const proseAt = markup.indexOf("the fix is correct and the change is small");
  assert.ok(
    findingsAt >= 0 && proseAt > findingsAt,
    "findings precede the prose",
  );
  assert.match(markup, /Read full review/);
  // Provenance and the raw payload are folded under Technical details.
  assert.match(markup, /Technical details/);
  assert.match(markup, /resolved through the verdict/);
  assert.match(markup, /Raw review payload \(JSON\)/);
  assert.match(markup, /reviewed severity: nit/);
  assert.ok(!/>APPROVE</.test(markup), "no persisted verdict enum as copy");
  assert.ok(
    !/<details class="disclosure" open/.test(markup),
    "nothing opens by default",
  );
  // Every earlier verdict is kept as a chronology.
  assert.match(markup, /Earlier reviews \(1\)/);
  assert.match(markup, /Reject/);
  assert.match(markup, /empty input throws/);
  assert.match(markup, /Blockers \(1\)/);
  assert.match(markup, /src\/parser\.ts:42/);
});

check("overview keeps the outcome, the audit and the run's assets", () => {
  const markup = renderToStaticMarkup(
    createElement(OverviewPanel, {
      client: {} as never,
      detail,
      events: detail.events,
      activityContext: activityContextFor(detail),
      activeSummary: "reviewing the frozen change",
      showOutcome: true,
      selectedStage:
        detail.stages.find((entry) => entry.key === "implement") ?? null,
      selectedStageKey: "implement",
      selectedAttemptId: null,
      onSelectAttempt: () => undefined,
      onSelectStage: () => undefined,
      onOpenTab: () => undefined,
      evidenceOpen: false,
      onEvidenceOpen: () => undefined,
      refreshDetail: () => undefined,
    }),
  );
  assert.match(markup, /Outcome/);
  assert.match(markup, /Now/);
  assert.match(markup, /Recent activity/);
  // Recent activity leads; the outcome follows it, then the assets.
  const activityAt = markup.indexOf("Recent activity");
  const outcomeAt = markup.indexOf(">Outcome<");
  const assetsAt = markup.indexOf("Artifacts and usage");
  assert.ok(
    activityAt >= 0 && outcomeAt > activityAt && assetsAt > outcomeAt,
    "recent activity leads the overview, ahead of the outcome and the assets",
  );
  // Three short outcome lines; no record table, no repeated goal, no counters.
  assert.match(markup, /Passed · 7 tests passed \(Final verification\)/);
  assert.match(markup, /Claude Opus 4\.8 approved · 0 blockers, 2 suggestions/);
  assert.match(markup, /1 file changed/);
  assert.ok(
    !/Fix cycles used|Attempts<\/dt>|Goal<\/dt>/.test(
      markup.slice(0, markup.indexOf("Stage evidence")),
    ),
    "the Overview default is not a record table",
  );
  assert.ok(!/14 tests/.test(markup));
  // The live state stays in the header: the Overview adds the run's own summary
  // of the work in flight, never the sentence the header already states.
  assert.match(markup, /reviewing the frozen change/);
  assert.ok(
    !/Fixture agent is reviewing/.test(markup),
    "the active work sentence is not repeated under the header",
  );
  // Recent activity is lifecycle sentences, not frames, newest first, with no
  // implementation explainer.
  assert.match(markup, /Fixture agent started Implementation/);
  assert.ok(!/raw protocol frame/.test(markup), "no frames in the summary");
  assert.ok(
    !/lifecycle messages|Raw logs live in/.test(markup),
    "no implementation explainer under recent activity",
  );
  // Run-level artifacts and measured usage are still here: an artifact with no
  // attempt at all is listed, and the operator can register another.
  assert.match(markup, /Artifacts and usage/);
  assert.match(markup, /Artifacts \(1\)/);
  assert.match(markup, /reports\/run-summary\.md/);
  assert.match(markup, /Register an artifact/);
  assert.match(markup, /Repository-relative path/);
  assert.match(markup, /Register artifact/);
  assert.match(markup, /Measured usage/);
  // The stage audit is reachable in one disclosure, closed by default.
  assert.match(markup, /Stage evidence — Implementation/);
  assert.match(markup, /Open evidence for Implementation/);
  assert.match(markup, /Exact prompt persisted for attempt #1/);
  assert.ok(
    !/run-review/.test(markup),
    "ids stay under the page's Technical details, not in the Overview",
  );
});

check("overview never invents evidence it does not have", () => {
  const bare = {
    ...detail,
    tests: [],
    commands: [],
    reviewVerdicts: [],
    verification: [],
    snapshots: [],
    attempts: detail.attempts.map((attempt) => ({
      ...attempt,
      verification: null,
    })),
  };
  const markup = renderToStaticMarkup(
    createElement(OverviewPanel, {
      client: {} as never,
      detail: bare as never,
      events: [],
      activityContext: {
        stageNames: new Map(),
        attemptNumbers: new Map(),
        agentNames: new Map(),
      },
      activeSummary: null,
      // The outcome block still exists — it is simply reserved for a finished
      // run — and it refuses to claim evidence the run never recorded.
      showOutcome: true,
      selectedStage: null,
      selectedStageKey: null,
      selectedAttemptId: null,
      onSelectAttempt: () => undefined,
      onSelectStage: () => undefined,
      onOpenTab: () => undefined,
      evidenceOpen: false,
      onEvidenceOpen: () => undefined,
      refreshDetail: () => undefined,
    }),
  );
  assert.match(markup, /Nothing has finished on this run yet/);
  assert.ok(
    !/tests passed|approved|rejected|Verification:/i.test(markup),
    "no pass or verdict is claimed without evidence",
  );
});

check(
  "overview leads with recent activity and leaves the live state to the header",
  () => {
    // A run that is still working, with the decision sheet owning the gate: the
    // Overview adds only the summary the run itself recorded, and names agents
    // through the attempt an event belongs to.
    const events: EventRecord[] = [
      {
        id: 11,
        projectId: project.id,
        runId: "run-review",
        taskId: null,
        attemptId: "attempt-review",
        stageKey: "review",
        category: "agent",
        type: "agent.started",
        actor: "agent",
        // No agent id in the payload: the attempt names the agent.
        payload: {},
        createdAt: "2026-09-22T11:00:00.000Z",
      },
      {
        id: 12,
        projectId: project.id,
        runId: "run-review",
        taskId: null,
        attemptId: null,
        stageKey: "final",
        category: "approval",
        type: "approval.requested",
        actor: "engine",
        payload: {},
        createdAt: "2026-09-22T12:05:00.000Z",
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(OverviewPanel, {
        client: {} as never,
        detail,
        events,
        activityContext: activityContextFor(detail),
        activeSummary: "rewriting the greeting guard",
        // Active run: the header states the work, the sheet states the gate.
        showOutcome: false,
        selectedStage: null,
        selectedStageKey: null,
        selectedAttemptId: null,
        onSelectAttempt: () => undefined,
        onSelectStage: () => undefined,
        onOpenTab: () => undefined,
        evidenceOpen: false,
        onEvidenceOpen: () => undefined,
        refreshDetail: () => undefined,
      }),
    );
    // Recent activity is the first section, and the outcome block is absent.
    assert.ok(
      markup.indexOf("Recent activity") < markup.indexOf("Artifacts and usage"),
      "recent activity leads the overview",
    );
    assert.ok(
      !/>Outcome</.test(markup),
      "no outcome block while the header and the sheet state the facts",
    );
    // Only the run's own summary of the work in flight.
    assert.match(markup, /rewriting the greeting guard/);
    assert.ok(!/Fixture agent is reviewing/.test(markup));
    // The agent is named through the attempt, never as a generic "Agent".
    assert.match(markup, /Claude Opus 4\.8 started Structured review/);
    assert.ok(!/>Agent started/.test(markup));
    // Newest first: the 12:05 approval request precedes the 11:00 start.
    const waitingAt = markup.indexOf("Waiting for your decision");
    const startedAt = markup.indexOf(
      "Claude Opus 4.8 started Structured review",
    );
    assert.ok(
      waitingAt >= 0 && startedAt > waitingAt,
      "the newest activity is listed first",
    );
  },
);

check("the operator input gate asks the question next to the answer", () => {
  const question = pendingInputQuestion({
    events: [
      {
        id: 9,
        projectId: project.id,
        runId: "run-review",
        taskId: null,
        attemptId: "attempt-implement",
        stageKey: "implement",
        category: "agent",
        type: "agent.waiting",
        actor: "agent",
        payload: { message: "Which fixture should I use for the retry test?" },
        createdAt: "2026-09-22T12:06:00.000Z",
      },
    ],
    attempts: [{ ...detail.attempts[0]!, status: "WAITING_INPUT" }],
  });
  const markup = renderToStaticMarkup(
    createElement(InputRequest, {
      question,
      stageName: "Implementation",
      value: "",
      onChange: () => undefined,
      onSubmit: () => undefined,
      busy: false,
    }),
  );
  // Question, plain context, then the answer field.
  assert.match(markup, /Which fixture should I use for the retry test\?/);
  assert.match(markup, /Implementation · attempt 1/);
  assert.match(markup, /Your answer/);
  assert.ok(
    !/agent\.waiting|Source:|persisted/.test(
      markup.split("Technical details")[0]!,
    ),
    "provenance stays out of the default question block",
  );
  assert.match(markup, /Technical details/);
  assert.match(markup, /Question source/);
  assert.match(markup, />Send input</);
});

check("the app shell renders its navigation and loading state", () => {
  // The shell reads window.location.hash when it initialises its route. Only the
  // hash is stubbed; no DOM, no EventSource and no fetch happen in a server
  // render (effects do not run), so nothing is simulated beyond that one read.
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    location: { hash: "#/agents" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  try {
    const markup = renderToStaticMarkup(createElement(App));
    assert.match(markup, /AGENT<span>OPS<\/span>/);
    assert.match(markup, /Local run control/);
    assert.match(markup, /Loading bootstrap from the local AgentOps server/);
    assert.match(markup, /#\/projects/);
    assert.match(markup, /#\/new-run/);
    // The route is honoured before data arrives: the Agents nav item is current.
    assert.match(markup, /href="#\/agents" aria-current="page"/);
    // The sidebar lists the destinations and nothing to count; the shell claims
    // no version and prints no inventory before the bootstrap payload arrives.
    assert.match(markup, /href="#\/runs">History</);
    assert.doesNotMatch(markup, /vunavailable|nav__count|nav__project/);
    // Keyboard users can bypass the navigation, and the skip target exists.
    assert.match(markup, /class="skip-link" href="#main-content"/);
    assert.match(markup, /id="main-content" tabindex="-1"/);
  } finally {
    globals.window = previous;
  }
});

check("tabs use a roving tabindex and every aria-controls has a panel", () => {
  const tabs = [
    { id: "prompt", label: "Prompt" },
    { id: "output", label: "Output", count: 2 },
    { id: "review", label: "Review" },
  ];
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(Tabs, {
        tabs,
        active: "output",
        onChange: () => undefined,
        label: "Attempt 1 sections",
        idBase: "attempt-sections",
      }),
      tabs.map((tab) =>
        createElement(TabPanel, {
          key: tab.id,
          idBase: "attempt-sections",
          id: tab.id,
          selected: tab.id === "output",
          children: createElement("p", null, `${tab.label} body`),
        }),
      ),
    ),
  );
  assert.match(markup, /role="tablist" aria-label="Attempt 1 sections"/);
  // Exactly one tab is in the tab order, and it is the selected one.
  assert.equal(
    (markup.match(/role="tab"[^>]*tabindex="0"/g) ?? []).length,
    1,
    "one roving tab stop among the tabs",
  );
  assert.equal((markup.match(/role="tab"[^>]*tabindex="-1"/g) ?? []).length, 2);
  assert.match(
    markup,
    /id="attempt-sections-output"[^>]*aria-selected="true"[^>]*aria-controls="attempt-sections-output-panel"[^>]*tabindex="0"/,
  );
  // Every aria-controls target exists as a tabpanel that points back.
  for (const tab of tabs) {
    assert.match(
      markup,
      new RegExp(`role="tabpanel" id="attempt-sections-${tab.id}-panel"`),
    );
    assert.match(
      markup,
      new RegExp(`aria-labelledby="attempt-sections-${tab.id}"`),
    );
  }
  // Inactive panels are hidden, the selected one is not.
  assert.match(
    markup,
    /id="attempt-sections-output-panel" aria-labelledby[^>]*>/,
  );
  assert.match(
    markup,
    /role="tabpanel" id="attempt-sections-review-panel" aria-labelledby="attempt-sections-review" hidden=""/,
  );
});

check(
  "the goal is clamped to two lines with an explicit full-text control",
  () => {
    const long =
      "Implement the full review loop for the greeting fixture including retries, overrides and final acceptance";
    const markup = renderToStaticMarkup(
      createElement(ClampedText, { text: long }),
    );
    assert.match(markup, /class="clamp__text clamp__text--two"/);
    assert.match(markup, new RegExp(`title="${long}"`));
    assert.match(markup, new RegExp(long));
  },
);

check(
  "approval evidence precedes the decision buttons and gates the reason",
  () => {
    const approval = {
      id: "ap1",
      runId: "run-1",
      stageKey: "review",
      taskId: null,
      attemptId: null,
      gate: "review_reject" as const,
      status: "PENDING" as const,
      allowed: ["override", "retry", "reject"] as const,
      reason: "reviewer rejected the work: human decision required",
      requestedAt: "2026-09-22T11:00:00.000Z",
      decision: null,
      instruction: null,
      actor: null,
      decidedAt: null,
    };
    const options = approvalDecisionOptions({
      ...approval,
      allowed: [...approval.allowed],
    });
    const evidence = approvalEvidenceView({
      approval,
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
          confidence: null,
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

    const idle = renderToStaticMarkup(
      ApprovalPanel({
        evidence,
        options,
        facts: decisionFacts({ evidence, snapshots: [] }),
        selected: null,
        reason: "",
        busy: false,
        onSelect: () => undefined,
        onReasonChange: () => undefined,
        onCancel: () => undefined,
        onConfirm: () => undefined,
        onOpenReview: () => undefined,
      }) as never,
    );
    // The evidence is rendered before any decision button.
    const evidenceAt = idle.indexOf("Approval evidence");
    const firstButtonAt = idle.indexOf("<button");
    assert.ok(evidenceAt >= 0, "evidence block is rendered");
    assert.ok(
      evidenceAt < firstButtonAt,
      `evidence (${evidenceAt}) must precede the decision buttons (${firstButtonAt})`,
    );
    assert.match(idle, /Review rejected — human decision required/);
    assert.match(idle, /review cycle 2 of 2/);
    assert.match(idle, /Claude Opus 4\.8/);
    // The reviewer's findings live in the Review tab; the sheet keeps the
    // summary-level facts and offers a secondary control to read the full review.
    assert.match(idle, /resolved through the verdict/);
    assert.match(idle, /Findings<\/dt><dd>1 blocker/);
    assert.match(idle, /Command passed · 7\/7 passed/);
    assert.match(idle, /counts from the normalized test run node:test/);
    // The sheet shows one compact summary line and summary-level facts, with
    // every provenance detail inside the single collapsed disclosure.
    const summaryAt = idle.indexOf("Claude Opus 4.8 rejected");
    assert.ok(summaryAt >= 0, "the concise decision summary is rendered");
    assert.ok(
      summaryAt < firstButtonAt,
      `the summary (${summaryAt}) must precede the decision buttons (${firstButtonAt})`,
    );
    assert.match(idle, /1 blocker/);
    assert.match(
      idle,
      /class="evidence-fact[^"]*">7 tests passed</,
      "the verification count appears once, as a fact",
    );
    // The page's primary state is the semantic sentence, not the run status
    // word and not the raw gate key.
    assert.match(idle, /Review rejected — your call/);
    assert.ok(
      !/final_acceptance|final_verify/.test(idle),
      "no raw gate or stage keys in the evidence block",
    );
    assert.match(idle, /Technical details/);
    assert.equal(
      (idle.match(/<details class="disclosure">/g) ?? []).length,
      1,
      "one collapsed disclosure holds provenance, facts and decision help",
    );
    assert.match(
      idle,
      />Read full review</,
      "the sheet offers a secondary control that opens the Review tab",
    );
    assert.match(idle, /Override rejection and continue/);
    assert.ok(
      !/Reject with override/.test(idle),
      "the 'Reject with override' label is gone",
    );
    // No reason field until a reason-requiring decision is selected.
    assert.ok(
      !/id="approval-reason"/.test(idle),
      "the reason textarea is hidden until a decision is selected",
    );
    assert.ok(!/Confirm /.test(idle));

    const rejecting = renderToStaticMarkup(
      ApprovalPanel({
        evidence,
        options,
        selected: "reject",
        reason: "",
        busy: false,
        onSelect: () => undefined,
        onReasonChange: () => undefined,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }) as never,
    );
    assert.match(rejecting, /id="approval-reason"/);
    assert.match(rejecting, /Reason for rejecting/);
    assert.match(rejecting, /Confirm Reject/);
    // The confirm button stays disabled while the mandatory reason is empty.
    assert.match(
      rejecting,
      /<button type="button" class="btn btn--danger btn--sm" disabled="">Confirm Reject/,
    );
  },
);

check("the final acceptance gate offers Accept run", () => {
  const approval = {
    id: "ap2",
    runId: "run-1",
    stageKey: "final",
    taskId: null,
    attemptId: null,
    gate: "final_acceptance" as const,
    status: "PENDING" as const,
    allowed: ["approve", "reject"] as const,
    reason: null,
    requestedAt: "2026-09-22T12:00:00.000Z",
    decision: null,
    instruction: null,
    actor: null,
    decidedAt: null,
  };
  const options = approvalDecisionOptions({
    ...approval,
    allowed: [...approval.allowed],
  });
  const evidence = approvalEvidenceView({
    approval,
    reviewCycle: reviewCycleView({
      reviewCycle: 1,
      policy: { maxReviewCycles: 2 },
    }),
    verdicts: [],
    attempts: [],
  })!;
  const markup = renderToStaticMarkup(
    ApprovalPanel({
      evidence,
      options,
      facts: decisionFacts({ evidence, snapshots: [] }),
      selected: null,
      reason: "",
      busy: false,
      onSelect: () => undefined,
      onReasonChange: () => undefined,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }) as never,
  );
  assert.ok(!/>Approve</.test(markup), "no generic Approve at the final gate");
  assert.match(markup, />Accept run</);
  assert.match(markup, /No review verdict is recorded for this stage/);
  assert.match(markup, /No verification outcome is recorded/);
  assert.match(markup, />Reject</);
  // The sheet is compact: summary line, summary-level facts, one disclosure.
  assert.match(markup, /Ready to finish/);
  assert.match(markup, /No review verdict recorded/);
  assert.match(markup, /No verification outcome recorded/);
  assert.match(markup, /Changed files UNKNOWN/);
  assert.equal(
    (markup.match(/<details class="disclosure">/g) ?? []).length,
    1,
    "one collapsed technical disclosure, nothing else",
  );
  assert.ok(
    !/Read full review/.test(markup),
    "no full-review control without a verdict to read",
  );
  // Accepting takes no reason, so it never reveals the reason textarea.
  assert.ok(!/id="approval-reason"/.test(markup));
});

let failures = 0;
for (const entry of checks) {
  try {
    entry.run();
    console.log(`ok - ${entry.label}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${entry.label}`);
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
}

console.log(
  `${checks.length - failures}/${checks.length} render checks passed`,
);
if (failures > 0) process.exit(1);
