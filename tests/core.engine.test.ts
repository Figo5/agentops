/**
 * Engine behaviour tests: happy path, gates, failure stop, retry preservation,
 * input waits, artifact containment and run-creation validation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../src/core/index.js";
import {
  FakeSnapshotProvider,
  FakeVerificationExecutor,
  attemptOf,
  attemptsOf,
  cleanupTempDirs,
  createHarness,
  eventTypes,
  eventsOf,
  failedVerification,
  passedVerification,
  reload,
  stageOf,
  startAndWait,
  statusesOf,
} from "./core.helpers.js";

describe("run creation", () => {
  it("stores the full stage plan, role mapping and policy at creation", async (t) => {
    const harness = createHarness();
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const detail = await harness.makeRun(
      "implement-review",
      "Add a tokenizer",
      { constraints: ["no new dependencies"] },
    );
    assert.equal(detail.run.status, "DRAFT");
    assert.equal(
      detail.run.nextStageKey,
      "plan",
      "the read-only plan stage runs first",
    );
    assert.equal(detail.run.reviewCycle, 1);
    assert.deepEqual(
      detail.plan.stages.map((stage) => stage.key),
      [
        "plan",
        "implement",
        "verify",
        "review",
        "review.fix",
        "review.retest",
        "final_verify",
        "final",
      ],
    );
    assert.equal(detail.run.templateVersion, 2);
    assert.equal(
      detail.run.roleMapping["planner"],
      harness.agentIds["planner"],
    );
    assert.equal(
      detail.run.roleMapping["implementer"],
      harness.agentIds["implementer"],
    );
    assert.equal(
      detail.run.roleMapping["reviewer"],
      harness.agentIds["reviewer"],
    );
    assert.equal(
      Object.keys(detail.run.roleMapping).length,
      3,
      "verification and the human gate need no agent",
    );
    assert.equal(detail.run.policy.maxReviewCycles, 2);
    assert.equal(detail.run.policy.finalApprovalRequired, true);
    assert.equal(detail.run.policy.requireVerification, true);
    assert.deepEqual(detail.run.constraints, ["no new dependencies"]);
    assert.equal(detail.run.projectRoot, harness.projectRoot);

    // The final verification is a real plan stage between review and the human gate.
    const finalVerify = detail.plan.stages.find(
      (stage) => stage.key === "final_verify",
    );
    assert.equal(finalVerify?.kind, "verify");
    assert.equal(finalVerify?.role, "verifier");
    assert.equal(finalVerify?.conditional, false);
    assert.equal(
      detail.plan.stages.find((stage) => stage.key === "review")?.nextStageKey,
      "final_verify",
    );

    // Materialized stage rows: dormant loop stages start SKIPPED.
    assert.equal(stageOf(detail, "plan").status, "PENDING");
    assert.equal(stageOf(detail, "implement").status, "PENDING");
    assert.equal(stageOf(detail, "review.fix").status, "SKIPPED");
    assert.equal(
      stageOf(detail, "review.fix").skipReason,
      "loop_not_triggered",
    );
    assert.equal(stageOf(detail, "review.retest").status, "SKIPPED");
    assert.equal(stageOf(detail, "final_verify").status, "PENDING");
    assert.equal(stageOf(detail, "final").status, "PENDING");
    assert.deepEqual(eventTypes(detail), ["run.created", "run.plan_frozen"]);

    // The plan is inspectable before start.
    assert.equal(detail.tasks.length, detail.stages.length);
  });

  it("validates project, template, agents, goal and constraints", async (t) => {
    const harness = createHarness();
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    await assert.rejects(
      () =>
        harness.engine.createRun({
          projectId: "prj_missing",
          templateId: "implement-review",
          goal: "x",
          agents: {},
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        harness.engine.createRun({
          projectId: harness.projectId,
          templateId: "nope",
          goal: "x",
          agents: {},
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        harness.engine.createRun({
          projectId: harness.projectId,
          templateId: "implement-review",
          goal: "x",
          agents: {
            implementer: "agt_missing",
            reviewer: harness.agentIds["reviewer"] as string,
          },
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        harness.engine.createRun({
          projectId: harness.projectId,
          templateId: "implement-review",
          goal: "x",
          agents: { implementer: harness.agentIds["implementer"] as string },
        }),
      (error: unknown) =>
        error instanceof ValidationError &&
        /missing agent ids for: planner, reviewer/.test(error.message),
    );
    // The planner is a real agent-backed role: omitting only it is rejected too.
    await assert.rejects(
      () =>
        harness.engine.createRun({
          projectId: harness.projectId,
          templateId: "implement-review",
          goal: "x",
          agents: {
            implementer: harness.agentIds["implementer"] as string,
            reviewer: harness.agentIds["reviewer"] as string,
          },
        }),
      (error: unknown) =>
        error instanceof ValidationError &&
        /missing agent ids for: planner/.test(error.message),
    );
    await assert.rejects(
      () => harness.makeRun("implement-review", "   "),
      ValidationError,
    );
    await assert.rejects(
      () =>
        harness.makeRun(
          "implement-review",
          "use sk-abcdefghijklmnopqrstuvwxyz0123456789 to call the API",
        ),
      (error: unknown) =>
        error instanceof ValidationError && /credentials/.test(error.message),
    );
    assert.equal(
      harness.store.listRuns().length,
      0,
      "no run was created by rejected requests",
    );
  });
});

describe("happy path", () => {
  it("runs implement -> verify -> review, then waits for human final acceptance", async (t) => {
    const verification = new FakeVerificationExecutor();
    const snapshots = new FakeSnapshotProvider();
    const harness = createHarness({ verification, snapshots });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "Add a tokenizer",
    );
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.deepEqual(statusesOf(detail), {
      plan: "COMPLETED",
      implement: "COMPLETED",
      verify: "COMPLETED",
      review: "COMPLETED",
      "review.fix": "SKIPPED",
      "review.retest": "SKIPPED",
      final_verify: "COMPLETED",
      final: "WAITING_APPROVAL",
    });
    assert.ok(detail.pendingApproval, "a human gate is pending");
    assert.equal(detail.pendingApproval?.gate, "final_acceptance");
    assert.deepEqual(detail.pendingApproval?.allowed, ["approve", "reject"]);

    const types = eventTypes(detail);
    for (const expected of [
      "run.created",
      "run.started",
      "stage.started",
      "attempt.prompt_persisted",
      "attempt.completed",
      "stage.completed",
      "verification.passed",
      "review.verdict_valid",
      "approval.requested",
      "run.waiting_approval",
    ]) {
      assert.ok(
        types.includes(expected),
        `missing event ${expected} (have ${types.join(", ")})`,
      );
    }

    const completed = await harness.engine.decideApproval(
      created.run.id,
      "approve",
      "ship it",
    );
    assert.equal(completed.run.status, "COMPLETED");
    assert.equal(stageOf(completed, "final").status, "COMPLETED");
    assert.equal(completed.pendingApproval, null);
    assert.ok(completed.run.endedAt);
    const approval = completed.approvals.find(
      (candidate) => candidate.gate === "final_acceptance",
    );
    assert.equal(approval?.status, "DECIDED");
    assert.equal(approval?.decision, "approve");
    assert.equal(approval?.instruction, "ship it");
    assert.ok(eventTypes(completed).includes("run.completed"));

    // Verification ran twice — once per verify stage — with the project's commands.
    assert.equal(verification.calls.length, 2);
    assert.deepEqual(
      verification.calls.map((call) => call.stage.key),
      ["verify", "final_verify"],
    );
    for (const call of verification.calls) {
      assert.equal(call.commands.length, 1);
      assert.equal(call.commands[0]?.executable, "npm");
    }
  });

  it("persists prompt packets, verification records, checkpoints and usage per attempt", async (t) => {
    const snapshots = new FakeSnapshotProvider();
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
      snapshots,
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "Add a tokenizer",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    const runId = created.run.id;

    // Agent-executed stages persist the exact prompt; verification stages record
    // command provenance instead (there is no agent prompt to store).
    for (const stageKey of ["plan", "implement", "review"]) {
      const attempt = attemptOf(detail, stageKey, 1);
      assert.ok(
        attempt.promptText && attempt.promptText.length > 0,
        `${stageKey} persisted its prompt`,
      );
      assert.equal(attempt.promptPacket?.runId, runId);
      assert.equal(attempt.promptPacket?.stageKey, stageKey);
      assert.equal(attempt.promptPacket?.projectRoot, harness.projectRoot);
      assert.match(attempt.promptText as string, /Stopping rule/);
      assert.equal(attempt.status, "COMPLETED");
    }
    assert.equal(attemptOf(detail, "plan", 1).promptPacket?.role, "planner");
    for (const stageKey of ["verify", "final_verify"]) {
      const verifyAttempt = attemptOf(detail, stageKey, 1);
      assert.equal(verifyAttempt.promptText, null);
      assert.equal(verifyAttempt.promptPacket, null);
      assert.equal(verifyAttempt.kind, "verification");
      assert.equal(verifyAttempt.verification?.status, "passed");
    }
    const reviewPrompt = attemptOf(detail, "review", 1).promptText as string;
    assert.match(reviewPrompt, /Response contract \(review\)/);
    assert.match(reviewPrompt, /Add a tokenizer/);

    const reviewAttempt = attemptOf(detail, "review", 1);
    assert.equal(reviewAttempt.usageKnown, true);
    assert.equal(reviewAttempt.usage?.totalTokens, 1540);
    assert.equal(reviewAttempt.exitCode, 0);

    const verdicts = harness.store.listReviewVerdicts(runId);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.valid, true);
    assert.equal(verdicts[0]?.verdict, "APPROVE");
    assert.equal(verdicts[0]?.cycle, 1);

    const shellCommands = harness.store.listShellCommands(runId);
    assert.deepEqual(
      shellCommands.map((command) => command.stageKey),
      ["verify", "final_verify"],
      "both verification stages recorded the command they ran",
    );
    assert.ok(
      shellCommands.every(
        (command) =>
          command.executable === "npm" && command.status === "passed",
      ),
    );
    const testRuns = harness.store.listTestRuns(runId);
    assert.deepEqual(
      testRuns.map((testRun) => testRun.stageKey),
      ["verify", "final_verify"],
    );
    assert.ok(
      testRuns.every(
        (testRun) => testRun.passed === 3 && testRun.parsedConfidently === true,
      ),
    );

    const gitSnapshots = harness.store.listGitSnapshots(runId);
    assert.equal(
      gitSnapshots.filter((snapshot) => snapshot.phase === "before").length,
      5,
    );
    assert.equal(
      gitSnapshots.filter((snapshot) => snapshot.phase === "after").length,
      5,
    );
    assert.deepEqual(
      [...new Set(gitSnapshots.map((snapshot) => snapshot.stageKey))],
      ["plan", "implement", "verify", "review", "final_verify"],
      "every executed stage bracketed its work with checkpoints",
    );
    assert.ok(gitSnapshots.every((snapshot) => snapshot.branch === "main"));
    assert.ok(
      snapshots.calls.some(
        (call) => call.stage.key === "implement" && call.phase === "before",
      ),
    );

    // Every agent/human attempt in the run carries its own persisted packet.
    for (const attempt of detail.attempts) {
      if (attempt.kind === "agent")
        assert.ok(attempt.promptPacket, `attempt ${attempt.id} has a packet`);
    }
  });

  it("records no checkpoint when the snapshot provider is unavailable", async (t) => {
    const harness = createHarness({
      snapshots: new FakeSnapshotProvider("null"),
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "no snapshots");
    const detail = await startAndWait(harness.engine, created.run.id);
    const snapshots = harness.store.listGitSnapshots(created.run.id);
    assert.ok(snapshots.length >= 1);
    assert.ok(snapshots.every((snapshot) => snapshot.headSha === null));
    assert.ok(eventTypes(detail).includes("snapshot.unavailable"));
  });
});

describe("human gates", () => {
  it("refuses approval decisions on runs that are not waiting, and unknown decisions on a gate", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "gated");

    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "approve"),
      ConflictError,
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "override"),
      (error: unknown) =>
        error instanceof ValidationError &&
        /does not accept decision 'override'/.test(error.message),
    );
    await assert.rejects(
      () =>
        harness.engine.decideApproval(
          created.run.id,
          "approve",
          "token sk-abcdefghijklmnopqrstuvwxyz0123456789",
        ),
      ValidationError,
    );

    const completed = await harness.engine.decideApproval(
      created.run.id,
      "approve",
    );
    assert.equal(completed.run.status, "COMPLETED");
    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "approve"),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.startRun(created.run.id),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "again"),
      ConflictError,
    );
  });

  it("fails the run on a final rejection and requires a deliberate retry to resume", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "rejected work");
    await startAndWait(harness.engine, created.run.id);

    const failed = await harness.engine.decideApproval(
      created.run.id,
      "reject",
      "not acceptable",
    );
    assert.equal(failed.run.status, "FAILED");
    assert.match(failed.run.failureReason ?? "", /rejected by operator/);
    assert.equal(stageOf(failed, "final").status, "FAILED");
    assert.equal(attemptOf(failed, "final", 1).status, "FAILED");

    await assert.rejects(
      () => harness.engine.startRun(created.run.id),
      ConflictError,
    );
    const resumed = await harness.engine.retry(
      created.run.id,
      "operator wants another pass",
    );
    assert.equal(
      resumed.run.status,
      "WAITING_APPROVAL",
      "the gate reopens after a deliberate retry",
    );
    assert.equal(
      attemptOf(resumed, "final", 2).reason,
      "operator wants another pass",
    );
    const accepted = await harness.engine.decideApproval(
      created.run.id,
      "approve",
    );
    assert.equal(accepted.run.status, "COMPLETED");
  });
});

describe("review validation stops progression", () => {
  it("fails the run on a malformed verdict and records the validation failure", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "malformed-review" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "bad review");
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "FAILED");
    assert.match(detail.run.failureReason ?? "", /invalid review verdict/);
    assert.equal(stageOf(detail, "review").status, "FAILED");
    assert.equal(stageOf(detail, "implement").status, "COMPLETED");
    assert.equal(
      stageOf(detail, "final").status,
      "PENDING",
      "the human gate was never reached",
    );
    const attempt = attemptOf(detail, "review", 1);
    assert.equal(attempt.status, "FAILED");
    assert.equal(attempt.resultStatus, "invalid_review");
    assert.equal(
      attempt.exitCode,
      0,
      "the agent exited zero and was still rejected",
    );

    const verdicts = harness.store.listReviewVerdicts(created.run.id);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.valid, false);
    assert.ok((verdicts[0]?.validationErrors ?? []).length > 0);
    assert.equal(verdicts[0]?.verdict, null);
    assert.ok(eventTypes(detail).includes("review.verdict_invalid"));
    assert.ok(!eventTypes(detail).includes("run.completed"));
    assert.equal(detail.pendingApproval, null);

    // Only a deliberate retry resumes it.
    await assert.rejects(
      () => harness.engine.startRun(created.run.id),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "anything"),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "   "),
      ValidationError,
    );
  });

  it("re-runs the review stage after a deliberate retry following an invalid verdict", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "malformed-review" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "retry the review",
    );
    await startAndWait(harness.engine, created.run.id);

    // The reviewer is fixed up before retrying: a real operator would do the same.
    harness.store.updateAgent(harness.agents.reviewer.id, {
      config: { scenario: "success" },
    });
    const resumed = await harness.engine.retry(
      created.run.id,
      "reviewer tooling fixed",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");
    const attempts = attemptsOf(resumed, "review");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.status, "FAILED");
    assert.equal(attempts[1]?.status, "COMPLETED");
    assert.equal(attempts[1]?.previousAttemptId, attempts[0]?.id);
    assert.equal(attempts[1]?.attemptNumber, 2);
    assert.equal(harness.store.listReviewVerdicts(created.run.id).length, 2);
  });

  it("never infers approval from a zero exit code with no verdict", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "no-verdict" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "silent reviewer",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /exit code alone is not a verdict/,
    );
    assert.equal(attemptOf(detail, "review", 1).exitCode, 0);
    assert.equal(detail.pendingApproval, null);
  });
});

describe("task and agent failures stop progression", () => {
  it("stops at the first failing stage and leaves later stages pending", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "failure" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "will fail");
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "FAILED");
    assert.match(detail.run.failureReason ?? "", /mock scenario failure/);
    assert.deepEqual(statusesOf(detail), {
      plan: "COMPLETED",
      implement: "FAILED",
      verify: "PENDING",
      review: "PENDING",
      "review.fix": "SKIPPED",
      "review.retest": "SKIPPED",
      final_verify: "PENDING",
      final: "PENDING",
    });
    const attempt = attemptOf(detail, "implement", 1);
    assert.equal(attempt.status, "FAILED");
    assert.equal(attempt.exitCode, 1);
    assert.equal(attempt.usage, null);
    assert.equal(
      attempt.usageKnown,
      false,
      "null usage means UNKNOWN, not zero",
    );
    assert.ok(eventTypes(detail).includes("stage.failed"));
    assert.ok(eventTypes(detail).includes("agent.failed"));
  });

  it("stops when the mapped agent cannot be started", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "unavailable" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "unavailable agent",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(detail.run.failureReason ?? "", /unavailable/);
    assert.equal(stageOf(detail, "implement").status, "FAILED");
    assert.equal(
      stageOf(detail, "plan").status,
      "COMPLETED",
      "planning happened before the failure",
    );
    const implementSessions = harness.store
      .listAgentSessions(created.run.id)
      .filter((session) => session.agentId === harness.agents.implementer.id);
    assert.equal(
      implementSessions.length,
      0,
      "no session was registered for the unavailable agent",
    );
  });

  it("stops when the agent reports unavailability as a result", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "unavailable-result" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "unavailable result",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(detail.run.failureReason ?? "", /agent unavailable/);
  });

  it("stops when the mapped agent is disabled", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    harness.store.updateAgent(harness.agents.implementer.id, {
      enabled: false,
    });
    const created = await harness.makeRun("implement-review", "disabled agent");
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(detail.run.failureReason ?? "", /is disabled/);
  });

  it("stops when no adapter is registered for the agent kind", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const oddAgent = harness.store.createAgent({
      name: "cli-unknown",
      adapterKind: "cli-unknown",
      config: {},
    });
    const created = await harness.makeRun("implement-review", "no adapter", {
      roles: { implementer: oddAgent.id },
    });
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /no adapter is registered for adapter kind 'cli-unknown'/,
    );
  });
});

describe("retry", () => {
  it("creates a new immutable attempt and preserves the failed one", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "failure-then-success" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "flaky task");
    const failed = await startAndWait(harness.engine, created.run.id);
    assert.equal(failed.run.status, "FAILED");

    const firstAttempt = attemptOf(failed, "implement", 1);
    const firstPrompt = firstAttempt.promptText as string;
    const firstSnapshot = { ...firstAttempt };

    const resumed = await harness.engine.retry(
      created.run.id,
      "transient failure, retrying",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");

    const attempts = attemptsOf(resumed, "implement");
    assert.equal(attempts.length, 2, "exactly one new attempt");
    assert.equal(attempts[0]?.id, firstAttempt.id);
    assert.equal(
      attempts[0]?.status,
      "FAILED",
      "the failed attempt is untouched",
    );
    assert.equal(attempts[0]?.resultSummary, firstSnapshot.resultSummary);
    assert.equal(attempts[0]?.promptText, firstPrompt);
    assert.equal(attempts[0]?.endedAt, firstSnapshot.endedAt);
    assert.equal(attempts[1]?.attemptNumber, 2);
    assert.equal(attempts[1]?.status, "COMPLETED");
    assert.equal(attempts[1]?.reason, "transient failure, retrying");
    assert.equal(attempts[1]?.previousAttemptId, firstAttempt.id);
    assert.notEqual(
      attempts[1]?.promptText,
      firstPrompt,
      "the retry prompt carries prior-attempt context",
    );
    assert.match(
      attempts[1]?.promptText as string,
      /## Prior attempts on this stage/,
    );
    assert.equal(
      harness.store.listAttempts(attempts[0]?.taskId as string).length,
      2,
    );
    assert.ok(eventTypes(resumed).includes("run.retried"));
  });

  it("refuses retry from states that are not FAILED or INTERRUPTED", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "states");
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "too early"),
      ConflictError,
    );
    await startAndWait(harness.engine, created.run.id);
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "gate is pending"),
      (error: unknown) =>
        error instanceof ConflictError &&
        /only FAILED or INTERRUPTED runs can be retried/.test(error.message),
    );
    await harness.engine.decideApproval(created.run.id, "approve");
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "terminal"),
      ConflictError,
    );
  });
});

describe("verification stages", () => {
  it("stops on a failing verification and only resumes after a deliberate retry", async (t) => {
    const verification = new FakeVerificationExecutor([
      failedVerification("2 tests failed"),
      passedVerification("all green"),
    ]);
    const harness = createHarness({ verification });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "verify me");
    const failed = await startAndWait(harness.engine, created.run.id);

    assert.equal(failed.run.status, "FAILED");
    assert.match(
      failed.run.failureReason ?? "",
      /verification failed: 2 tests failed/,
    );
    assert.equal(stageOf(failed, "verify").status, "FAILED");
    assert.equal(
      stageOf(failed, "review").status,
      "PENDING",
      "the review never ran",
    );
    const verifyAttempt = attemptOf(failed, "verify", 1);
    assert.equal(verifyAttempt.verification?.status, "failed");
    assert.equal(verifyAttempt.verification?.mode, "fake");
    assert.equal(verifyAttempt.exitCode, 1);
    assert.equal(verifyAttempt.usage, null);
    const shellCommands = harness.store.listShellCommands(created.run.id);
    assert.equal(shellCommands[0]?.status, "failed");
    assert.equal(shellCommands[0]?.exitCode, 1);
    assert.equal(harness.store.listTestRuns(created.run.id)[0]?.failed, 2);

    const resumed = await harness.engine.retry(
      created.run.id,
      "fixed the failing test",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");
    assert.equal(stageOf(resumed, "verify").status, "COMPLETED");
    assert.equal(attemptOf(resumed, "verify", 2).status, "COMPLETED");
    assert.equal(
      stageOf(resumed, "final_verify").status,
      "COMPLETED",
      "the final verification ran after the retry",
    );
    assert.deepEqual(
      verification.calls.map((call) => call.stage.key),
      ["verify", "verify", "final_verify"],
    );
  });

  it("fails closed when the verification executor is missing", async (t) => {
    const verification = new FakeVerificationExecutor([
      {
        status: "unavailable",
        summary: "no runner registered",
        reason: "executor-missing",
      },
    ]);
    const harness = createHarness({ verification });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "no runner");
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /verification unavailable: no runner registered/,
    );
    assert.equal(attemptOf(detail, "verify", 1).verification?.mode, "fake");
  });

  it("fails closed when the verification executor throws", async (t) => {
    const verification = new FakeVerificationExecutor([
      { status: "unavailable", summary: "x", reason: "throw" },
    ]);
    const harness = createHarness({ verification });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "exploding runner",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /verification executor failed: fake verification executor exploded/,
    );
  });

  it("fails closed when no verification commands are configured", async (t) => {
    // With no configured commands there is nothing to verify: the default
    // executor refuses to claim that verification happened.
    const harness = createHarness({ verificationCommands: [] });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "no commands");
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /no verification commands are configured/,
    );
    const verifyAttempt = attemptOf(detail, "verify", 1);
    assert.equal(verifyAttempt.status, "FAILED");
    assert.equal(verifyAttempt.verification?.status, "unavailable");
    assert.equal(
      verifyAttempt.verification?.reason,
      "no-verification-commands",
    );
    assert.equal(verifyAttempt.verification?.mode, "fail-closed");
    assert.equal(verifyAttempt.verification?.commandCount, 0);
    assert.equal(
      harness.store.listShellCommands(created.run.id).length,
      0,
      "no command evidence is fabricated",
    );
    assert.equal(
      harness.store.listTestRuns(created.run.id).length,
      0,
      "no test evidence is fabricated",
    );
    assert.equal(detail.pendingApproval, null);
  });

  it("fails closed when commands are configured but no executor is registered", async (t) => {
    // No injected executor: the engine's default pass-through executor must not
    // claim that configured commands were run.
    const harness = createHarness({
      verificationCommands: [
        { name: "test", executable: "npm", args: ["test"] },
      ],
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "commands without a runner",
    );
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "FAILED");
    assert.match(
      detail.run.failureReason ?? "",
      /no verification executor is registered/,
    );
  });
});

describe("operator input", () => {
  it("waits for input, resumes on sendInput and records the input", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "input-required" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "needs input");
    const waiting = await startAndWait(harness.engine, created.run.id);

    assert.equal(waiting.run.status, "WAITING_INPUT");
    assert.equal(stageOf(waiting, "implement").status, "WAITING_INPUT");
    const attempt = attemptOf(waiting, "implement", 1);
    assert.equal(attempt.status, "WAITING_INPUT");
    assert.match(attempt.resultSummary ?? "", /waiting for operator input/);
    assert.deepEqual(attempt.inputs, []);
    assert.ok(eventTypes(waiting).includes("input.requested"));

    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "  "),
      ValidationError,
    );
    await assert.rejects(
      () =>
        harness.engine.sendInput(
          created.run.id,
          "sk-abcdefghijklmnopqrstuvwxyz0123456789",
        ),
      ValidationError,
    );

    const resumed = await harness.engine.sendInput(
      created.run.id,
      "target the staging environment",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");
    assert.equal(stageOf(resumed, "implement").status, "COMPLETED");
    const resumedAttempt = attemptOf(resumed, "implement", 1);
    assert.equal(
      resumedAttempt.id,
      attempt.id,
      "the same attempt resumes after input",
    );
    assert.deepEqual(resumedAttempt.inputs, ["target the staging environment"]);
    assert.equal(resumedAttempt.status, "COMPLETED");
    const supplied = eventsOf(resumed, "input.supplied");
    assert.equal(supplied.length, 1);
    assert.equal(
      supplied[0]?.payload["chars"],
      "target the staging environment".length,
    );
    assert.equal(supplied[0]?.actor, "operator");
  });

  it("rejects input when the run is not waiting for it", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "no input needed",
    );
    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "hello"),
      ConflictError,
    );
    await startAndWait(harness.engine, created.run.id);
    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "hello"),
      (error: unknown) =>
        error instanceof ConflictError &&
        /is WAITING_APPROVAL/.test(error.message),
    );
  });
});

describe("artifacts and usage", () => {
  it("records repository-relative artifacts and rejects escaping paths", async (t) => {
    const harness = createHarness({
      agentConfig: {
        implementer: {
          artifacts: [
            { path: "docs/report.md", kind: "document", note: "summary" },
          ],
        },
      },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "artifacts");
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    const attempt = attemptOf(detail, "implement", 1);
    assert.equal(attempt.artifacts[0]?.path, "docs/report.md");
    const artifacts = harness.store.listArtifacts(created.run.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.kind, "document");
    assert.equal(
      artifacts[0]?.creator,
      `agent:${harness.agents.implementer.id}`,
    );
    assert.ok(eventTypes(detail).includes("attempt.completed"));
  });

  it("fails the stage when an artifact reference escapes the repository", async (t) => {
    for (const badPath of [
      "../secrets.env",
      "/etc/passwd",
      "src/../../escape.txt",
    ]) {
      const harness = createHarness({
        agentConfig: {
          implementer: { artifacts: [{ path: badPath, kind: "file" }] },
        },
        verification: new FakeVerificationExecutor(),
      });
      const created = await harness.makeRun(
        "implement-review",
        "escaping artifact",
      );
      const detail = await startAndWait(harness.engine, created.run.id);
      assert.equal(
        detail.run.status,
        "FAILED",
        `path ${badPath} must fail the stage`,
      );
      assert.match(
        detail.run.failureReason ?? "",
        /artifact reference rejected/,
      );
      assert.equal(harness.store.listArtifacts(created.run.id).length, 0);
      await harness.close();
    }
    cleanupTempDirs();
  });

  it("keeps explicitly unknown usage as UNKNOWN", async (t) => {
    const harness = createHarness({
      agentConfig: { implementer: { usage: null } },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "unknown usage");
    const detail = await startAndWait(harness.engine, created.run.id);
    const attempt = attemptOf(detail, "implement", 1);
    assert.equal(attempt.status, "COMPLETED");
    assert.equal(attempt.usage, null);
    assert.equal(attempt.usageKnown, false);
    const reviewAttempt = attemptOf(detail, "review", 1);
    assert.equal(
      reviewAttempt.usageKnown,
      true,
      "other attempts still report measured usage",
    );
  });
});

describe("cancellation basics", () => {
  it("cancels a draft run and refuses to restart or approve it", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "cancel me");
    const cancelled = await harness.engine.cancel(
      created.run.id,
      "operator changed their mind",
    );
    assert.equal(cancelled.run.status, "CANCELLED");
    assert.equal(cancelled.run.cancelReason, "operator changed their mind");
    assert.ok(eventTypes(cancelled).includes("run.cancelled"));
    await assert.rejects(
      () => harness.engine.startRun(created.run.id),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "approve"),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.cancel(created.run.id),
      ConflictError,
    );

    // The project lease is released, so a new run can be created.
    const second = await harness.makeRun("implement-review", "second attempt");
    assert.equal(second.run.status, "DRAFT");
  });

  it("getRun returns undefined for unknown runs and the full detail for known ones", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    assert.equal(harness.engine.getRun("run_missing"), undefined);
    const created = await harness.makeRun("research", "investigate");
    const detail = reload(harness.engine, created.run.id);
    assert.equal(detail.stages.length, 8);
    assert.equal(detail.tasks.length, 8);
    assert.equal(detail.attempts.length, 0);
    assert.equal(detail.events.length >= 2, true);
    assert.deepEqual(
      detail.stages.map((stage) => stage.key),
      [
        "investigate",
        "experiment",
        "verify",
        "review",
        "review.fix",
        "review.retest",
        "final_verify",
        "final",
      ],
    );
  });
});
