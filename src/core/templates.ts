/**
 * Built-in workflow templates and the frozen stage plan builder.
 *
 * The four seeded templates are the only orchestration shapes v1 ships:
 *   implement-review, bug-fix, research, doc-cleanup
 *
 * Every template follows the same spine:
 *
 *   planning work → implementation work → verification → review
 *   → final verification → human final acceptance
 *
 * - implement-review starts with an explicit read-only PLAN task (role `planner`)
 *   before any file is touched.
 * - research investigates (role `researcher`), then runs an implementation
 *   experiment (role `implementer`).
 * - bug-fix and doc-cleanup audit/reproduce before they change anything.
 * - The review stage owns the bounded FIX → RETEST → REVIEW loop.
 * - Every template ends with a non-skippable *final verification* stage
 *   (`final_verify`, kind `verify`, role `verifier`) placed between the review and
 *   the human gate, so a review override can never bypass re-verification, and
 *   with a human final-acceptance gate that can never be automated.
 *
 * Template versions are bumped whenever a shape changes. Runs snapshot the plan at
 * creation (`runs.stage_plan`), so runs created before a bump keep executing the
 * plan they were frozen with.
 */
import { GuardError } from "./errors.js";
import type {
  RoleKey,
  StageKind,
  StageLoopContext,
  StagePlan,
  StagePlanEntry,
} from "./types.js";

/** Current built-in template revision. Bumped by 1 when a plan shape changes. */
export const BUILTIN_TEMPLATE_VERSION = 2;

/** Dormant loop stage suffixes appended after every review stage. */
export const FIX_STAGE_SUFFIX = ".fix";
export const RETEST_STAGE_SUFFIX = ".retest";

/** Key of the final verification stage every built-in template carries. */
export const FINAL_VERIFY_STAGE_KEY = "final_verify";

/** Key of the read-only planning stage that opens `implement-review`. */
export const PLAN_STAGE_KEY = "plan";

export interface TemplateLoopDefinition {
  maxReviewCycles: number;
  fixInstructions: string;
  retestInstructions: string;
  /** Role that applies the requested fixes; defaults to the implementer. */
  fixRole?: string;
}

export interface TemplateStageDefinition {
  key: string;
  name: string;
  kind: StageKind;
  role: RoleKey;
  instructions: string;
  dependsOn?: string[];
  reviewLoop?: TemplateLoopDefinition;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  defaultMaxReviewCycles: number;
  stages: TemplateStageDefinition[];
}

/* --------------------------- stage constructors --------------------------- */

/**
 * Structured review stage. Its `nextStageKey` is whatever normal stage follows it
 * in the template — that is where a validated APPROVE and a recorded review
 * override both resume, which is how the final verification stays mandatory.
 */
function reviewStageDefinition(
  overrides?: Partial<TemplateStageDefinition>,
): TemplateStageDefinition {
  return {
    key: "review",
    name: "Structured review",
    kind: "review",
    role: "reviewer",
    instructions:
      "Review the work produced by the previous stages against the goal. Report a structured verdict. " +
      "Do not change repository files; report findings instead. " +
      "An approval here never replaces the final verification or the human acceptance gate.",
    reviewLoop: {
      maxReviewCycles: 2,
      fixInstructions:
        "Apply the fixes requested by the reviewer. Address each listed issue explicitly.",
      retestInstructions:
        "Re-run the project verification commands after the fixes and record the outcome.",
    },
    ...overrides,
  };
}

/** Command-executed verification of the work produced so far. */
function verifyStageDefinition(): TemplateStageDefinition {
  return {
    key: "verify",
    name: "Verification",
    kind: "verify",
    role: "verifier",
    instructions:
      "Run the project's configured verification commands and record exit status and parsed counts.",
  };
}

/**
 * Final verification: the last command-executed stage, after review and before
 * the human gate. It is not conditional, so nothing — including a review
 * override — can skip it.
 */
function finalVerifyStageDefinition(): TemplateStageDefinition {
  return {
    key: FINAL_VERIFY_STAGE_KEY,
    name: "Final verification",
    kind: "verify",
    role: "verifier",
    instructions:
      "Re-run the project's configured verification commands against the frozen final state after the review " +
      "and record exit status and parsed counts. This stage always runs: it cannot be skipped, including after " +
      "a recorded review override.",
  };
}

function finalStageDefinition(): TemplateStageDefinition {
  return {
    key: "final",
    name: "Final human acceptance",
    kind: "final_approval",
    role: "human",
    instructions:
      "A human operator accepts or rejects the run. This gate can never be skipped or automated.",
  };
}

/* --------------------------------- templates -------------------------------- */

export const BUILTIN_TEMPLATES: readonly TemplateDefinition[] = [
  {
    id: "implement-review",
    name: "Implement and review",
    description:
      "Plan read-only, implement the goal, verify it, review it, re-verify the frozen result, then require human final acceptance.",
    version: BUILTIN_TEMPLATE_VERSION,
    defaultMaxReviewCycles: 2,
    stages: [
      {
        key: PLAN_STAGE_KEY,
        name: "Plan",
        kind: "task",
        role: "planner",
        instructions:
          "Produce the implementation plan before any file changes: the approach, the files involved and why, the " +
          "verification commands you expect to be run, and the risks or open questions. This stage is read-only: do " +
          "not create, edit, move or delete repository files, and do not run commands that change repository or " +
          "system state. Report the plan as your result summary.",
      },
      {
        key: "implement",
        name: "Implementation",
        kind: "task",
        role: "implementer",
        instructions:
          "Implement the goal in the registered repository, following the plan produced by the previous stage. Keep " +
          "the change minimal, coherent and complete. Do not modify files unrelated to the goal.",
      },
      verifyStageDefinition(),
      reviewStageDefinition(),
      finalVerifyStageDefinition(),
      finalStageDefinition(),
    ],
  },
  {
    id: "bug-fix",
    name: "Bug fix",
    description:
      "Reproduce a defect, fix it, verify, review, re-verify the frozen result, then require human final acceptance.",
    version: BUILTIN_TEMPLATE_VERSION,
    defaultMaxReviewCycles: 2,
    stages: [
      {
        key: "reproduce",
        name: "Reproduction",
        kind: "task",
        role: "implementer",
        instructions:
          "Reproduce the reported defect and capture a minimal failing case. Do not fix it yet. " +
          "Report exact steps and observed versus expected behavior.",
      },
      {
        key: "repair",
        name: "Fix",
        kind: "task",
        role: "implementer",
        instructions:
          "Fix the reproduced defect with the smallest correct change and explain the root cause.",
      },
      verifyStageDefinition(),
      reviewStageDefinition(),
      finalVerifyStageDefinition(),
      finalStageDefinition(),
    ],
  },
  {
    id: "research",
    name: "Research",
    description:
      "Investigate a question, run an implementation experiment, verify it, review it, re-verify the frozen result, then require human final acceptance.",
    version: BUILTIN_TEMPLATE_VERSION,
    defaultMaxReviewCycles: 2,
    stages: [
      {
        key: "investigate",
        name: "Investigation",
        kind: "task",
        role: "researcher",
        instructions:
          "Investigate the goal using only the repository and locally available evidence. " +
          "Produce findings with explicit provenance and state what remains unknown. Do not speculate.",
      },
      {
        key: "experiment",
        name: "Implementation experiment",
        kind: "task",
        role: "implementer",
        instructions:
          "Implement the smallest experiment that can confirm or falsify the investigation findings: change only " +
          "what the experiment needs, run it, and record exactly what you ran and what you observed. State the " +
          "result as a bounded measurement, not as a general claim.",
      },
      verifyStageDefinition(),
      reviewStageDefinition({
        instructions:
          "Critique the investigation and its experiment for evidence quality, unsupported claims and missing " +
          "provenance. Report a structured verdict. An approval here never replaces the final verification or the " +
          "human acceptance gate.",
        reviewLoop: {
          maxReviewCycles: 2,
          fixInstructions:
            "Address each review issue in the experiment or by narrowing the claim to what the evidence supports.",
          retestInstructions:
            "Re-run the project verification commands after the research fixes.",
          fixRole: "implementer",
        },
      }),
      finalVerifyStageDefinition(),
      finalStageDefinition(),
    ],
  },
  {
    id: "doc-cleanup",
    name: "Documentation cleanup",
    description:
      "Audit documentation, update it, verify, review, re-verify the frozen result, then require human final acceptance.",
    version: BUILTIN_TEMPLATE_VERSION,
    defaultMaxReviewCycles: 2,
    stages: [
      {
        key: "audit",
        name: "Documentation audit",
        kind: "task",
        role: "documenter",
        instructions:
          "Audit the documentation against the current behavior of the code. List concrete defects.",
      },
      {
        key: "update",
        name: "Documentation update",
        kind: "task",
        role: "documenter",
        instructions:
          "Apply the documentation corrections. Change prose and docs only; do not change behavior.",
      },
      verifyStageDefinition(),
      reviewStageDefinition({
        reviewLoop: {
          maxReviewCycles: 2,
          fixInstructions:
            "Apply the documentation fixes requested by the reviewer.",
          retestInstructions:
            "Re-run the project verification commands after the documentation fixes.",
          fixRole: "documenter",
        },
      }),
      finalVerifyStageDefinition(),
      finalStageDefinition(),
    ],
  },
];

export function builtinTemplate(id: string): TemplateDefinition | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.id === id);
}

/**
 * Expand template stages into the frozen plan that is stored on the run.
 *
 * For every review stage the builder appends two dormant loop stages:
 *   `<review>.fix`    task    (implementation of requested fixes)
 *   `<review>.retest` verify  (verification of the fixes)
 * They are materialized as SKIPPED stages until a review verdict activates them,
 * so the full plan — including possible loop iterations — is inspectable up front.
 *
 * The stage after a review stage is where both APPROVE and a recorded review
 * override resume; the built-in templates always place the final verification
 * there.
 */
export function buildStagePlan(
  template: TemplateDefinition,
  options: { maxReviewCycles?: number } = {},
): StagePlan {
  if (template.stages.length === 0)
    throw new GuardError(`template ${template.id} has no stages`);
  const maxReviewCycles =
    options.maxReviewCycles ?? template.defaultMaxReviewCycles;
  if (maxReviewCycles < 1)
    throw new GuardError(
      `template ${template.id} requires maxReviewCycles >= 1`,
    );

  const normalStages = template.stages;
  const stages: StagePlanEntry[] = [];
  let orderIndex = 0;

  const keyOfNextNormal = (index: number): string | null =>
    normalStages[index + 1]?.key ?? null;

  normalStages.forEach((stage, index) => {
    const dependsOn =
      stage.dependsOn ?? (index === 0 ? [] : [normalStages[index - 1]!.key]);
    const entry: StagePlanEntry = {
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      role: stage.role,
      orderIndex: orderIndex++,
      instructions: stage.instructions,
      dependsOn: [...dependsOn],
      nextStageKey: keyOfNextNormal(index),
      loop: null,
      conditional: false,
      maxReviewCycles: stage.kind === "review" ? maxReviewCycles : null,
    };
    stages.push(entry);

    if (stage.kind === "review" && stage.reviewLoop) {
      const stageMaxCycles =
        maxReviewCycles ??
        stage.reviewLoop.maxReviewCycles ??
        template.defaultMaxReviewCycles;
      const loop: Omit<StageLoopContext, "phase"> = {
        reviewStageKey: stage.key,
        maxReviewCycles: stageMaxCycles,
      };
      const fixKey = `${stage.key}${FIX_STAGE_SUFFIX}`;
      const retestKey = `${stage.key}${RETEST_STAGE_SUFFIX}`;
      stages.push({
        key: fixKey,
        name: `${stage.name}: fixes`,
        kind: "task",
        role: stage.reviewLoop.fixRole ?? "implementer",
        orderIndex: orderIndex++,
        instructions: stage.reviewLoop.fixInstructions,
        dependsOn: [stage.key],
        nextStageKey: retestKey,
        loop: { ...loop, phase: "fix" },
        conditional: true,
        maxReviewCycles: null,
      });
      stages.push({
        key: retestKey,
        name: `${stage.name}: re-verification`,
        kind: "verify",
        role: "verifier",
        orderIndex: orderIndex++,
        instructions: stage.reviewLoop.retestInstructions,
        dependsOn: [fixKey],
        nextStageKey: stage.key,
        loop: { ...loop, phase: "retest" },
        conditional: true,
        maxReviewCycles: null,
      });
    }
  });

  const duplicateKeys = stages
    .map((stage) => stage.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    throw new GuardError(
      `template ${template.id} has duplicate stage keys: ${[...new Set(duplicateKeys)].join(", ")}`,
    );
  }

  const finalStage = stages.find((stage) => stage.kind === "final_approval");
  if (!finalStage)
    throw new GuardError(
      `template ${template.id} must contain a final_approval stage`,
    );
  const entryStage = stages
    .filter((stage) => stage.loop === null)
    .sort((a, b) => a.orderIndex - b.orderIndex)[0]!;

  return {
    templateId: template.id,
    templateVersion: template.version,
    entryStageKey: entryStage.key,
    finalStageKey: finalStage.key,
    stages,
  };
}

/** Roles that require an agent mapping (verification stages run commands, not agents). */
export function agentBackedRoles(plan: StagePlan): string[] {
  const roles = new Set<string>();
  for (const stage of plan.stages) {
    if (stage.kind === "task" || stage.kind === "review") roles.add(stage.role);
  }
  return [...roles].sort();
}

export function allRoles(plan: StagePlan): string[] {
  const roles = new Set<string>();
  for (const stage of plan.stages) roles.add(stage.role);
  return [...roles].sort();
}

/** Structural store contract so this module stays free of database imports. */
export interface TemplateStore {
  upsertTemplate(input: { definition: TemplateDefinition; plan: StagePlan }): {
    created: boolean;
    templateId: string;
    version: number;
  };
  getTemplate(id: string): { id: string; version: number } | undefined;
}

/**
 * Idempotently materialize the built-in templates. Re-seeding bumps the template
 * version so that runs created earlier keep their snapshotted plan.
 */
export function ensureBuiltinTemplates(store: TemplateStore): {
  seeded: string[];
  updated: string[];
} {
  const seeded: string[] = [];
  const updated: string[] = [];
  for (const definition of BUILTIN_TEMPLATES) {
    const existing = store.getTemplate(definition.id);
    const plan = buildStagePlan(definition);
    const result = store.upsertTemplate({ definition, plan });
    if (result.created) seeded.push(definition.id);
    else if (!existing || existing.version !== result.version)
      updated.push(definition.id);
  }
  return { seeded, updated };
}
