/**
 * Pure rule tests: transition guards, plan building, review verdict validation,
 * redaction and prompt rendering. No database, no adapters, no timers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_TEMPLATES,
  BUILTIN_TEMPLATE_VERSION,
  FINAL_VERIFY_STAGE_KEY,
  GuardError,
  PLAN_STAGE_KEY,
  ValidationError,
  agentBackedRoles,
  allowedApprovalDecisions,
  assertNoCredentials,
  assertRunTransition,
  assertStageTransition,
  buildStagePlan,
  builtinTemplate,
  canTransitionAttempt,
  canTransitionRun,
  canTransitionStage,
  canTransitionTask,
  describePlan,
  entryStageKey,
  findCredentials,
  formatReviewVerdict,
  isAttemptImmutable,
  isTerminalRunStatus,
  planEntry,
  redactSecrets,
  renderPromptText,
  reviewVerdictBranch,
  STOPPING_RULE,
  validateReviewVerdict,
} from "../src/core/index.js";
import type {
  StagePlan,
  StagePlanEntry,
  TemplateDefinition,
} from "../src/core/index.js";

function plan(templateId: string, maxReviewCycles?: number): StagePlan {
  const definition = BUILTIN_TEMPLATES.find(
    (candidate) => candidate.id === templateId,
  );
  if (!definition) throw new Error(`template ${templateId} missing`);
  return buildStagePlan(
    definition,
    maxReviewCycles === undefined ? {} : { maxReviewCycles },
  );
}

function entry(planValue: StagePlan, key: string): StagePlanEntry {
  const found = planEntry(planValue, key);
  if (!found) throw new Error(`entry ${key} missing`);
  return found;
}

describe("run transitions", () => {
  it("allows the documented run transitions", () => {
    assert.equal(canTransitionRun("DRAFT", "RUNNING"), true);
    assert.equal(canTransitionRun("RUNNING", "WAITING_APPROVAL"), true);
    assert.equal(canTransitionRun("RUNNING", "WAITING_INPUT"), true);
    assert.equal(canTransitionRun("WAITING_APPROVAL", "RUNNING"), true);
    assert.equal(canTransitionRun("WAITING_INPUT", "RUNNING"), true);
    assert.equal(canTransitionRun("FAILED", "RUNNING"), true);
    assert.equal(canTransitionRun("INTERRUPTED", "RUNNING"), true);
  });

  it("refuses to restart terminal runs", () => {
    assert.equal(canTransitionRun("COMPLETED", "RUNNING"), false);
    assert.equal(canTransitionRun("CANCELLED", "RUNNING"), false);
    assert.equal(canTransitionRun("COMPLETED", "FAILED"), false);
    assert.throws(
      () => assertRunTransition("COMPLETED", "RUNNING"),
      GuardError,
    );
    assert.equal(isTerminalRunStatus("COMPLETED"), true);
    assert.equal(isTerminalRunStatus("FAILED"), false);
  });

  it("does not allow skipping straight from DRAFT to a waiting state", () => {
    assert.equal(canTransitionRun("DRAFT", "WAITING_APPROVAL"), false);
    assert.equal(canTransitionRun("DRAFT", "COMPLETED"), false);
  });
});

describe("stage and task transitions", () => {
  it("supports dormant loop stages becoming active and skipped", () => {
    assert.equal(canTransitionStage("SKIPPED", "PENDING"), true);
    assert.equal(canTransitionStage("PENDING", "SKIPPED"), true);
    assert.equal(
      canTransitionStage("COMPLETED", "PENDING"),
      true,
      "review stages reopen for the next cycle",
    );
    assert.equal(canTransitionStage("CANCELLED", "PENDING"), false);
    assert.throws(
      () => assertStageTransition("CANCELLED", "RUNNING"),
      GuardError,
    );
  });

  it("treats terminal attempts as immutable", () => {
    assert.equal(isAttemptImmutable("COMPLETED"), true);
    assert.equal(isAttemptImmutable("FAILED"), true);
    assert.equal(isAttemptImmutable("RUNNING"), false);
    assert.equal(canTransitionAttempt("COMPLETED", "FAILED"), false);
    assert.equal(canTransitionAttempt("RUNNING", "FAILED"), true);
    assert.equal(canTransitionAttempt("WAITING_INPUT", "RUNNING"), true);
  });

  it("re-runs a task identity for review cycles but never past a terminal task", () => {
    assert.equal(canTransitionTask("COMPLETED", "PENDING"), true);
    assert.equal(canTransitionTask("CANCELLED", "RUNNING"), false);
  });
});

describe("stage plans", () => {
  it("seeds exactly the four requested templates at the current revision", () => {
    assert.deepEqual(BUILTIN_TEMPLATES.map((template) => template.id).sort(), [
      "bug-fix",
      "doc-cleanup",
      "implement-review",
      "research",
    ]);
    assert.equal(BUILTIN_TEMPLATE_VERSION, 2);
    for (const definition of BUILTIN_TEMPLATES) {
      assert.equal(
        definition.version,
        2,
        `${definition.id} ships as version 2`,
      );
      assert.equal(definition.version, BUILTIN_TEMPLATE_VERSION);
      assert.equal(buildStagePlan(definition).templateVersion, 2);
    }
  });

  for (const definition of BUILTIN_TEMPLATES) {
    it(`${definition.id}: builds a frozen plan ending in a human gate with verification`, () => {
      const built = buildStagePlan(definition);
      const keys = built.stages.map((stage) => stage.key);
      assert.equal(new Set(keys).size, keys.length, "stage keys are unique");
      assert.equal(entryStageKey(built), built.entryStageKey);
      assert.equal(
        entryStageKey(built),
        keys[0],
        "the entry stage is the first executable stage",
      );
      const finalStage = entry(built, built.finalStageKey as string);
      assert.equal(finalStage.kind, "final_approval");
      assert.equal(finalStage.nextStageKey, null);
      assert.ok(
        built.stages.some(
          (stage) => stage.kind === "verify" && stage.loop === null,
        ),
        "each template contains a non-skippable verification stage",
      );
      assert.ok(
        built.stages.some((stage) => stage.kind === "review"),
        "each template contains a structured review stage",
      );
      assert.equal(built.stages.at(-1)?.kind, "final_approval");
      for (const stage of built.stages) {
        assert.equal(
          stage.orderIndex,
          keys.indexOf(stage.key),
          "order index matches plan order",
        );
      }

      // Exactly one human gate, and it is the last stage of the plan.
      assert.equal(
        built.stages.filter((stage) => stage.kind === "final_approval").length,
        1,
      );

      // The final verification sits between the review and the human gate, and is
      // a plain (non-conditional, non-loop) verify stage: nothing may skip it.
      const finalVerify = entry(built, FINAL_VERIFY_STAGE_KEY);
      assert.equal(finalVerify.kind, "verify");
      assert.equal(finalVerify.role, "verifier");
      assert.equal(finalVerify.conditional, false);
      assert.equal(finalVerify.loop, null);
      assert.equal(finalVerify.nextStageKey, built.finalStageKey);
      assert.equal(finalVerify.dependsOn[0], "review");
      const verifyAfterReview = built.stages.filter(
        (stage) =>
          stage.orderIndex > entry(built, "review").orderIndex &&
          stage.kind === "verify" &&
          stage.loop === null,
      );
      assert.deepEqual(
        verifyAfterReview.map((stage) => stage.key),
        [FINAL_VERIFY_STAGE_KEY],
      );

      // A review — approved or overridden — always resumes at the final
      // verification, never straight at the human gate.
      for (const reviewStage of built.stages.filter(
        (stage) => stage.kind === "review",
      )) {
        assert.equal(reviewStage.nextStageKey, FINAL_VERIFY_STAGE_KEY);
      }
    });
  }

  it("opens implement-review with a read-only planner stage", () => {
    const built = plan("implement-review");
    assert.equal(built.entryStageKey, PLAN_STAGE_KEY);
    const planner = entry(built, PLAN_STAGE_KEY);
    assert.equal(built.stages[0]?.key, PLAN_STAGE_KEY);
    assert.equal(planner.kind, "task");
    assert.equal(planner.role, "planner");
    assert.equal(planner.conditional, false);
    assert.equal(planner.loop, null);
    assert.equal(
      planner.nextStageKey,
      "implement",
      "planning precedes implementation",
    );
    assert.match(planner.instructions, /read-only/i);
    assert.match(
      planner.instructions,
      /do not create, edit, move or delete repository files/i,
    );
    assert.ok(
      agentBackedRoles(built).includes("planner"),
      "the planner role needs an agent mapping",
    );
    assert.ok(
      entry(built, "implement").orderIndex > planner.orderIndex,
      "implementation happens after planning",
    );
  });

  it("expands the review loop into dormant fix and retest stages", () => {
    const built = plan("implement-review");
    assert.deepEqual(
      built.stages.map((stage) => stage.key),
      [
        "plan",
        "implement",
        "verify",
        "review",
        "review.fix",
        "review.retest",
        FINAL_VERIFY_STAGE_KEY,
        "final",
      ],
    );
    assert.equal(entry(built, "plan").nextStageKey, "implement");
    assert.equal(entry(built, "implement").nextStageKey, "verify");
    assert.equal(entry(built, "verify").nextStageKey, "review");
    assert.equal(
      entry(built, "review").nextStageKey,
      FINAL_VERIFY_STAGE_KEY,
      "approval advances to final verification",
    );
    assert.equal(entry(built, FINAL_VERIFY_STAGE_KEY).nextStageKey, "final");
    assert.equal(entry(built, "review.fix").nextStageKey, "review.retest");
    assert.equal(
      entry(built, "review.retest").nextStageKey,
      "review",
      "the retest loops back into review",
    );
    assert.equal(entry(built, "review").maxReviewCycles, 2);
    assert.equal(entry(built, "review.fix").conditional, true);
    assert.equal(entry(built, "review.fix").loop?.phase, "fix");
    assert.equal(entry(built, "review.retest").loop?.phase, "retest");
    assert.equal(entry(built, "review.fix").loop?.reviewStageKey, "review");
    assert.equal(entry(built, "review.fix").dependsOn[0], "review");
  });

  it("research investigates, then runs an implementation experiment before verification", () => {
    const built = plan("research");
    assert.deepEqual(
      built.stages.slice(0, 4).map((stage) => stage.key),
      ["investigate", "experiment", "verify", "review"],
    );
    const investigate = entry(built, "investigate");
    assert.equal(investigate.kind, "task");
    assert.equal(investigate.role, "researcher");
    assert.equal(investigate.nextStageKey, "experiment");
    const experiment = entry(built, "experiment");
    assert.equal(experiment.kind, "task");
    assert.equal(experiment.role, "implementer");
    assert.equal(experiment.nextStageKey, "verify");
    assert.equal(experiment.conditional, false);
    // A reviewed experiment is revised by the implementer, then re-verified.
    assert.equal(entry(built, "review.fix").role, "implementer");
    assert.equal(entry(built, "review").role, "reviewer");
    assert.equal(entry(built, FINAL_VERIFY_STAGE_KEY).kind, "verify");
  });

  it("honours an explicit maxReviewCycles override", () => {
    assert.equal(entry(plan("research", 5), "review").maxReviewCycles, 5);
    assert.equal(
      entry(plan("research", 5), "review.fix").loop?.maxReviewCycles,
      5,
    );
  });

  it("reports the roles that need agent mappings", () => {
    assert.deepEqual(agentBackedRoles(plan("implement-review")), [
      "implementer",
      "planner",
      "reviewer",
    ]);
    assert.deepEqual(agentBackedRoles(plan("research")), [
      "implementer",
      "researcher",
      "reviewer",
    ]);
    assert.deepEqual(agentBackedRoles(plan("doc-cleanup")), [
      "documenter",
      "reviewer",
    ]);
    assert.deepEqual(agentBackedRoles(plan("bug-fix")), [
      "implementer",
      "reviewer",
    ]);
  });

  it("describes the plan for UI inspection including dormant stages", () => {
    const described = describePlan(plan("bug-fix"));
    assert.deepEqual(
      described.map((item) => item.key),
      [
        "reproduce",
        "repair",
        "verify",
        "review",
        "review.fix",
        "review.retest",
        FINAL_VERIFY_STAGE_KEY,
        "final",
      ],
    );
    assert.equal(described.filter((item) => item.dormant).length, 2);
  });

  it("refuses to freeze a plan without a human gate or with colliding stage keys", () => {
    const base = builtinTemplate("implement-review") as TemplateDefinition;
    const withoutGate: TemplateDefinition = {
      ...base,
      stages: base.stages.filter((stage) => stage.kind !== "final_approval"),
    };
    assert.throws(() => buildStagePlan(withoutGate), GuardError);

    const colliding: TemplateDefinition = {
      ...base,
      stages: [
        ...base.stages,
        {
          key: "review.fix",
          name: "Collision",
          kind: "task",
          role: "implementer",
          instructions: "clashes with the loop stage",
        },
      ],
    };
    assert.throws(
      () => buildStagePlan(colliding),
      /duplicate stage keys: review\.fix/,
    );

    const empty: TemplateDefinition = { ...base, stages: [] };
    assert.throws(() => buildStagePlan(empty), GuardError);
    assert.throws(
      () => buildStagePlan(base, { maxReviewCycles: 0 }),
      GuardError,
    );
  });
});

describe("review verdict branches", () => {
  const built = plan("implement-review", 2);
  const reviewStage = entry(built, "review");

  it("advances on APPROVE", () => {
    const branch = reviewVerdictBranch({
      plan: built,
      reviewStage,
      verdict: "APPROVE",
      reviewAttemptNumber: 1,
      maxReviewCycles: 2,
    });
    assert.deepEqual(branch, {
      kind: "advance",
      reviewedStageKey: "review",
      nextStageKey: FINAL_VERIFY_STAGE_KEY,
    });
  });

  it("schedules the fix loop while cycles remain", () => {
    const branch = reviewVerdictBranch({
      plan: built,
      reviewStage,
      verdict: "APPROVE_WITH_FIXES",
      reviewAttemptNumber: 1,
      maxReviewCycles: 2,
    });
    assert.deepEqual(branch, {
      kind: "fix_loop",
      fixStageKey: "review.fix",
      cycle: 1,
      nextCycle: 2,
    });
  });

  it("escalates to a human gate once the review budget is exhausted", () => {
    const branch = reviewVerdictBranch({
      plan: built,
      reviewStage,
      verdict: "APPROVE_WITH_FIXES",
      reviewAttemptNumber: 2,
      maxReviewCycles: 2,
    });
    assert.equal(branch.kind, "gate");
    assert.equal(
      branch.kind === "gate" ? branch.gate : null,
      "review_cycle_exhausted",
    );
  });

  it("routes REJECT to a human decision gate", () => {
    const branch = reviewVerdictBranch({
      plan: built,
      reviewStage,
      verdict: "REJECT",
      reviewAttemptNumber: 1,
      maxReviewCycles: 2,
    });
    assert.equal(branch.kind === "gate" ? branch.gate : null, "review_reject");
  });

  it("exposes the allowed approval decisions per gate", () => {
    assert.deepEqual(
      [...allowedApprovalDecisions("final_acceptance")],
      ["approve", "reject"],
    );
    assert.deepEqual(
      [...allowedApprovalDecisions("review_reject")],
      ["override", "retry", "reject"],
    );
    assert.deepEqual(
      [...allowedApprovalDecisions("review_cycle_exhausted")],
      ["override", "retry", "reject"],
    );
  });
});

describe("structured review validation", () => {
  it("accepts a well-formed verdict", () => {
    const result = validateReviewVerdict({
      verdict: "APPROVE",
      summary: "looks correct",
      issues: [],
      confidence: 0.8,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.verdict.verdict, "APPROVE");
    assert.equal(result.ok && result.verdict.confidence, 0.8);
  });

  it("normalizes common verdict spellings", () => {
    const approved = validateReviewVerdict({
      verdict: "approved",
      summary: "ok",
    });
    assert.equal(approved.ok && approved.verdict.verdict, "APPROVE");
    const changes = validateReviewVerdict({
      verdict: "request_changes",
      summary: "needs work",
      issues: [{ description: "x" }],
    });
    assert.equal(changes.ok && changes.verdict.verdict, "APPROVE_WITH_FIXES");
  });

  it("rejects a missing payload (exit zero is not a verdict)", () => {
    const result = validateReviewVerdict(undefined);
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? (result.errors[0] ?? "") : "",
      /exit code alone is not a verdict/,
    );
  });

  it("rejects unknown verdicts and empty summaries", () => {
    const result = validateReviewVerdict({ verdict: "MAYBE", summary: "" });
    assert.equal(result.ok, false);
    const errors = result.ok === false ? result.errors : [];
    assert.ok(errors.some((error) => error.includes("verdict must be one of")));
    assert.ok(
      errors.some((error) =>
        error.includes("summary must be a non-empty string"),
      ),
    );
  });

  it("rejects malformed issues, bad severities and out-of-range confidence", () => {
    const result = validateReviewVerdict({
      verdict: "REJECT",
      summary: "blocked",
      issues: [
        { severity: "catastrophic", description: "bad" },
        { description: "" },
      ],
      confidence: 3,
    });
    assert.equal(result.ok, false);
    const errors = result.ok === false ? result.errors : [];
    assert.ok(
      errors.some((error) => error.includes("severity must be one of")),
    );
    assert.ok(errors.some((error) => error.includes("issues[1].description")));
    assert.ok(
      errors.some((error) =>
        error.includes("confidence must be between 0 and 1"),
      ),
    );
  });

  it("requires actionable issues when fixes are requested", () => {
    const result = validateReviewVerdict({
      verdict: "APPROVE_WITH_FIXES",
      summary: "fix it",
      issues: [],
    });
    assert.equal(result.ok, false);
    assert.ok(
      (result.ok === false ? result.errors : []).some((error) =>
        error.includes("at least one valid issue"),
      ),
    );
  });

  it("formats a verdict for prompt reuse", () => {
    assert.equal(
      formatReviewVerdict({
        verdict: "APPROVE_WITH_FIXES",
        summary: "two things",
        issues: [
          { severity: "major", description: "a" },
          { severity: "minor", description: "b" },
        ],
      }),
      "APPROVE_WITH_FIXES: two things issues=2",
    );
  });
});

describe("credential hygiene", () => {
  it("detects and masks credential-shaped content", () => {
    const text = "use sk-abcdefghijklmnopqrstuvwxyz0123456789 to authenticate";
    assert.deepEqual(findCredentials(text), ["openai_key"]);
    assert.equal(redactSecrets(text).includes("sk-abc"), false);
    assert.match(redactSecrets(text), /\[REDACTED:openai_key\]/);
  });

  it("refuses operator content that embeds credentials", () => {
    assert.throws(
      () =>
        assertNoCredentials(
          "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          "goal",
        ),
      ValidationError,
    );
    assert.doesNotThrow(() =>
      assertNoCredentials("fix the parser bug", "goal"),
    );
  });
});

describe("prompt rendering", () => {
  const packet = {
    packetVersion: 1 as const,
    runId: "run_1",
    projectId: "prj_1",
    projectName: "demo",
    projectRoot: "/tmp/demo",
    goal: "Implement the feature",
    constraints: ["do not touch unrelated files"],
    stageKey: "implement",
    stageName: "Implementation",
    stageKind: "task" as const,
    stageInstructions: "write the code",
    role: "implementer",
    agentId: "agt_1",
    adapterKind: "mock",
    attemptNumber: 2,
    attemptReason: "transient failure",
    templateId: "implement-review",
    stoppingRule: STOPPING_RULE,
    priorAttempts: [
      {
        stageKey: "implement",
        attemptNumber: 1,
        status: "FAILED" as const,
        summary: "boom",
        error: "boom",
        reviewVerdict: null,
      },
    ],
    priorStageResults: [],
    latestCheckpoint: null,
    verification: [],
    artifacts: [],
    review: null,
    humanInstruction: null,
    operatorInputs: [],
  };

  it("renders goal, stage, prior attempts and the stopping rule", () => {
    const text = renderPromptText(packet);
    assert.match(text, /# AgentOps task: Implementation \(implement\)/);
    assert.match(text, /Implement the feature/);
    assert.match(text, /attempt 1: FAILED — boom/);
    assert.match(text, /Stopping rule/);
    assert.match(text, /Never continue past a failed verification/);
    assert.match(text, /Repository root: \/tmp\/demo/);
    assert.doesNotMatch(text, /Response contract \(review\)/);
  });

  it("adds the structured verdict contract for review stages", () => {
    const text = renderPromptText({
      ...packet,
      stageKind: "review",
      stageKey: "review",
      stageName: "Review",
    });
    assert.match(text, /Response contract \(review\)/);
    assert.match(
      text,
      /"verdict": "APPROVE" \| "APPROVE_WITH_FIXES" \| "REJECT"/,
    );
    assert.match(text, /An exit code of zero is not a verdict/);
  });

  it("redacts secrets that reach the rendered prompt", () => {
    const text = renderPromptText({
      ...packet,
      operatorInputs: [
        "here is my key sk-abcdefghijklmnopqrstuvwxyz0123456789",
      ],
    });
    assert.doesNotMatch(text, /sk-abcdefghij/);
    assert.match(text, /\[REDACTED:openai_key\]/);
  });
});
