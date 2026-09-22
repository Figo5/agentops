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
import { Home } from "../src/ui/components/Home.js";
import { RunRow } from "../src/ui/components/RunRow.js";
import { StageRail } from "../src/ui/components/StageRail.js";
import { buildStageRail } from "../src/ui/view-model.js";

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

check("first-run empty state guides project -> agents -> workflow", () => {
  const markup = renderToStaticMarkup(
    Home({ bootstrap: emptyBootstrap }) as never,
  );
  assert.match(markup, /No projects registered yet/);
  assert.match(markup, /Add a project/);
  assert.match(markup, /Configure agents/);
  assert.match(markup, /Start a workflow/);
  assert.match(markup, /Nothing is blocked on a human decision/);
  assert.match(markup, /No agents configured/);
  assert.match(markup, /No run is executing right now/);
});

check(
  "dashboard groups runs into waiting, active, attention and recent sections",
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
    const markup = renderToStaticMarkup(Home({ bootstrap }) as never);
    assert.match(markup, /Waiting for you/);
    assert.match(markup, /Ship the review loop/);
    assert.match(markup, /Refactor the rail/);
    assert.match(markup, /Broken fixture/);
    assert.match(markup, /Earlier work/);
    assert.match(markup, /WAITING FOR YOU/);
    assert.match(markup, /Fixture project/);
    assert.match(markup, /Implement and review/);
    // Counts are derived from the payload, never hard-coded.
    assert.match(markup, /<b>1<\/b> projects/);
    assert.match(markup, /<b>1<\/b> agents/);
    assert.match(markup, /<b>1<\/b> templates \/ <b>8<\/b> plan stages/);
    assert.match(markup, /Choose models and execution tools in Agents/);
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
    assert.match(bare, /FAILED/);
    assert.match(bare, /Fixture project/);
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
    assert.match(withDerived, /feature\/review-loop/);
    assert.match(withDerived, /REJECT/);
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
  assert.match(markup, /review cycle 1\/2 · active/);
  assert.match(markup, /WAITING FOR YOU/);
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
  } finally {
    globals.window = previous;
  }
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
