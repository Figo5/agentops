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
  ProjectRecord,
  RunRecord,
  StageRecord,
  TaskRecord,
} from "../src/core/types.js";
import { buildStagePlan, builtinTemplate } from "../src/core/templates.js";
import type { Bootstrap } from "../src/ui/api.js";
import { App } from "../src/ui/App.js";
import { ApprovalPanel } from "../src/ui/components/ApprovalPanel.js";
import { ClampedText, TabPanel, Tabs } from "../src/ui/components/Bits.js";
import { Home } from "../src/ui/components/Home.js";
import { RunRow } from "../src/ui/components/RunRow.js";
import { StageRail } from "../src/ui/components/StageRail.js";
import {
  approvalDecisionOptions,
  approvalEvidenceView,
  buildStageRail,
  reviewCycleView,
} from "../src/ui/view-model.js";

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
    // Time-appropriate greeting (14:00 local) and an honest attention count.
    assert.match(markup, /class="page-title"/);
    assert.match(markup, /Good (morning|afternoon|evening)|Still up/);
    assert.match(markup, /2 need you · 1 running/);
    assert.match(markup, /1 project/);
    // Three calm sections, each with its rows.
    assert.match(markup, /Needs you/);
    assert.match(markup, /Running/);
    assert.match(markup, /Recent/);
    assert.match(markup, /Ship the review loop/);
    assert.match(markup, /Refactor the rail/);
    assert.match(markup, /Broken fixture/);
    assert.match(markup, /Earlier work/);
    // Primary project name plus one semantic status and a clear action link.
    assert.match(markup, /Fixture project/);
    assert.match(markup, /title="Waiting for you \(WAITING_APPROVAL\)"/);
    assert.match(
      markup,
      /class="run-row__link" href="#\/run\/run-waiting">Review/,
    );
    assert.match(
      markup,
      /class="run-row__link" href="#\/run\/run-failed">Retry/,
    );
    assert.match(markup, /class="run-row__link" href="#\/run\/run-done">View/);
    // No inventory and no template/stage identifiers in the rows.
    assert.ok(
      !/Workspace|Templates on this server|plan stages|agents \(/.test(markup),
      "the operational home is not an inventory",
    );
    assert.ok(
      !/implement-review|v1 ·|8 stages|plan stages/.test(markup),
      "no template or stage identifiers on the home rows",
    );
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
    // Projects count sits at the bottom as a link.
    assert.match(markup, /class="home-foot"/);
    assert.match(markup, /href="#\/projects">1 project/);
    assert.match(markup, /href="#\/runs">Run history/);
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
    assert.match(bare, /Fixture project/);
    assert.match(bare, /class="run-row__link" href="#\/run\/run-failed">Retry/);
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

check("the stage rail renders the review branch as a branch", () => {
  const stages: StageRecord[] = [
    stage("implement", "COMPLETED", {
      attemptCount: 1,
      summary: "implemented",
    }),
    stage("verify", "COMPLETED"),
    stage("review", "WAITING_APPROVAL", { cycle: 1, attemptCount: 2 }),
    stage("review.fix", "COMPLETED", { cycle: 1, attemptCount: 1 }),
    stage("review.retest", "RUNNING", { cycle: 1 }),
  ];
  const tasks: TaskRecord[] = [];
  const rail = buildStageRail(plan, stages, tasks, [agent], "review");
  const markup = renderToStaticMarkup(
    StageRail({
      rail,
      selectedKey: "review",
      onSelect: () => undefined,
      runStatus: "WAITING_APPROVAL",
    }) as never,
  );
  assert.match(markup, /Stage rail/);
  assert.match(markup, /Structured review/);
  assert.match(markup, /Structured review: fixes/);
  assert.match(markup, /Structured review: re-verification/);
  assert.match(markup, /fixes from review cycle 1 of 2 · active/);
  assert.match(markup, /Waiting for you/);
  assert.match(markup, /2\/6 non-conditional stages completed/);
  assert.match(
    markup,
    /This branch ran: a verdict asked for fixes, then re-verification/,
  );
  assert.ok(
    !/Fixture agent/.test(markup),
    "a review stage with no agent shows no agent name",
  );
});

check("a dormant review branch says so instead of inventing a cycle", () => {
  const dormant = renderToStaticMarkup(
    StageRail({
      rail: buildStageRail(
        plan,
        [stage("implement", "RUNNING")],
        [],
        [agent],
        "implement",
      ),
      selectedKey: "implement",
      onSelect: () => undefined,
      runStatus: "RUNNING",
    }) as never,
  );
  assert.match(dormant, /dormant/);
  assert.match(
    dormant,
    /only a review verdict of APPROVE_WITH_FIXES activates this branch/,
  );
  assert.match(dormant, /0\/6 non-conditional stages completed/);
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
    // No version is claimed before the bootstrap payload arrives.
    assert.match(markup, /vunavailable/);
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
        selected: null,
        reason: "",
        busy: false,
        onSelect: () => undefined,
        onReasonChange: () => undefined,
        onCancel: () => undefined,
        onConfirm: () => undefined,
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
    assert.match(idle, /empty input throws/);
    assert.match(idle, /src\/parser\.ts:42/);
    // Real payload shape: the verdict omits `reviewer`, the counts are null in
    // the verification record but confident in the normalized test run.
    assert.match(idle, /Claude Opus 4\.8/);
    assert.match(idle, /resolved through the verdict/);
    assert.match(idle, /Command passed · 7\/7 passed/);
    assert.match(idle, /counts from the normalized test run node:test/);
    // The default view of the evidence is short: reviewer + verdict and the
    // latest verification, in front of the controls, with the full payload one
    // level down in disclosures (nothing is hidden or deleted).
    const summaryAt = idle.indexOf("Claude Opus 4.8 rejected");
    assert.ok(summaryAt >= 0, "the concise evidence summary is rendered");
    assert.ok(
      summaryAt < firstButtonAt,
      `the evidence summary (${summaryAt}) must precede the decision buttons (${firstButtonAt})`,
    );
    assert.match(idle, /1 blocker/);
    assert.match(idle, /Verification: 7 tests passed/);
    // The page's primary state is the semantic sentence, not the run status
    // word and not the raw gate key.
    assert.match(idle, /Review rejected — your call/);
    assert.ok(
      !/final_acceptance|final_verify/.test(idle),
      "no raw gate or stage keys in the evidence block",
    );
    assert.match(idle, /Read full review/);
    assert.match(idle, /Technical details/);
    assert.equal(
      (idle.match(/<details class="disclosure">/g) ?? []).length,
      3,
      "review prose, provenance and decision help are all disclosures",
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
      selected: null,
      reason: "",
      busy: false,
      onSelect: () => undefined,
      onReasonChange: () => undefined,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }) as never,
  );
  assert.match(markup, />Accept run</);
  assert.ok(!/>Approve</.test(markup), "no generic Approve at the final gate");
  assert.match(markup, /No review verdict is recorded for this stage/);
  assert.match(markup, /No verification outcome is recorded/);
  assert.match(markup, />Reject</);
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
