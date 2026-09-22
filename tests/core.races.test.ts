/**
 * Concurrency and race tests: duplicate starts, the single-active-run lease,
 * cancellation races with late completions, concurrent retries and approvals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError } from "../src/core/index.js";
import {
  FakeVerificationExecutor,
  attemptOf,
  attemptsOf,
  cleanupTempDirs,
  createHarness,
  eventTypes,
  eventsOf,
  stageOf,
  startAndWait,
  statusesOf,
  waitForStageStatus,
} from "./core.helpers.js";
import type { Harness } from "./core.helpers.js";

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("duplicate and concurrent starts", () => {
  it("lets exactly one concurrent start win", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "double start");

    const results = await Promise.allSettled([
      harness.engine.startRun(created.run.id),
      harness.engine.startRun(created.run.id),
      harness.engine.startRun(created.run.id),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "one start wins");
    assert.equal(rejected.length, 2, "the others conflict");
    for (const result of rejected) {
      assert.ok(
        result.status === "rejected" && result.reason instanceof ConflictError,
      );
    }

    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.equal(
      attemptsOf(detail, "implement").length,
      1,
      "no duplicate attempt was created",
    );
    assert.equal(attemptsOf(detail, "verify").length, 1);
    assert.equal(attemptsOf(detail, "review").length, 1);
    assert.equal(attemptsOf(detail, "final_verify").length, 1);
    assert.equal(eventsOf(detail, "run.started").length, 1);
    assert.equal(
      detail.attempts.length,
      6,
      "plan, implement, verify, review, final verify, human gate",
    );
  });

  it("keeps a single active run per project root", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const first = await harness.makeRun("implement-review", "first");
    const second = await harness.makeRun("implement-review", "second"); // both DRAFT: allowed
    await startAndWait(harness.engine, first.run.id);

    await assert.rejects(
      () => harness.engine.startRun(second.run.id),
      (error: unknown) =>
        error instanceof ConflictError &&
        /already has an active run/.test(error.message),
    );
    await assert.rejects(
      () => harness.makeRun("research", "third"),
      (error: unknown) =>
        error instanceof ConflictError &&
        /already has an active run/.test(error.message),
    );

    await harness.engine.decideApproval(first.run.id, "approve");
    const third = await harness.makeRun("research", "third");
    assert.equal(third.run.status, "DRAFT");
    const started = await startAndWait(harness.engine, third.run.id);
    assert.equal(started.run.status, "WAITING_APPROVAL");
  });

  it("serializes concurrent transition calls without duplicating attempts", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "concurrent noise",
    );
    const [start] = await Promise.allSettled([
      harness.engine.startRun(created.run.id),
      settle(1),
    ]);
    assert.equal(start.status, "fulfilled");
    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    const perStage = new Map<string, number>();
    for (const attempt of detail.attempts) {
      perStage.set(attempt.stageKey, (perStage.get(attempt.stageKey) ?? 0) + 1);
    }
    assert.deepEqual([...perStage.entries()].sort(), [
      ["final", 1],
      ["final_verify", 1],
      ["implement", 1],
      ["plan", 1],
      ["review", 2],
      ["review.fix", 1],
      ["review.retest", 1],
      ["verify", 1],
    ]);
  });
});

describe("cancellation races", () => {
  it("cancels a long-running stage and refuses late completion", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "long-running" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "long runner");

    const starting = harness.engine
      .startRun(created.run.id)
      .catch(() => undefined);
    // The run reports RUNNING from its first stage, so wait for the stage that
    // is actually supposed to be running here.
    const running = await waitForStageStatus(
      harness.engine,
      created.run.id,
      "implement",
      ["RUNNING"],
    );
    assert.equal(
      stageOf(running, "plan").status,
      "COMPLETED",
      "the plan stage finished first",
    );
    assert.equal(stageOf(running, "implement").status, "RUNNING");
    assert.equal(attemptOf(running, "implement", 1).status, "RUNNING");

    const cancelled = await harness.engine.cancel(
      created.run.id,
      "operator stopped it",
    );
    assert.equal(cancelled.run.status, "CANCELLED");
    assert.equal(cancelled.run.cancelReason, "operator stopped it");
    await starting;

    // Give any late completion a chance to (wrongly) land.
    await settle(30);
    const after = harness.engine.getRun(created.run.id);
    assert.ok(after);
    assert.equal(after.run.status, "CANCELLED");
    assert.equal(stageOf(after, "implement").status, "CANCELLED");
    assert.equal(
      stageOf(after, "verify").status,
      "PENDING",
      "nothing ran after cancellation",
    );
    assert.equal(attemptOf(after, "implement", 1).status, "CANCELLED");
    assert.equal(attemptOf(after, "implement", 1).resultStatus, "cancelled");
    assert.ok(!eventTypes(after).includes("run.completed"));
    assert.equal(
      eventsOf(after, "attempt.completed").filter(
        (event) => event.stageKey === "implement",
      ).length,
      0,
      "the cancelled attempt never completed",
    );
    assert.equal(eventsOf(after, "run.cancelled").length, 1);

    // Terminal: nothing can move it afterwards.
    await assert.rejects(
      () => harness.engine.startRun(created.run.id),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.retry(created.run.id, "nope"),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.cancel(created.run.id),
      ConflictError,
    );
    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "hello"),
      ConflictError,
    );
  });

  it("cancels while an attempt waits for operator input", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "input-required" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "cancel while waiting",
    );
    const waiting = await startAndWait(harness.engine, created.run.id);
    assert.equal(waiting.run.status, "WAITING_INPUT");

    const cancelled = await harness.engine.cancel(
      created.run.id,
      "no longer needed",
    );
    assert.equal(cancelled.run.status, "CANCELLED");
    assert.equal(attemptOf(cancelled, "implement", 1).status, "CANCELLED");
    await assert.rejects(
      () => harness.engine.sendInput(created.run.id, "too late"),
      ConflictError,
    );
  });

  it("cancels while a human gate is pending and supersedes the gate", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "cancel the gate",
    );
    await startAndWait(harness.engine, created.run.id);
    assert.ok(harness.store.getPendingApproval(created.run.id));

    const cancelled = await harness.engine.cancel(created.run.id, "withdrawn");
    assert.equal(cancelled.run.status, "CANCELLED");
    assert.equal(cancelled.pendingApproval, null, "the pending gate is closed");
    assert.equal(harness.store.getPendingApproval(created.run.id), undefined);
    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "approve"),
      ConflictError,
    );
  });

  it("resolves a cancellation race with a concurrent approval exactly once", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "race the gate");
    await startAndWait(harness.engine, created.run.id);

    const results = await Promise.allSettled([
      harness.engine.decideApproval(created.run.id, "approve"),
      harness.engine.cancel(created.run.id, "racing cancel"),
    ]);
    const final = harness.engine.getRun(created.run.id);
    assert.ok(final);
    assert.ok(
      ["COMPLETED", "CANCELLED"].includes(final.run.status),
      `unexpected final status ${final.run.status}`,
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "only one transition was accepted");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof ConflictError,
    );
    const terminalEvents =
      eventsOf(final, "run.completed").length +
      eventsOf(final, "run.cancelled").length;
    assert.equal(terminalEvents, 1, "exactly one terminal event");
  });
});

describe("concurrent retries and approvals", () => {
  it("accepts only one of two concurrent retries", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "failure" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "double retry");
    await startAndWait(harness.engine, created.run.id);

    const results = await Promise.allSettled([
      harness.engine.retry(created.run.id, "first retry"),
      harness.engine.retry(created.run.id, "second retry"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "one retry wins");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof ConflictError,
    );

    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(
      attemptsOf(detail, "implement").length,
      2,
      "exactly one new attempt",
    );
    assert.equal(eventsOf(detail, "run.retried").length, 1);
    assert.equal(
      detail.run.status,
      "FAILED",
      "the retried stage fails again with the failing agent",
    );
  });

  it("accepts only one of two concurrent approval decisions", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "double approval",
    );
    await startAndWait(harness.engine, created.run.id);

    const results = await Promise.allSettled([
      harness.engine.decideApproval(created.run.id, "approve", "first"),
      harness.engine.decideApproval(created.run.id, "approve", "second"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "one decision wins");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof ConflictError,
    );

    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "COMPLETED");
    assert.equal(detail.approvals.length, 1);
    assert.equal(detail.approvals[0]?.status, "DECIDED");
    assert.equal(eventsOf(detail, "approval.decided").length, 1);
    assert.equal(eventsOf(detail, "run.completed").length, 1);
  });

  it("handles a concurrent input send without duplicating the attempt", async (t) => {
    const harness = createHarness({
      scenarios: { implementer: "input-required" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "double input");
    await startAndWait(harness.engine, created.run.id);

    const results = await Promise.allSettled([
      harness.engine.sendInput(created.run.id, "use staging"),
      harness.engine.sendInput(created.run.id, "use production"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "one input is accepted");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof ConflictError,
    );

    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(attemptsOf(detail, "implement").length, 1);
    assert.equal(attemptOf(detail, "implement", 1).inputs.length, 1);
    assert.equal(eventsOf(detail, "input.supplied").length, 1);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
  });

  it("does not create duplicate drivers when several actions race on a settled run", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "driver dedupe");
    await Promise.allSettled([
      harness.engine.startRun(created.run.id),
      settle(1).then(() => harness.engine.startRun(created.run.id)),
    ]);
    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.equal(
      harness.engine.isDriving(created.run.id),
      false,
      "the driver released the run at the gate",
    );
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
  });
});

describe("shutdown", () => {
  it("stops in-flight drivers without mutating persisted state", async (t) => {
    const harness: Harness = createHarness({
      scenarios: { implementer: "long-running" },
      verification: new FakeVerificationExecutor(),
    });
    const created = await harness.makeRun("implement-review", "shutdown me");
    const starting = harness.engine
      .startRun(created.run.id)
      .catch(() => undefined);
    await waitForStageStatus(harness.engine, created.run.id, "implement", [
      "RUNNING",
    ]);

    await harness.engine.shutdown();
    await starting;
    const detail = harness.engine.getRun(created.run.id);
    assert.ok(detail);
    assert.equal(
      detail.run.status,
      "RUNNING",
      "shutdown leaves the run for restart recovery",
    );
    assert.equal(attemptOf(detail, "implement", 1).status, "RUNNING");
    assert.ok(!eventTypes(detail).includes("run.cancelled"));

    // A restart of the same database marks it interrupted.
    const engine2 = harness.engine;
    assert.equal(engine2.isShuttingDown, true);
    cleanupTempDirs();
  });
});
