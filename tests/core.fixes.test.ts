/**
 * Bounded review fix-loop tests: fix -> retest -> review, cycle limits, human
 * escalation, overrides and loop-stage failure handling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "../src/core/index.js";
import {
  FakeVerificationExecutor,
  attemptOf,
  attemptsOf,
  cleanupTempDirs,
  createHarness,
  eventTypes,
  failedVerification,
  passedVerification,
  stageOf,
  startAndWait,
  statusesOf,
} from "./core.helpers.js";

describe("review fix loop", () => {
  it("runs fix -> retest -> review and approves on the second cycle", async (t) => {
    const verification = new FakeVerificationExecutor();
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 1 } },
      verification,
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun("implement-review", "loop me");
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.equal(detail.pendingApproval?.gate, "final_acceptance");
    assert.equal(detail.run.reviewCycle, 2);
    assert.deepEqual(statusesOf(detail), {
      plan: "COMPLETED",
      implement: "COMPLETED",
      verify: "COMPLETED",
      review: "COMPLETED",
      "review.fix": "COMPLETED",
      "review.retest": "COMPLETED",
      final_verify: "COMPLETED",
      final: "WAITING_APPROVAL",
    });

    const reviewAttempts = attemptsOf(detail, "review");
    assert.equal(reviewAttempts.length, 2);
    assert.equal(reviewAttempts[0]?.attemptNumber, 1);
    assert.equal(reviewAttempts[0]?.status, "COMPLETED");
    assert.equal(reviewAttempts[1]?.attemptNumber, 2);
    assert.equal(
      reviewAttempts[1]?.previousAttemptId,
      reviewAttempts[0]?.id,
      "cycle 2 references cycle 1",
    );

    const verdicts = harness.store.listReviewVerdicts(created.run.id, {
      stageKey: "review",
    });
    assert.deepEqual(
      verdicts.map((verdict) => verdict.verdict),
      ["APPROVE_WITH_FIXES", "APPROVE"],
    );
    assert.equal(verdicts[0]?.issues.length, 2);

    // The fix stage ran exactly once, with the reviewer's issues in its prompt.
    const fixAttempts = attemptsOf(detail, "review.fix");
    assert.equal(fixAttempts.length, 1);
    assert.equal(fixAttempts[0]?.status, "COMPLETED");
    assert.equal(stageOf(detail, "review.fix").cycle, 1);
    const fixPrompt = fixAttempts[0]?.promptText as string;
    assert.match(fixPrompt, /## Review context/);
    assert.match(fixPrompt, /Handle the empty-input case explicitly\./);
    assert.match(fixPrompt, /APPROVE_WITH_FIXES/);

    // Retest re-ran verification: once for the original verify stage, once here,
    // then once more for the final verification.
    const retestAttempts = attemptsOf(detail, "review.retest");
    assert.equal(retestAttempts.length, 1);
    assert.equal(retestAttempts[0]?.kind, "verification");
    assert.equal(retestAttempts[0]?.verification?.status, "passed");
    assert.deepEqual(
      verification.calls.map((call) => call.stage.key),
      ["verify", "review.retest", "final_verify"],
    );

    const types = eventTypes(detail);
    for (const expected of [
      "review.fixes_requested",
      "stage.reopened",
      "stage.activated",
    ]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
    const reopened = detail.events.find(
      (event) => event.type === "stage.reopened",
    );
    assert.equal(reopened?.stageKey, "review");
    assert.equal(reopened?.payload["nextCycle"], 2);

    const accepted = await harness.engine.decideApproval(
      created.run.id,
      "approve",
    );
    assert.equal(accepted.run.status, "COMPLETED");
    assert.equal(stageOf(accepted, "review.fix").status, "COMPLETED");
  });

  it("leaves the loop stages dormant when the review approves immediately", async (t) => {
    const harness = createHarness({
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun("implement-review", "no loop");
    const detail = await startAndWait(harness.engine, created.run.id);
    assert.equal(stageOf(detail, "review.fix").status, "SKIPPED");
    assert.equal(stageOf(detail, "review.fix").attemptCount, 0);
    assert.equal(attemptsOf(detail, "review.fix").length, 0);
    assert.equal(attemptsOf(detail, "review.retest").length, 0);
    assert.equal(harness.store.listReviewVerdicts(created.run.id).length, 1);
  });

  it("stops at a failing fix stage and resumes only after a deliberate retry", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: {
        reviewer: { fixAttempts: 1 },
        implementer: { failStageKeys: ["review.fix"] },
      },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun("implement-review", "fix will fail");
    const failed = await startAndWait(harness.engine, created.run.id);
    assert.equal(failed.run.status, "FAILED");
    assert.match(
      failed.run.failureReason ?? "",
      /injected failure for review.fix/,
    );
    assert.equal(stageOf(failed, "review.fix").status, "FAILED");
    assert.equal(
      stageOf(failed, "review.retest").status,
      "PENDING",
      "retest waits for a successful fix",
    );
    assert.equal(failed.run.nextStageKey, "review.fix");
    const firstFix = attemptOf(failed, "review.fix", 1);
    assert.equal(firstFix.status, "FAILED");
    assert.equal(firstFix.exitCode, 1);
    assert.equal(
      harness.store.listReviewVerdicts(created.run.id).length,
      1,
      "no second verdict yet",
    );

    // The operator clears the injected failure, then retries deliberately.
    harness.store.updateAgent(harness.agents.implementer.id, {
      config: { scenario: "success" },
    });
    const resumed = await harness.engine.retry(
      created.run.id,
      "transient fix failure",
    );
    assert.equal(resumed.run.status, "WAITING_APPROVAL");
    const fixAttempts = attemptsOf(resumed, "review.fix");
    assert.equal(fixAttempts.length, 2);
    assert.equal(
      fixAttempts[0]?.status,
      "FAILED",
      "the failed fix attempt is preserved",
    );
    assert.equal(fixAttempts[1]?.status, "COMPLETED");
    assert.equal(fixAttempts[1]?.previousAttemptId, firstFix.id);
    assert.equal(stageOf(resumed, "review.retest").status, "COMPLETED");
    assert.equal(attemptsOf(resumed, "review").length, 2);
  });

  it("escalates to a human gate when the review budget is exhausted", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 9 } },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "never good enough",
    );
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.equal(detail.pendingApproval?.gate, "review_cycle_exhausted");
    assert.deepEqual(detail.pendingApproval?.allowed, [
      "override",
      "retry",
      "reject",
    ]);
    assert.match(
      detail.pendingApproval?.reason ?? "",
      /2-cycle review budget is exhausted/,
    );
    assert.equal(stageOf(detail, "review").status, "WAITING_APPROVAL");
    assert.equal(
      attemptsOf(detail, "review").length,
      2,
      "bounded at maxReviewCycles",
    );
    assert.equal(
      attemptsOf(detail, "review.fix").length,
      1,
      "one fix cycle was attempted",
    );
    assert.equal(
      stageOf(detail, "final").status,
      "PENDING",
      "the final gate is not reachable yet",
    );
    assert.equal(
      stageOf(detail, "final_verify").status,
      "PENDING",
      "an exhausted review never reaches final verification",
    );

    await assert.rejects(
      () => harness.engine.decideApproval(created.run.id, "approve"),
      (error: unknown) =>
        error instanceof ValidationError &&
        /does not accept decision 'approve'/.test(error.message),
    );
  });

  it("records an override and still requires final verification and human final acceptance", async (t) => {
    const verification = new FakeVerificationExecutor();
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 9 } },
      verification,
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun("implement-review", "override me");
    const gated = await startAndWait(harness.engine, created.run.id);
    assert.equal(stageOf(gated, "review").status, "WAITING_APPROVAL");
    assert.equal(
      stageOf(gated, "final_verify").status,
      "PENDING",
      "final verification has not run yet",
    );
    const verificationCallsBeforeOverride = verification.calls.length;

    const overridden = await harness.engine.decideApproval(
      created.run.id,
      "override",
      "shipping with known minor issues",
    );

    assert.equal(
      overridden.run.status,
      "WAITING_APPROVAL",
      "the final gate replaces the review gate",
    );
    assert.equal(overridden.pendingApproval?.gate, "final_acceptance");
    assert.equal(overridden.pendingApproval?.allowed.length, 2);
    assert.equal(stageOf(overridden, "review").status, "COMPLETED");
    assert.equal(stageOf(overridden, "review").overridden, true);
    assert.equal(
      stageOf(overridden, "verify").status,
      "COMPLETED",
      "verification was not skipped",
    );
    // An override cannot skip the final verification: it runs again on the frozen
    // result before the human gate opens.
    assert.equal(stageOf(overridden, "final_verify").status, "COMPLETED");
    assert.equal(attemptOf(overridden, "final_verify", 1).kind, "verification");
    assert.equal(
      attemptOf(overridden, "final_verify", 1).verification?.status,
      "passed",
    );
    assert.equal(
      verification.calls.length,
      verificationCallsBeforeOverride + 1,
    );
    assert.equal(verification.calls.at(-1)?.stage.key, "final_verify");
    assert.equal(
      overridden.approvals.filter(
        (approval) => approval.gate === "review_cycle_exhausted",
      )[0]?.decision,
      "override",
    );
    assert.ok(eventTypes(overridden).includes("review.override_recorded"));

    const accepted = await harness.engine.decideApproval(
      created.run.id,
      "approve",
    );
    assert.equal(accepted.run.status, "COMPLETED");
    assert.equal(stageOf(accepted, "final_verify").status, "COMPLETED");
    assert.equal(
      accepted.approvals.filter(
        (approval) => approval.gate === "final_acceptance",
      ).length,
      1,
    );
  });

  it("stops an overridden run when the post-review final verification fails", async (t) => {
    const verification = new FakeVerificationExecutor([
      passedVerification("verify passed"),
      passedVerification("retest passed"),
      failedVerification("final state broke"),
    ]);
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 9 } },
      verification,
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun(
      "implement-review",
      "override then fail",
    );
    await startAndWait(harness.engine, created.run.id);
    const overridden = await harness.engine.decideApproval(
      created.run.id,
      "override",
      "accepting the review risk",
    );

    assert.equal(
      overridden.run.status,
      "FAILED",
      "the override cannot buy a passing final verification",
    );
    assert.match(
      overridden.run.failureReason ?? "",
      /verification failed: final state broke/,
    );
    assert.equal(stageOf(overridden, "final_verify").status, "FAILED");
    assert.equal(
      stageOf(overridden, "final").status,
      "PENDING",
      "the human gate was never reached",
    );
    assert.equal(overridden.pendingApproval, null);
    assert.equal(verification.calls.at(-1)?.stage.key, "final_verify");
  });

  it("retries a review cycle deliberately from an exhausted gate", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 9 } },
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
    const retried = await harness.engine.decideApproval(
      created.run.id,
      "retry",
      "one more cycle",
    );

    assert.equal(retried.run.status, "WAITING_APPROVAL");
    assert.equal(
      retried.pendingApproval?.gate,
      "review_cycle_exhausted",
      "the reviewer still asks for fixes",
    );
    const reviewAttempts = attemptsOf(retried, "review");
    assert.equal(reviewAttempts.length, 3, "a deliberate retry adds one cycle");
    assert.equal(reviewAttempts[2]?.reason, "operator retry: one more cycle");
    assert.equal(reviewAttempts[2]?.previousAttemptId, reviewAttempts[1]?.id);
    assert.equal(harness.store.listReviewVerdicts(created.run.id).length, 3);
  });

  it("fails the run when a human rejects the review gate", async (t) => {
    const harness = createHarness({
      scenarios: { reviewer: "rejection" },
      verification: new FakeVerificationExecutor(),
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });
    const created = await harness.makeRun(
      "implement-review",
      "rejected review",
    );
    const gated = await startAndWait(harness.engine, created.run.id);
    assert.equal(gated.run.status, "WAITING_APPROVAL");
    assert.equal(gated.pendingApproval?.gate, "review_reject");
    assert.equal(stageOf(gated, "verify").status, "COMPLETED");

    const failed = await harness.engine.decideApproval(
      created.run.id,
      "reject",
      "abandon this approach",
    );
    assert.equal(failed.run.status, "FAILED");
    assert.match(
      failed.run.failureReason ?? "",
      /review gate rejected by operator: abandon this approach/,
    );
    assert.equal(stageOf(failed, "review").status, "FAILED");
    assert.equal(
      stageOf(failed, "final_verify").status,
      "PENDING",
      "a rejected review never reaches final verification",
    );
    assert.equal(stageOf(failed, "final").status, "PENDING");
  });

  it("keeps verification mandatory for research and doc-cleanup templates too", async (t) => {
    t.after(() => cleanupTempDirs());
    const stagesBeforeVerify: Record<string, string[]> = {
      research: ["investigate", "experiment"],
      "doc-cleanup": ["audit", "update"],
    };
    for (const templateId of ["research", "doc-cleanup"]) {
      const verification = new FakeVerificationExecutor([
        { status: "failed", summary: "docs build broken" },
        passedVerification(),
      ]);
      const harness = createHarness({ verification });
      const created = await harness.makeRun(templateId, `run ${templateId}`);
      const detail = await startAndWait(harness.engine, created.run.id);
      assert.equal(
        detail.run.status,
        "FAILED",
        `${templateId} stops on failing verification`,
      );
      assert.equal(stageOf(detail, "verify").status, "FAILED");
      assert.equal(
        stageOf(detail, "final_verify").status,
        "PENDING",
        `${templateId} never skipped straight to final verification`,
      );
      for (const stageKey of stagesBeforeVerify[templateId] as string[]) {
        assert.equal(
          stageOf(detail, stageKey).status,
          "COMPLETED",
          `${templateId} ran ${stageKey} before verification`,
        );
      }
      const resumed = await harness.engine.retry(
        created.run.id,
        "verification environment fixed",
      );
      assert.equal(
        resumed.run.status,
        "WAITING_APPROVAL",
        `${templateId} reaches the human gate after a retry`,
      );
      assert.equal(resumed.pendingApproval?.gate, "final_acceptance");
      assert.equal(
        stageOf(resumed, "final_verify").status,
        "COMPLETED",
        `${templateId} re-verified the frozen result`,
      );
      const accepted = await harness.engine.decideApproval(
        created.run.id,
        "approve",
      );
      assert.equal(accepted.run.status, "COMPLETED");
      assert.deepEqual(
        verification.calls.map((call) => call.stage.key),
        ["verify", "verify", "final_verify"],
        `${templateId} ran verification once per verify attempt plus the final verification`,
      );
      await harness.close();
    }
  });

  it("runs the research critique loop against the implementer-owned experiment", async (t) => {
    const verification = new FakeVerificationExecutor();
    const harness = createHarness({
      scenarios: { reviewer: "fixes" },
      agentConfig: { reviewer: { fixAttempts: 1 } },
      verification,
    });
    t.after(async () => {
      await harness.close();
      cleanupTempDirs();
    });

    const created = await harness.makeRun("research", "experiment loop");
    const detail = await startAndWait(harness.engine, created.run.id);

    assert.equal(detail.run.status, "WAITING_APPROVAL");
    assert.deepEqual(statusesOf(detail), {
      investigate: "COMPLETED",
      experiment: "COMPLETED",
      verify: "COMPLETED",
      review: "COMPLETED",
      "review.fix": "COMPLETED",
      "review.retest": "COMPLETED",
      final_verify: "COMPLETED",
      final: "WAITING_APPROVAL",
    });
    // Each stage ran under the agent mapped to its own role.
    assert.equal(
      attemptOf(detail, "investigate", 1).agentId,
      harness.agentIds["researcher"],
    );
    assert.equal(
      attemptOf(detail, "experiment", 1).agentId,
      harness.agentIds["implementer"],
    );
    assert.equal(stageOf(detail, "review.fix").role, "implementer");
    assert.equal(
      attemptOf(detail, "review.fix", 1).agentId,
      harness.agentIds["implementer"],
      "the implementer revises the experiment",
    );
    assert.equal(attemptsOf(detail, "review").length, 2);
    assert.deepEqual(
      verification.calls.map((call) => call.stage.key),
      ["verify", "review.retest", "final_verify"],
    );
    const accepted = await harness.engine.decideApproval(
      created.run.id,
      "approve",
    );
    assert.equal(accepted.run.status, "COMPLETED");
  });
});
