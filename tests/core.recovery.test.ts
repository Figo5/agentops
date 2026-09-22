/**
 * Startup interruption recovery tests. These use a file-backed database so a
 * second engine can observe what the first one left behind.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ConflictError, Engine } from "../src/core/index.js";
import { Store } from "../src/db/index.js";
import {
  FakeVerificationExecutor,
  attemptOf,
  attemptsOf,
  cleanupTempDirs,
  createHarness,
  eventTypes,
  reload,
  stageOf,
  tempDir,
  waitForStageStatus,
} from "./core.helpers.js";

describe("startup interruption recovery", () => {
  it("marks live attempts INTERRUPTED and resumes only through a deliberate retry", async (t) => {
    const dir = tempDir("agentops-recovery");
    const dbPath = path.join(dir, "agentops.sqlite");
    const harness = createHarness({
      dbPath,
      scenarios: { implementer: "long-running" },
    });
    t.after(async () => {
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "interrupted work",
    );
    const starting = harness.engine
      .startRun(created.run.id)
      .catch(() => undefined);
    await waitForStageStatus(harness.engine, created.run.id, "implement", [
      "RUNNING",
    ]);
    assert.equal(harness.store.getRun(created.run.id)?.status, "RUNNING");
    assert.equal(
      stageOf(reload(harness.engine, created.run.id), "plan").status,
      "COMPLETED",
    );
    const live = harness.store.listLiveAgentSessions();
    assert.equal(
      live.length,
      1,
      "the session handle is still open in the database",
    );
    assert.equal(
      live[0]?.agentId,
      harness.agents.implementer.id,
      "only the in-flight stage owns a live session",
    );

    // A fresh engine over the same database performs recovery.
    const store2 = new Store({ path: dbPath });
    const engine2 = new Engine({
      store: store2,
      recoverOnStart: false,
      verification: new FakeVerificationExecutor(),
    });
    const report = engine2.recoverInterrupted();

    assert.deepEqual(report.interruptedRuns, [created.run.id]);
    assert.equal(report.interruptedAttempts.length, 1);
    assert.equal(report.interruptedStages.length, 1);
    assert.equal(report.releasedSessions.length, 1);
    assert.deepEqual(report.pendingApprovals, []);

    const detail = engine2.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "INTERRUPTED");
    assert.match(
      detail.run.interruptReason ?? "",
      /restarted while the run was executing/,
    );
    assert.equal(stageOf(detail, "implement").status, "INTERRUPTED");
    assert.equal(attemptOf(detail, "implement", 1).status, "INTERRUPTED");
    assert.equal(attemptOf(detail, "implement", 1).resultStatus, "interrupted");
    assert.ok(eventTypes(detail).includes("run.interrupted"));
    assert.equal(
      detail.run.epoch >= 2,
      true,
      "the interruption epoch was bumped",
    );

    // Runtime handles are released without signalling any persisted PID.
    const sessions = store2.listAgentSessions(created.run.id);
    assert.equal(
      sessions.length,
      2,
      "one session per agent-backed stage that started",
    );
    const interrupted = sessions.filter(
      (session) => session.status === "interrupted",
    );
    assert.equal(
      interrupted.length,
      1,
      "only the in-flight session was touched",
    );
    assert.equal(interrupted[0]?.agentId, harness.agents.implementer.id);
    assert.match(
      interrupted[0]?.cancelReason ?? "",
      /process was not signalled/,
    );
    const completed = sessions.filter(
      (session) => session.status === "completed",
    );
    assert.equal(
      completed.length,
      1,
      "the finished plan session is left alone",
    );
    assert.equal(completed[0]?.agentId, harness.agents.planner.id);
    assert.equal(store2.listLiveAgentSessions().length, 0);

    // Recovery is idempotent.
    const second = engine2.recoverInterrupted();
    assert.deepEqual(second.interruptedRuns, []);
    assert.deepEqual(second.interruptedAttempts, []);
    assert.deepEqual(second.releasedSessions, []);

    // Only a deliberate retry resumes the run.
    await assert.rejects(() => engine2.startRun(created.run.id), ConflictError);
    store2.updateAgent(harness.agents.implementer.id, {
      config: { scenario: "success" },
    });
    const resumed = await engine2.retry(
      created.run.id,
      "resuming after restart",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");
    const attempts = attemptsOf(resumed, "implement");
    assert.equal(attempts.length, 2);
    assert.equal(
      attempts[0]?.status,
      "INTERRUPTED",
      "the interrupted attempt is preserved as evidence",
    );
    assert.equal(attempts[1]?.status, "COMPLETED");
    assert.equal(attempts[1]?.previousAttemptId, attempts[0]?.id);
    assert.equal(attempts[1]?.reason, "resuming after restart");
    const accepted = await engine2.decideApproval(created.run.id, "approve");
    assert.equal(accepted.run.status, "COMPLETED");

    await engine2.shutdown();
    store2.close();
    await harness.engine.shutdown();
    await starting;
    harness.store.close();
  });

  it("keeps pending human gates pending across a restart", async (t) => {
    const dir = tempDir("agentops-recovery-gate");
    const dbPath = path.join(dir, "agentops.sqlite");
    const harness = createHarness({
      dbPath,
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "gate across restart",
    );
    const starting = harness.engine.startRun(created.run.id);
    await harness.engine.waitForStatus(created.run.id, ["WAITING_APPROVAL"]);
    await starting;
    const beforeRestart = harness.engine.getRun(created.run.id);
    assert.ok(beforeRestart);
    const gateAttemptId = beforeRestart.pendingApproval?.attemptId;
    await harness.engine.shutdown();
    harness.store.close();

    const store2 = new Store({ path: dbPath });
    const engine2 = new Engine({
      store: store2,
      verification: new FakeVerificationExecutor(),
    });
    const detail = engine2.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.equal(detail.pendingApproval?.gate, "final_acceptance");
    assert.equal(detail.pendingApproval?.status, "PENDING");
    assert.equal(detail.pendingApproval?.attemptId, gateAttemptId);
    assert.equal(stageOf(detail, "final").status, "WAITING_APPROVAL");
    assert.equal(
      attemptOf(detail, "final", 1).status,
      "RUNNING",
      "a human gate attempt is not an execution",
    );
    assert.ok(!eventTypes(detail).includes("run.interrupted"));

    const accepted = await engine2.decideApproval(
      created.run.id,
      "approve",
      "accepted after restart",
    );
    assert.equal(accepted.run.status, "COMPLETED");
    assert.equal(accepted.approvals[0]?.instruction, "accepted after restart");

    await engine2.shutdown();
    store2.close();
  });

  it("reports nothing to recover on a clean database", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const report = harness.engine.recoverInterrupted();
    assert.deepEqual(report, {
      interruptedRuns: [],
      interruptedAttempts: [],
      interruptedStages: [],
      releasedSessions: [],
      pendingApprovals: [],
    });
  });

  it("leaves completed runs untouched by recovery", async (t) => {
    const dir = tempDir("agentops-recovery-complete");
    const dbPath = path.join(dir, "agentops.sqlite");
    const harness = createHarness({
      dbPath,
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "completed work");
    const starting = harness.engine.startRun(created.run.id);
    await harness.engine.waitForStatus(created.run.id, ["WAITING_APPROVAL"]);
    await starting;
    await harness.engine.decideApproval(created.run.id, "approve");
    const attemptsBefore = harness.store
      .listAttemptsForRun(created.run.id)
      .map((attempt) => attempt.status);
    await harness.engine.shutdown();
    harness.store.close();

    const store2 = new Store({ path: dbPath });
    const engine2 = new Engine({
      store: store2,
      verification: new FakeVerificationExecutor(),
    });
    const detail = engine2.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "COMPLETED");
    assert.deepEqual(
      store2
        .listAttemptsForRun(created.run.id)
        .map((attempt) => attempt.status),
      attemptsBefore,
    );
    assert.equal(store2.getRun(created.run.id)?.interruptReason, null);
    await engine2.shutdown();
    store2.close();
  });
});
