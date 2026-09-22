/**
 * Pure transition rules. No database, no clock, no I/O — every function here is
 * a total function of its arguments so it can be unit-tested directly.
 */
import { GuardError } from "./errors.js";
import type {
  ApprovalDecision,
  ApprovalGateKind,
  RunStatus,
  StagePlan,
  StagePlanEntry,
  StageStatus,
  ReviewVerdictKind,
  TaskStatus,
  AttemptStatus,
} from "./types.js";

/* ------------------------------ run statuses ------------------------------ */

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  DRAFT: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "WAITING_INPUT",
    "FAILED",
    "INTERRUPTED",
    "COMPLETED",
    "CANCELLED",
  ],
  // WAITING_APPROVAL resumes only with a recorded decision: approve/reject complete or fail
  // the run, override/retry return it to RUNNING. Interruption/cancellation stay available.
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED"],
  // WAITING_INPUT resumes only with supplied input.
  WAITING_INPUT: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED"],
  // FAILED and INTERRUPTED resume only through a deliberate retry.
  FAILED: ["RUNNING", "CANCELLED"],
  INTERRUPTED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function allowedRunTransitions(from: RunStatus): readonly RunStatus[] {
  return RUN_TRANSITIONS[from];
}

export function assertRunTransition(
  from: RunStatus,
  to: RunStatus,
  context = "run",
): void {
  if (!canTransitionRun(from, to)) {
    throw new GuardError(`invalid ${context} transition ${from} -> ${to}`, {
      from,
      to,
    });
  }
}

/* ----------------------------- stage statuses ----------------------------- */

const STAGE_TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED", "CANCELLED"],
  RUNNING: [
    "COMPLETED",
    "FAILED",
    "WAITING_INPUT",
    "WAITING_APPROVAL",
    "INTERRUPTED",
    "CANCELLED",
    "SKIPPED",
  ],
  COMPLETED: ["PENDING"], // reopened for the next review cycle (attempt history is preserved)
  FAILED: ["RUNNING", "CANCELLED"], // deliberate retry
  WAITING_INPUT: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED"],
  WAITING_APPROVAL: [
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "WAITING_INPUT",
    "CANCELLED",
    "INTERRUPTED",
    "PENDING",
  ],
  INTERRUPTED: ["RUNNING", "CANCELLED"],
  CANCELLED: [],
  SKIPPED: ["PENDING"], // loop stage activated by a review verdict
};

export function canTransitionStage(
  from: StageStatus,
  to: StageStatus,
): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export function assertStageTransition(
  from: StageStatus,
  to: StageStatus,
  context = "stage",
): void {
  if (!canTransitionStage(from, to)) {
    throw new GuardError(`invalid ${context} transition ${from} -> ${to}`, {
      from,
      to,
    });
  }
}

/* ----------------------------- task statuses ------------------------------ */

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED", "CANCELLED"],
  RUNNING: [
    "COMPLETED",
    "FAILED",
    "WAITING_INPUT",
    "WAITING_APPROVAL",
    "INTERRUPTED",
    "CANCELLED",
    "PENDING",
  ],
  COMPLETED: ["PENDING"], // review cycles re-run the same task identity
  FAILED: ["RUNNING", "CANCELLED"],
  WAITING_INPUT: ["RUNNING", "FAILED", "CANCELLED", "INTERRUPTED"],
  WAITING_APPROVAL: [
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "INTERRUPTED",
    "PENDING",
  ],
  INTERRUPTED: ["RUNNING", "CANCELLED"],
  CANCELLED: [],
  SKIPPED: ["PENDING"],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/* ---------------------------- attempt statuses ---------------------------- */

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  RUNNING: ["COMPLETED", "FAILED", "WAITING_INPUT", "INTERRUPTED", "CANCELLED"],
  WAITING_INPUT: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"],
  COMPLETED: [],
  FAILED: [],
  INTERRUPTED: [],
  CANCELLED: [],
};

export function canTransitionAttempt(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

/**
 * Attempts are immutable once they reach a terminal status. This is what makes
 * retry history trustworthy: a new attempt never overwrites a prior result.
 */
export function isAttemptImmutable(status: AttemptStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "INTERRUPTED"
  );
}

/* -------------------------------- plan rules ------------------------------- */

export function reviewStageOf(
  plan: StagePlan,
  stage: StagePlanEntry,
): StagePlanEntry | undefined {
  if (!stage.loop) return undefined;
  return plan.stages.find(
    (candidate) => candidate.key === stage.loop?.reviewStageKey,
  );
}

export function loopStagesOf(
  plan: StagePlan,
  reviewStageKey: string,
): StagePlanEntry[] {
  return plan.stages.filter(
    (stage) => stage.loop?.reviewStageKey === reviewStageKey,
  );
}

export function fixStageOf(
  plan: StagePlan,
  reviewStageKey: string,
): StagePlanEntry | undefined {
  return plan.stages.find(
    (stage) =>
      stage.loop?.reviewStageKey === reviewStageKey &&
      stage.loop.phase === "fix",
  );
}

export type ReviewBranch =
  | { kind: "advance"; reviewedStageKey: string; nextStageKey: string | null }
  | { kind: "fix_loop"; fixStageKey: string; cycle: number; nextCycle: number }
  | { kind: "gate"; gate: ApprovalGateKind; reason: string };

/**
 * Decide what a validated review verdict means for the plan. Pure: the caller
 * persists the resulting status changes.
 */
export function reviewVerdictBranch(input: {
  plan: StagePlan;
  reviewStage: StagePlanEntry;
  verdict: ReviewVerdictKind;
  /** 1-based number of the attempt that produced this verdict. */
  reviewAttemptNumber: number;
  maxReviewCycles: number;
}): ReviewBranch {
  const { plan, reviewStage, verdict, reviewAttemptNumber, maxReviewCycles } =
    input;

  if (verdict === "REJECT") {
    return {
      kind: "gate",
      gate: "review_reject",
      reason: `reviewer rejected the work: human decision required`,
    };
  }

  if (verdict === "APPROVE") {
    return {
      kind: "advance",
      reviewedStageKey: reviewStage.key,
      nextStageKey: reviewStage.nextStageKey,
    };
  }

  // APPROVE_WITH_FIXES
  const cyclesUsed = Math.max(1, reviewAttemptNumber);
  if (cyclesUsed >= maxReviewCycles) {
    return {
      kind: "gate",
      gate: "review_cycle_exhausted",
      reason: `review requested fixes but the ${maxReviewCycles}-cycle review budget is exhausted`,
    };
  }
  const fixStage = fixStageOf(plan, reviewStage.key);
  if (!fixStage) {
    return {
      kind: "gate",
      gate: "review_cycle_exhausted",
      reason: `review requested fixes but the plan defines no fix stage`,
    };
  }
  return {
    kind: "fix_loop",
    fixStageKey: fixStage.key,
    cycle: cyclesUsed,
    nextCycle: cyclesUsed + 1,
  };
}

/** Approval decisions a gate accepts. Overrides never skip final verification. */
export function allowedApprovalDecisions(
  gate: ApprovalGateKind,
): readonly ApprovalDecision[] {
  switch (gate) {
    case "final_acceptance":
      return ["approve", "reject"];
    case "review_reject":
    case "review_cycle_exhausted":
      return ["override", "retry", "reject"];
  }
}

export function approvalGateLabel(gate: ApprovalGateKind): string {
  switch (gate) {
    case "final_acceptance":
      return "final human acceptance";
    case "review_reject":
      return "reviewer rejection";
    case "review_cycle_exhausted":
      return "exhausted review cycle budget";
  }
}

/**
 * First stage to execute given a frozen plan. Loop stages start dormant unless a
 * review activates them, so they are not eligible.
 */
export function entryStageKey(plan: StagePlan): string {
  const entry = plan.stages
    .filter((stage) => stage.loop === null)
    .sort((a, b) => a.orderIndex - b.orderIndex)[0];
  if (!entry) throw new GuardError("stage plan contains no executable stage");
  return entry.key;
}

/** Slice of the plan that only needs an operator decision, for UI/plan inspection. */
export function describePlan(plan: StagePlan): Array<{
  key: string;
  order: number;
  kind: string;
  role: string;
  dormant: boolean;
}> {
  return plan.stages.map((stage) => ({
    key: stage.key,
    order: stage.orderIndex,
    kind: stage.kind,
    role: stage.role,
    dormant: stage.loop !== null,
  }));
}
