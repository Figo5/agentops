/**
 * Store tests: migrations, schema shape, CRUD/list/query coverage, guarded
 * transitions, immutability and transaction behaviour.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  buildStagePlan,
  BUILTIN_TEMPLATES,
  ensureBuiltinTemplates,
} from "../src/core/index.js";
import type {
  CommandSpec,
  RunPolicy,
  StagePlan,
  TemplateDefinition,
} from "../src/core/index.js";
import {
  LATEST_MIGRATION_VERSION,
  Store,
  migrate,
  schemaVersion,
  tableNames,
} from "../src/db/index.js";

const EXPECTED_TABLES = [
  "agent_sessions",
  "agents",
  "approvals",
  "artifacts",
  "events",
  "git_snapshots",
  "projects",
  "review_verdicts",
  "run_stages",
  "runs",
  "schema_migrations",
  "shell_commands",
  "task_attempts",
  "tasks",
  "test_runs",
  "workflow_stages",
  "workflow_templates",
];

function seededStore(): { store: Store; projectId: string; agentId: string } {
  const store = Store.memory();
  ensureBuiltinTemplates(store);
  const project = store.createProject({
    name: "fixture",
    canonicalRoot: "/tmp/agentops-store-fixture",
    verificationCommands: [{ name: "test", executable: "npm", args: ["test"] }],
  });
  const agent = store.createAgent({
    name: "mock-agent",
    adapterKind: "mock",
    model: "mock-model",
    config: { scenario: "success" },
  });
  return { store, projectId: project.id, agentId: agent.id };
}

function policyFor(
  store: Store,
  templateId: string,
  roleMapping: Record<string, string>,
): RunPolicy {
  const template = store.getTemplate(templateId);
  return {
    templateId,
    templateVersion: template?.version ?? 1,
    maxReviewCycles: template?.defaultMaxReviewCycles ?? 2,
    requireVerification: true,
    finalApprovalRequired: true,
    stopOnFailure: true,
    roleMapping,
    verificationCommands: [],
    gitPolicy: "read-only",
    stoppingRule: "stop when done",
  };
}

function createRunRow(
  store: Store,
  projectId: string,
  agentId: string,
  goal: string,
  templateId = "implement-review",
): string {
  const plan = store.getTemplatePlan(templateId) as StagePlan;
  const roleMapping = {
    planner: agentId,
    implementer: agentId,
    reviewer: agentId,
    researcher: agentId,
    documenter: agentId,
  };
  const run = store.createRun({
    projectId,
    templateId,
    goal,
    constraints: ["constraint-a"],
    roleMapping,
    policy: policyFor(store, templateId, roleMapping),
    plan,
  });
  return run.id;
}

describe("migrations", () => {
  it("applies every migration to a fresh database and records them", () => {
    const store = Store.memory();
    assert.equal(store.schemaVersion, LATEST_MIGRATION_VERSION);
    assert.deepEqual(
      store.migrations().map((migration) => migration.version),
      [1, 2],
    );
    assert.deepEqual(
      store.migrations().map((migration) => migration.name),
      ["core", "planned_records"],
    );
    assert.deepEqual(store.tables(), EXPECTED_TABLES);
    assert.equal(store.latestMigrationVersion, 2);
  });

  it("is idempotent", () => {
    const store = Store.memory();
    const before = store.migrations().length;
    const result = store.migrate();
    assert.deepEqual(result.applied, []);
    assert.equal(result.version, LATEST_MIGRATION_VERSION);
    assert.equal(store.migrations().length, before);
  });

  it("supports upgrading a v1 database in place without data loss", () => {
    const store = new Store({ path: ":memory:", migrateUpTo: 1 });
    assert.equal(store.schemaVersion, 1);
    assert.equal(store.tables().includes("artifacts"), false);
    assert.equal(store.tables().includes("shell_commands"), false);
    const project = store.createProject({
      name: "legacy",
      canonicalRoot: "/tmp/legacy",
    });

    const applied = store.migrate({ upTo: 2 });
    assert.deepEqual(applied.applied, [2]);
    assert.equal(store.schemaVersion, 2);
    assert.equal(store.tables().includes("artifacts"), true);
    assert.equal(store.tables().includes("git_snapshots"), true);
    assert.equal(
      store.getProject(project.id)?.name,
      "legacy",
      "pre-existing data survived the upgrade",
    );
  });

  it("exposes the raw handle for direct integration queries", () => {
    const store = Store.memory();
    const row = store.db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    assert.equal(Number(row?.["version"]), LATEST_MIGRATION_VERSION);
    assert.equal(schemaVersion(store.db), LATEST_MIGRATION_VERSION);
    assert.deepEqual(tableNames(store.db), EXPECTED_TABLES);
  });

  it("exposes migrate() as a standalone function", () => {
    const store = new Store({ path: ":memory:", migrate: false });
    assert.equal(store.schemaVersion, 0);
    const result = migrate(store.db);
    assert.deepEqual(result.applied, [1, 2]);
    assert.equal(store.schemaVersion, LATEST_MIGRATION_VERSION);
  });
});

describe("schema shape", () => {
  it("stores no BLOB columns anywhere", () => {
    const store = Store.memory();
    for (const table of store.tables()) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all();
      for (const column of columns) {
        assert.notEqual(
          String(column["type"]).toUpperCase(),
          "BLOB",
          `${table}.${String(column["name"])} must not be a BLOB`,
        );
      }
    }
  });

  it("enforces foreign keys with cascading cleanup", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "cascade me");
    const task = store.getTaskByStage(runId, "implement");
    assert.ok(task);
    store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 1,
      kind: "agent",
    });
    store.appendEvent({
      category: "run",
      type: "run.created",
      runId,
      projectId,
    });

    store.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    assert.equal(store.getRun(runId), undefined);
    assert.equal(store.getStages(runId).length, 0);
    assert.equal(store.listTasks(runId).length, 0);
    assert.equal(store.listAttemptsForRun(runId).length, 0);
    assert.equal(store.countEvents(runId), 0);
  });

  it("enforces the single active run per project at the schema level", () => {
    const { store, projectId, agentId } = seededStore();
    const first = createRunRow(store, projectId, agentId, "first");
    const second = createRunRow(store, projectId, agentId, "second");
    store.updateRunUnconditional(first, { status: "RUNNING" });
    assert.throws(
      () => store.updateRunUnconditional(second, { status: "RUNNING" }),
      /UNIQUE|constraint/i,
    );

    // A FAILED run does not hold the lease, but the first run still does.
    store.updateRunUnconditional(second, { status: "FAILED" });
    assert.throws(
      () => store.updateRunUnconditional(second, { status: "RUNNING" }),
      /UNIQUE|constraint/i,
    );
    store.updateRunUnconditional(first, { status: "COMPLETED" });
    store.updateRunUnconditional(second, { status: "RUNNING" });
    assert.equal(
      store.getRun(second)?.status,
      "RUNNING",
      "the lease moved to the next run",
    );
    assert.equal(store.getActiveRunForProject(projectId)?.id, second);
  });

  it("refuses a second run while one is active", () => {
    const { store, projectId, agentId } = seededStore();
    const first = createRunRow(store, projectId, agentId, "first");
    store.updateRunUnconditional(first, { status: "RUNNING" });
    assert.throws(
      () => createRunRow(store, projectId, agentId, "second"),
      ConflictError,
    );
    assert.equal(store.getActiveRunForProject(projectId)?.id, first);
    assert.throws(
      () =>
        store.createRun({
          projectId: "prj_missing",
          templateId: "implement-review",
          goal: "x",
          constraints: [],
          roleMapping: {},
          policy: policyFor(store, "implement-review", {}),
          plan: store.getTemplatePlan("implement-review") as StagePlan,
        }),
      NotFoundError,
    );
  });
});

describe("projects and agents", () => {
  it("round-trips projects", () => {
    const store = Store.memory();
    const created = store.createProject({
      name: "demo",
      canonicalRoot: "/tmp/demo-repo",
      defaultBranch: "main",
      verificationCommands: [
        {
          name: "test",
          executable: "npm",
          args: ["test"],
          cwd: null,
          timeoutMs: 1000,
        },
      ],
      settings: { nested: { value: 1 } },
    });
    assert.equal(created.vcs, "git");
    assert.equal(store.getProject(created.id)?.name, "demo");
    assert.equal(store.getProjectByRoot("/tmp/demo-repo")?.id, created.id);
    assert.equal(store.getProjectByRoot("/tmp/nope"), undefined);
    assert.deepEqual(
      store.listProjects().map((project) => project.id),
      [created.id],
    );
    assert.deepEqual(created.settings, { nested: { value: 1 } });

    const commands: CommandSpec[] = [
      { name: "lint", executable: "npm", args: ["run", "lint"] },
    ];
    const updated = store.updateProject(created.id, {
      verificationCommands: commands,
      archived: true,
    });
    assert.deepEqual(updated?.verificationCommands, commands);
    assert.equal(updated?.archived, true);
    assert.deepEqual(store.listProjects(), []);
    assert.equal(store.listProjects({ includeArchived: true }).length, 1);
  });

  it("round-trips agents and enforces unique names", () => {
    const store = Store.memory();
    const agent = store.createAgent({
      name: "a1",
      adapterKind: "mock",
      model: "m",
      effort: "low",
      config: { scenario: "fixes" },
    });
    assert.equal(store.getAgent(agent.id)?.config["scenario"], "fixes");
    assert.equal(store.getAgentByName("a1")?.id, agent.id);
    assert.deepEqual(
      store.listAgents({ enabledOnly: true }).map((entry) => entry.name),
      ["a1"],
    );
    assert.throws(
      () => store.createAgent({ name: "a1", adapterKind: "mock" }),
      /UNIQUE|constraint/i,
    );

    store.updateAgent(agent.id, { enabled: false, model: null });
    assert.equal(store.listAgents({ enabledOnly: true }).length, 0);
    assert.equal(store.listAgents().length, 1);
    assert.equal(store.getAgent(agent.id)?.model, null);
  });
});

describe("templates", () => {
  it("seeds the four built-in templates with their stages", () => {
    const store = Store.memory();
    const result = ensureBuiltinTemplates(store);
    assert.deepEqual(result.seeded.sort(), [
      "bug-fix",
      "doc-cleanup",
      "implement-review",
      "research",
    ]);
    assert.deepEqual(
      store
        .listTemplates()
        .map((template) => template.id)
        .sort(),
      ["bug-fix", "doc-cleanup", "implement-review", "research"],
    );
    for (const definition of BUILTIN_TEMPLATES) {
      const template = store.getTemplate(definition.id);
      assert.ok(template?.builtin);
      assert.equal(template?.version, 2);
      const plan = store.getTemplatePlan(definition.id) as StagePlan;
      assert.deepEqual(
        plan.stages.map((stage) => stage.key),
        buildStagePlan(definition).stages.map((stage) => stage.key),
      );
      assert.equal(
        store.getTemplateStages(definition.id).length,
        plan.stages.length,
      );
      // The final verification is persisted between the review and the human gate.
      const persisted = store
        .getTemplateStages(definition.id)
        .map((stage) => stage.key);
      assert.ok(
        persisted.includes("final_verify"),
        `${definition.id} persists a final verification stage`,
      );
      assert.ok(
        persisted.indexOf("final_verify") > persisted.indexOf("review"),
      );
      assert.equal(persisted.at(-1), "final");
    }
    assert.equal(store.getTemplatePlan("nope"), undefined);
    assert.equal(store.getTemplate("nope"), undefined);
  });

  it("re-seeding replaces stages instead of duplicating them", () => {
    const store = Store.memory();
    ensureBuiltinTemplates(store);
    const before = store.getTemplateStages("implement-review").length;
    ensureBuiltinTemplates(store);
    assert.equal(store.getTemplateStages("implement-review").length, before);
    assert.equal(store.listTemplates().length, 4);
  });

  it("keeps the frozen plan of an existing run when a template is re-seeded at a new version", () => {
    const store = Store.memory();
    ensureBuiltinTemplates(store);
    const project = store.createProject({
      name: "freeze",
      canonicalRoot: "/tmp/agentops-store-freeze",
      verificationCommands: [],
    });
    const agent = store.createAgent({
      name: "freeze-agent",
      adapterKind: "mock",
      config: { scenario: "success" },
    });

    // The pre-bump revision of implement-review: no planner stage, no final verification.
    const v1: TemplateDefinition = {
      id: "implement-review",
      name: "Implement and review",
      description: "version 1 shape",
      version: 1,
      defaultMaxReviewCycles: 2,
      stages: [
        {
          key: "implement",
          name: "Implementation",
          kind: "task",
          role: "implementer",
          instructions: "implement",
        },
        {
          key: "verify",
          name: "Verification",
          kind: "verify",
          role: "verifier",
          instructions: "verify",
        },
        {
          key: "review",
          name: "Structured review",
          kind: "review",
          role: "reviewer",
          instructions: "review",
          reviewLoop: {
            maxReviewCycles: 2,
            fixInstructions: "fix",
            retestInstructions: "retest",
          },
        },
        {
          key: "final",
          name: "Final human acceptance",
          kind: "final_approval",
          role: "human",
          instructions: "accept",
        },
      ],
    };
    store.upsertTemplate({ definition: v1, plan: buildStagePlan(v1) });

    const roleMapping = { implementer: agent.id, reviewer: agent.id };
    const run = store.createRun({
      projectId: project.id,
      templateId: "implement-review",
      goal: "frozen plan",
      constraints: [],
      roleMapping,
      policy: policyFor(store, "implement-review", roleMapping),
      plan: store.getTemplatePlan("implement-review") as StagePlan,
    });
    const v1Keys = [
      "implement",
      "verify",
      "review",
      "review.fix",
      "review.retest",
      "final",
    ];
    assert.equal(run.templateVersion, 1);
    assert.deepEqual(
      run.plan.stages.map((stage) => stage.key),
      v1Keys,
    );

    // Re-seeding the built-ins bumps the template record to version 2 ...
    const reseed = ensureBuiltinTemplates(store);
    assert.ok(
      reseed.updated.includes("implement-review"),
      "the version bump is reported",
    );
    assert.equal(store.getTemplate("implement-review")?.version, 2);
    assert.ok(
      store
        .getTemplateStages("implement-review")
        .some((stage) => stage.key === "final_verify"),
    );

    // ... while the already-created run keeps exactly the plan it was frozen with.
    const reloaded = store.getRun(run.id);
    assert.equal(reloaded?.templateVersion, 1);
    assert.equal(reloaded?.policy.templateVersion, 1);
    assert.deepEqual(
      reloaded?.plan.stages.map((stage) => stage.key),
      v1Keys,
    );
    assert.deepEqual(
      store.getStages(run.id).map((stage) => stage.key),
      v1Keys,
    );
    assert.equal(store.listTasks(run.id).length, v1Keys.length);
  });
});

describe("runs", () => {
  it("creates a run with its stage and task rows", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "goal text");
    const run = store.getRun(runId);
    assert.ok(run);
    assert.equal(run.status, "DRAFT");
    assert.equal(run.nextStageKey, "plan");
    assert.equal(run.reviewCycle, 1);
    assert.equal(run.epoch, 0);
    assert.deepEqual(run.constraints, ["constraint-a"]);
    assert.equal(run.projectRoot, "/tmp/agentops-store-fixture");
    assert.equal(run.plan.stages.length, 8);
    assert.equal(run.roleMapping["planner"], agentId);
    assert.equal(run.roleMapping["implementer"], agentId);

    const stages = store.getStages(runId);
    assert.equal(stages.length, 8);
    assert.equal(stages[0]?.status, "PENDING");
    assert.equal(stages[0]?.key, "plan");
    assert.equal(
      stages.find((stage) => stage.key === "review.fix")?.status,
      "SKIPPED",
    );
    assert.equal(store.getStageByKey(runId, "review")?.kind, "review");
    assert.equal(store.getStageByKey(runId, "final_verify")?.kind, "verify");
    assert.equal(
      store.getStageByKey(runId, "final_verify")?.conditional,
      false,
    );
    assert.equal(store.getStage("rst_missing"), undefined);
    const tasks = store.listTasks(runId);
    assert.equal(tasks.length, 8);
    assert.equal(store.getTaskByStage(runId, "final")?.kind, "final_approval");
  });

  it("lists and searches runs by project, goal, status, template, agent, branch and verdict", () => {
    const { store, projectId, agentId } = seededStore();
    const otherProject = store.createProject({
      name: "other",
      canonicalRoot: "/tmp/agentops-store-other",
    });

    const parserRun = createRunRow(
      store,
      projectId,
      agentId,
      "Fix the parser regression",
    );
    const docsRun = createRunRow(
      store,
      otherProject.id,
      agentId,
      "Clean up the documentation",
      "doc-cleanup",
    );
    store.updateRunUnconditional(parserRun, { status: "FAILED" });

    const task = store.getTaskByStage(parserRun, "implement");
    assert.ok(task);
    store.createAttempt({
      taskId: task.id,
      runId: parserRun,
      stageKey: "implement",
      attemptNumber: 1,
      kind: "agent",
      agentId,
    });
    store.insertGitSnapshot({
      runId: parserRun,
      stageKey: "implement",
      phase: "before",
      summary: {
        headSha: "abc",
        branch: "feature/parser",
        detached: false,
        dirty: false,
        staged: [],
        unstaged: [],
        untracked: [],
        diffStat: null,
        localCommits: [],
        ahead: 0,
        behind: 0,
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    store.insertReviewVerdict({
      runId: parserRun,
      taskId: task.id,
      attemptId: "att_x",
      stageKey: "review",
      cycle: 1,
      valid: true,
      validationErrors: [],
      verdict: "APPROVE_WITH_FIXES",
      summary: "needs fixes",
      raw: "{}",
    });

    assert.deepEqual(
      store.listRuns({ projectId }).map((run) => run.id),
      [parserRun],
    );
    assert.deepEqual(
      store.listRuns({ status: "FAILED" }).map((run) => run.id),
      [parserRun],
    );
    assert.equal(store.listRuns({ statuses: ["DRAFT"] }).length, 1);
    assert.equal(store.listRuns({ limit: 1 }).length, 1);

    assert.deepEqual(
      store.searchRuns({ goalContains: "parser" }).map((run) => run.id),
      [parserRun],
    );
    assert.deepEqual(
      store.searchRuns({ projectId: otherProject.id }).map((run) => run.id),
      [docsRun],
    );
    assert.deepEqual(
      store.searchRuns({ templateId: "doc-cleanup" }).map((run) => run.id),
      [docsRun],
    );
    assert.deepEqual(
      store.searchRuns({ agentId }).map((run) => run.id),
      [parserRun],
    );
    assert.deepEqual(
      store.searchRuns({ branch: "feature/parser" }).map((run) => run.id),
      [parserRun],
    );
    assert.deepEqual(
      store
        .searchRuns({ reviewVerdict: "APPROVE_WITH_FIXES" })
        .map((run) => run.id),
      [parserRun],
    );
    assert.deepEqual(
      store
        .searchRuns({ status: "FAILED", goalContains: "parser" })
        .map((run) => run.id),
      [parserRun],
    );
    assert.equal(
      store.searchRuns({ goalContains: "nothing matches" }).length,
      0,
    );

    const hit = store.searchRuns({ goalContains: "parser" })[0];
    assert.equal(hit?.branch, "feature/parser");
    assert.equal(hit?.lastReviewVerdict, "APPROVE_WITH_FIXES");
    assert.equal(store.searchRuns({ limit: 1, offset: 1 }).length, 1);
  });

  it("applies guarded updates as compare-and-set", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "guarded");
    assert.equal(
      store.updateRunGuarded(runId, ["RUNNING"], { status: "COMPLETED" }),
      null,
    );
    assert.equal(store.getRun(runId)?.status, "DRAFT");

    const started = store.updateRunGuarded(runId, ["DRAFT"], {
      status: "RUNNING",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(started?.status, "RUNNING");
    assert.equal(
      store.updateRunGuarded(runId, ["DRAFT"], { status: "COMPLETED" }),
      null,
    );

    const stage = store.getStageByKey(runId, "implement");
    assert.ok(stage);
    assert.equal(
      store.updateStageGuarded(stage.id, ["COMPLETED"], { status: "RUNNING" }),
      null,
    );
    assert.equal(
      store.updateStageGuarded(stage.id, ["PENDING"], { status: "RUNNING" })
        ?.status,
      "RUNNING",
    );
    assert.equal(
      store.updateStageGuarded(stage.id, ["PENDING"], { status: "FAILED" }),
      null,
      "guard is single-use",
    );
    assert.equal(
      store.updateRunGuarded("run_missing", ["RUNNING"], { status: "FAILED" }),
      null,
    );
  });
});

describe("attempts", () => {
  it("keeps attempt numbers unique and history immutable", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "attempts");
    const task = store.getTaskByStage(runId, "implement");
    assert.ok(task);
    const first = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 1,
      kind: "agent",
      agentId,
      promptText: "first prompt",
    });
    assert.throws(
      () =>
        store.createAttempt({
          taskId: task.id,
          runId,
          stageKey: "implement",
          attemptNumber: 1,
          kind: "agent",
        }),
      /UNIQUE|constraint/i,
    );
    const second = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 2,
      kind: "agent",
      agentId,
      reason: "retry",
      previousAttemptId: first.id,
    });
    assert.equal(second.previousAttemptId, first.id);
    assert.deepEqual(
      store.listAttempts(task.id).map((attempt) => attempt.attemptNumber),
      [1, 2],
    );
    assert.equal(store.lastAttempt(task.id)?.id, second.id);
    assert.equal(store.getAttemptPrompt(first.id)?.promptText, "first prompt");
    assert.equal(store.getAttemptPrompt("att_missing"), undefined);

    // A terminal attempt cannot be rewritten by a later write.
    store.updateAttemptGuarded(first.id, ["RUNNING"], {
      status: "COMPLETED",
      resultSummary: "done",
    });
    assert.equal(
      store.updateAttemptGuarded(first.id, ["RUNNING"], { status: "FAILED" }),
      null,
    );
    assert.equal(store.getAttempt(first.id)?.status, "COMPLETED");
    assert.equal(store.getAttempt(first.id)?.resultSummary, "done");
  });

  it("records usage round-trips including explicit UNKNOWN", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "usage");
    const task = store.getTaskByStage(runId, "implement");
    assert.ok(task);
    const unknown = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 1,
      kind: "agent",
    });
    assert.equal(unknown.usage, null);
    assert.equal(unknown.usageKnown, false);
    store.updateAttemptGuarded(unknown.id, ["RUNNING"], {
      status: "COMPLETED",
      usage: null,
      usageKnown: false,
    });
    assert.equal(store.getAttempt(unknown.id)?.usage, null);
    assert.equal(store.getAttempt(unknown.id)?.usageKnown, false);

    const known = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 2,
      kind: "agent",
    });
    store.updateAttemptGuarded(known.id, ["RUNNING"], {
      status: "COMPLETED",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: null,
        model: "m",
      },
      usageKnown: true,
    });
    assert.equal(store.getAttempt(known.id)?.usage?.totalTokens, 15);
    assert.equal(store.getAttempt(known.id)?.usageKnown, true);
  });

  it("only accepts operator input while an attempt waits for it", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "input");
    const task = store.getTaskByStage(runId, "implement");
    assert.ok(task);
    const attempt = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "implement",
      attemptNumber: 1,
      kind: "agent",
    });
    assert.equal(
      store.appendAttemptInput(attempt.id, "too early"),
      null,
      "RUNNING attempts do not accept input",
    );

    store.updateAttemptGuarded(attempt.id, ["RUNNING"], {
      status: "WAITING_INPUT",
    });
    const waiting = store.appendAttemptInput(attempt.id, "first input");
    assert.deepEqual(waiting?.inputs, ["first input"]);
    assert.equal(waiting?.status, "RUNNING");
    assert.equal(
      store.appendAttemptInput(attempt.id, "second input"),
      null,
      "the attempt is no longer waiting",
    );
    assert.equal(store.appendAttemptInput("att_missing", "x"), null);
    assert.deepEqual(store.getAttempt(attempt.id)?.inputs, ["first input"]);
    assert.equal(store.listLiveAttempts().length, 1);
    store.updateAttemptGuarded(attempt.id, ["RUNNING"], {
      status: "COMPLETED",
    });
    assert.equal(store.listLiveAttempts().length, 0);
  });
});

describe("events", () => {
  it("assigns monotonic ids and supports filtered reads", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "events");
    const first = store.appendEvent({
      category: "run",
      type: "run.created",
      runId,
      projectId,
    });
    const second = store.appendEvent({
      category: "stage",
      type: "stage.started",
      runId,
      projectId,
      stageKey: "implement",
    });
    const third = store.appendEvent({
      category: "run",
      type: "run.started",
      runId,
      projectId,
      actor: "operator",
      payload: { n: 1 },
    });
    assert.ok(first.id < second.id && second.id < third.id);
    assert.equal(third.actor, "operator");
    assert.deepEqual(third.payload, { n: 1 });

    assert.equal(store.listEvents({ runId }).length, 3);
    assert.deepEqual(
      store.listEvents({ runId, category: "run" }).map((event) => event.type),
      ["run.created", "run.started"],
    );
    assert.deepEqual(
      store.listEvents({ runId, type: "stage.started" }).length,
      1,
    );
    assert.equal(store.listEvents({ runId, afterId: first.id }).length, 2);
    assert.equal(store.listEvents({ runId, limit: 1 }).length, 1);
    assert.equal(store.countEvents(runId), 3);
    assert.equal(store.getEvent(second.id)?.stageKey, "implement");
    assert.equal(store.getEvent(999_999), undefined);
    assert.equal(store.listEvents({ projectId }).length, 3);
  });
});

describe("approvals and verdicts", () => {
  it("tracks a gate from request to decision exactly once", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "gate");
    const request = store.createApprovalRequest({
      runId,
      stageKey: "final",
      gate: "final_acceptance",
      allowed: ["approve", "reject"],
      reason: null,
    });
    assert.equal(request.status, "PENDING");
    assert.deepEqual(request.allowed, ["approve", "reject"]);
    assert.equal(store.getPendingApproval(runId)?.id, request.id);
    assert.equal(store.listPendingApprovals().length, 1);

    const decided = store.decideApproval(request.id, "approve", {
      instruction: "ship",
      actor: "operator",
    });
    assert.equal(decided?.status, "DECIDED");
    assert.equal(decided?.decision, "approve");
    assert.equal(decided?.instruction, "ship");
    assert.equal(decided?.actor, "operator");
    assert.ok(decided?.decidedAt);
    assert.equal(store.getPendingApproval(runId), undefined);
    assert.equal(
      store.decideApproval(request.id, "reject"),
      null,
      "a gate is decided once",
    );
    assert.equal(store.listApprovals(runId).length, 1);
    assert.equal(store.getApproval("apr_missing"), undefined);
  });

  it("supersedes pending gates and stores verdict validation failures", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "supersede");
    store.createApprovalRequest({
      runId,
      stageKey: "review",
      gate: "review_reject",
      allowed: ["override", "retry", "reject"],
    });
    assert.equal(
      store.supersedePendingApprovals(
        runId,
        "reject",
        "system:cancel",
        "run cancelled",
      ),
      1,
    );
    assert.equal(store.getPendingApproval(runId), undefined);
    assert.equal(
      store.supersedePendingApprovals(runId, "reject", "system:cancel"),
      0,
    );

    const invalid = store.insertReviewVerdict({
      runId,
      taskId: "tsk_x",
      attemptId: "att_x",
      stageKey: "review",
      cycle: 1,
      valid: false,
      validationErrors: [
        "verdict must be one of APPROVE, APPROVE_WITH_FIXES, REJECT",
      ],
      raw: '{"verdict":"MAYBE"}',
    });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.verdict, null);
    assert.equal(invalid.validationErrors.length, 1);
    const valid = store.insertReviewVerdict({
      runId,
      taskId: "tsk_x",
      attemptId: "att_y",
      stageKey: "review",
      cycle: 2,
      valid: true,
      validationErrors: [],
      verdict: "APPROVE",
      summary: "ok",
      issues: [{ severity: "minor", description: "nit" }],
      confidence: 0.9,
      reviewer: "mock",
      raw: "{}",
    });
    assert.equal(valid.verdict, "APPROVE");
    assert.deepEqual(valid.issues, [{ severity: "minor", description: "nit" }]);
    assert.equal(store.listReviewVerdicts(runId).length, 2);
    assert.equal(
      store.listReviewVerdicts(runId, { validOnly: true }).length,
      1,
    );
    assert.equal(
      store.listReviewVerdicts(runId, {
        stageKey: "review",
        validOnly: true,
      })[0]?.id,
      valid.id,
    );
    assert.equal(store.getReviewVerdict(valid.id)?.confidence, 0.9);
    assert.equal(store.getReviewVerdict("rev_missing"), undefined);
  });
});

describe("planned records", () => {
  it("stores git snapshots, commands, test runs and artifact references", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "records");
    const task = store.getTaskByStage(runId, "verify");
    assert.ok(task);
    const attempt = store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: "verify",
      attemptNumber: 1,
      kind: "verification",
    });

    const snapshot = store.insertGitSnapshot({
      runId,
      stageKey: "verify",
      attemptId: attempt.id,
      phase: "after",
      summary: {
        headSha: "deadbeef",
        branch: "main",
        detached: false,
        dirty: true,
        staged: ["a.ts"],
        unstaged: ["b.ts"],
        untracked: ["c.ts"],
        diffStat: "2 files changed",
        localCommits: [{ sha: "deadbeef", subject: "local work" }],
        ahead: 1,
        behind: 2,
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.equal(snapshot.dirty, true);
    assert.deepEqual(snapshot.unstagedPaths, ["b.ts"]);
    assert.deepEqual(snapshot.localCommits, [
      { sha: "deadbeef", subject: "local work" },
    ]);
    assert.equal(store.listGitSnapshots(runId).length, 1);

    const unavailable = store.insertGitSnapshot({
      runId,
      stageKey: "verify",
      phase: "before",
      summary: null,
      unavailableReason: "not a git repository",
    });
    assert.equal(unavailable.headSha, null);
    assert.equal(unavailable.unavailableReason, "not a git repository");

    const command = store.insertShellCommand({
      runId,
      stageKey: "verify",
      attemptId: attempt.id,
      name: "test",
      executable: "npm",
      args: ["test"],
      status: "failed",
      exitCode: 1,
      durationMs: 1200,
      stdoutExcerpt: "not ok 1",
      stderrExcerpt: "AssertionError",
      truncated: true,
    });
    assert.deepEqual(command.args, ["test"]);
    assert.equal(command.exitCode, 1);
    assert.equal(command.truncated, true);

    const testRun = store.insertTestRun({
      runId,
      stageKey: "verify",
      attemptId: attempt.id,
      framework: "node:test",
      status: "failed",
      passed: 3,
      failed: 1,
      skipped: 0,
      total: 4,
      parsedConfidently: true,
      summary: "3 passed, 1 failed",
      durationMs: 1200,
    });
    assert.equal(testRun.failed, 1);
    assert.equal(testRun.parsedConfidently, true);

    const artifact = store.insertArtifact({
      runId,
      stageKey: "implement",
      attemptId: attempt.id,
      path: "docs/report.md",
      kind: "document",
      creator: "agent:agt_1",
      note: "summary",
    });
    assert.equal(artifact.exists, true);
    assert.equal(artifact.sizeBytes, null);
    assert.equal(store.listArtifacts(runId).length, 1);
    assert.equal(store.listShellCommands(runId).length, 1);
    assert.equal(store.listTestRuns(runId).length, 1);
    assert.equal(store.getTestRun(testRun.id)?.passed, 3);
    assert.equal(store.getShellCommand(command.id)?.name, "test");
    assert.equal(store.getGitSnapshot(snapshot.id)?.branch, "main");
    assert.equal(store.getArtifact(artifact.id)?.path, "docs/report.md");
  });
});

describe("transactions and detail aggregate", () => {
  it("rolls back a failed transaction", () => {
    const store = Store.memory();
    assert.throws(() =>
      store.transaction(() => {
        store.createProject({ name: "ghost", canonicalRoot: "/tmp/ghost" });
        throw new Error("boom");
      }),
    );
    assert.equal(store.listProjects().length, 0);
  });

  it("supports nested transaction blocks as one unit", () => {
    const store = Store.memory();
    store.transaction(() => {
      store.createProject({ name: "outer", canonicalRoot: "/tmp/outer" });
      store.transaction(() => {
        store.createAgent({ name: "inner", adapterKind: "mock" });
      });
    });
    assert.equal(store.listProjects().length, 1);
    assert.equal(store.listAgents().length, 1);
  });

  it("rejects malformed identifiers instead of leaking driver errors", () => {
    const store = Store.memory();
    for (const bad of [undefined, null, "", 42, {}]) {
      assert.throws(
        () => store.getRun(bad as unknown as string),
        ValidationError,
      );
      assert.throws(
        () => store.getProject(bad as unknown as string),
        ValidationError,
      );
      assert.throws(
        () => store.getAgent(bad as unknown as string),
        ValidationError,
      );
      assert.throws(
        () => store.getRunDetail(bad as unknown as string),
        ValidationError,
      );
    }
    assert.throws(
      () =>
        store.updateRunGuarded(undefined as unknown as string, ["DRAFT"], {
          status: "RUNNING",
        }),
      ValidationError,
    );
    assert.throws(
      () =>
        store.updateStageGuarded(7 as unknown as string, ["PENDING"], {
          status: "RUNNING",
        }),
      ValidationError,
    );
    assert.equal(store.getRun("run_missing"), undefined);
  });

  it("returns a complete run detail aggregate", () => {
    const { store, projectId, agentId } = seededStore();
    const runId = createRunRow(store, projectId, agentId, "detail");
    store.appendEvent({
      category: "run",
      type: "run.created",
      runId,
      projectId,
    });
    store.createApprovalRequest({
      runId,
      stageKey: "final",
      gate: "final_acceptance",
      allowed: ["approve", "reject"],
    });
    store.insertReviewVerdict({
      runId,
      taskId: "tsk_x",
      attemptId: "att_x",
      stageKey: "review",
      cycle: 1,
      valid: true,
      validationErrors: [],
      verdict: "APPROVE",
      summary: "ok",
      raw: "{}",
    });
    const detail = store.getRunDetail(runId);
    assert.ok(detail);
    assert.equal(detail.run.id, runId);
    assert.equal(detail.plan.stages.length, 8);
    assert.equal(detail.stages.length, 8);
    assert.equal(detail.tasks.length, 8);
    assert.equal(detail.attempts.length, 0);
    assert.equal(detail.approvals.length, 1);
    assert.equal(detail.pendingApproval?.gate, "final_acceptance");
    assert.equal(detail.reviewVerdicts.length, 1);
    assert.equal(detail.events.length, 1);

    const withoutEvents = store.getRunDetail(runId, { includeEvents: false });
    assert.equal(withoutEvents?.events.length, 0);
    assert.equal(store.getRunDetail("run_missing"), undefined);
  });
});
