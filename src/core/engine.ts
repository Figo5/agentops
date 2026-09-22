/**
 * AgentOps engine: a persisted, guarded run state machine.
 *
 * Invariants implemented here:
 *  1. One nonterminal executing/waiting run per canonical project root.
 *  2. State changes and their audit events share one transaction.
 *  3. Every state change is a guarded compare-and-set on the persisted status,
 *     so a late agent completion can never overwrite a cancellation.
 *  4. Attempts are immutable: retry creates a new attempt referencing the old one.
 *  5. Failures (task, verification, adapter, malformed review) stop progression
 *     until a deliberate retry.
 *  6. Review progression requires a validated structured verdict; exit code zero
 *     is never approval.
 *  7. Final acceptance is always a human gate; overrides never skip it.
 *  8. Restart marks persisted live attempts INTERRUPTED and signals nothing.
 */
import path from "node:path";
import { createAdapterRegistry } from "../adapters/agents/types.js";
import type {
  AdapterFactory,
  AdapterRegistry,
} from "../adapters/agents/types.js";
import { createMockAdapter } from "../adapters/agents/mock.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  errorMessage,
} from "./errors.js";
import { KeyedMutex, withTimeout } from "./mutex.js";
import { buildPromptPacket, STOPPING_RULE } from "./prompts.js";
import { assertNoCredentials, redactSecrets } from "./redaction.js";
import { validateReviewVerdict } from "./review.js";
import {
  ensureBuiltinTemplates,
  agentBackedRoles,
  buildStagePlan,
} from "./templates.js";
import type { TemplateDefinition } from "./templates.js";
import {
  allowedApprovalDecisions,
  approvalGateLabel,
  canTransitionRun,
  loopStagesOf,
  reviewVerdictBranch,
} from "./transitions.js";
import type { Store, AttemptPatch, StagePatch } from "../db/store.js";
import type {
  AgentAdapter,
  AgentArtifactRef,
  AgentEvent,
  AgentRecord,
  AgentResult,
  AgentSession,
  AgentTaskPacket,
  ApprovalDecision,
  ApprovalGateKind,
  AttemptRecord,
  CommandSpec,
  EventActor,
  GitCheckpointSummary,
  PriorAttemptSummary,
  PriorStageSummary,
  ProjectRecord,
  RecoveryReport,
  ReviewVerdict,
  RunDetail,
  RunPolicy,
  RunRecord,
  RunSearchHit,
  RunSearchQuery,
  RunStatus,
  StageRecord,
  Usage,
  VerificationSummary,
} from "./types.js";
import {
  LEASED_RUN_STATUSES,
  SETTLED_RUN_STATUSES,
  isTerminalRunStatus,
  planEntry,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Dependency injection seams                                          */
/* ------------------------------------------------------------------ */

export interface VerificationInput {
  run: RunRecord;
  stage: StageRecord;
  attempt: AttemptRecord;
  project: ProjectRecord;
  commands: CommandSpec[];
}

export interface VerificationCommandOutcome {
  spec: CommandSpec;
  status: "passed" | "failed" | "skipped" | "unavailable";
  exitCode: number | null;
  durationMs: number | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  truncated?: boolean;
  framework?: string | null;
  counts?: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  parsedConfidently?: boolean;
  summary?: string | null;
}

export interface VerificationOutcome {
  status: "passed" | "failed" | "unavailable";
  summary: string;
  reason?: string | null;
  /** How the verification was produced, recorded verbatim on the attempt. */
  mode?: string;
  commands?: VerificationCommandOutcome[];
  counts?: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
}

/** Runtime-supplied verification executor (commands, test parsing, CI, ...). */
export interface VerificationExecutor {
  readonly kind: string;
  run(
    input: VerificationInput,
    signal: AbortSignal,
  ): Promise<VerificationOutcome>;
}

export interface SnapshotInput {
  run: RunRecord;
  stage: StageRecord;
  attempt: AttemptRecord | null;
  phase: "before" | "after";
}

/** Runtime-supplied git checkpoint provider. Returning null means "unavailable". */
export interface SnapshotProvider {
  readonly kind: string;
  capture(input: SnapshotInput): Promise<GitCheckpointSummary | null>;
}

/**
 * Default executor used when the runtime supplies none. It never invents
 * verification results: without configured commands there is nothing to verify,
 * so it fails closed, and it also fails closed when commands exist but no runner
 * is registered. It never claims that a command ran.
 */
export class FailClosedVerificationExecutor implements VerificationExecutor {
  readonly kind = "fail-closed";

  async run(input: VerificationInput): Promise<VerificationOutcome> {
    if (input.commands.length === 0) {
      return {
        status: "unavailable",
        summary:
          "no verification commands are configured for this project; verification cannot be claimed",
        reason: "no-verification-commands",
        mode: "fail-closed",
      };
    }
    return {
      status: "unavailable",
      summary:
        "verification commands are configured but no verification executor is registered",
      reason: "executor-missing",
      mode: "fail-closed",
    };
  }
}

/** @deprecated Use {@link FailClosedVerificationExecutor}; the old name implied a pass-through. */
export const PassThroughVerificationExecutor = FailClosedVerificationExecutor;
export type PassThroughVerificationExecutor = FailClosedVerificationExecutor;

export class NoopSnapshotProvider implements SnapshotProvider {
  readonly kind = "noop";

  async capture(): Promise<GitCheckpointSummary | null> {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface EngineOptions {
  store: Store;
  /** Resolve the adapter implementation for a configured agent. */
  resolveAdapter?: (agent: AgentRecord) => AgentAdapter | undefined;
  /** Registry alternative to `resolveAdapter`; merged with the built-in mock. */
  adapterRegistry?: AdapterRegistry;
  verification?: VerificationExecutor;
  snapshots?: SnapshotProvider;
  now?: () => string;
  /** Seed the four built-in workflow templates on construction (default true). */
  seedTemplates?: boolean;
  /** Mark persisted live attempts INTERRUPTED on construction (default true). */
  recoverOnStart?: boolean;
  /** Actor recorded for operator-initiated transitions. */
  actor?: EventActor;
  /** Max persisted output/tool events per attempt. */
  outputEventLimit?: number;
  /** Bounded wait for driver cleanup (cancellation, shutdown). */
  driverTimeoutMs?: number;
}

export interface CreateRunInput {
  projectId: string;
  templateId: string;
  goal: string;
  /** role -> agent id. Every agent-backed role in the plan must be mapped. */
  agents: Record<string, string>;
  constraints?: string[];
  actor?: EventActor;
}

export interface DecideApprovalOptions {
  instruction?: string;
  actor?: EventActor;
}

export type DriverOutcome = "ADVANCED" | "SETTLED";

interface LiveSession {
  session: AgentSession;
  sessionId: string;
  agent: AgentRecord;
  attemptId: string;
  runId: string;
}

const EVENT_TYPE_BY_AGENT_EVENT: Record<AgentEvent["type"], string> = {
  AGENT_STARTED: "agent.started",
  AGENT_OUTPUT: "agent.output",
  AGENT_TOOL_CALL: "agent.tool_call",
  AGENT_WAITING: "agent.waiting",
  AGENT_COMPLETED: "agent.completed",
  AGENT_FAILED: "agent.failed",
  AGENT_CANCELLED: "agent.cancelled",
};

export class Engine {
  readonly store: Store;
  private readonly options: EngineOptions;
  private readonly registry: AdapterRegistry;
  private readonly verification: VerificationExecutor;
  private readonly snapshots: SnapshotProvider;
  private readonly now: () => string;
  private readonly actor: EventActor;
  private readonly outputEventLimit: number;
  private readonly driverTimeoutMs: number;

  private readonly mutex = new KeyedMutex();
  private readonly drivers = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly inputResumes = new Map<string, () => void>();
  private shuttingDown = false;

  constructor(options: EngineOptions) {
    this.options = options;
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.actor = options.actor ?? "operator";
    this.outputEventLimit = options.outputEventLimit ?? 200;
    this.driverTimeoutMs = options.driverTimeoutMs ?? 10_000;
    this.verification =
      options.verification ?? new FailClosedVerificationExecutor();
    this.snapshots = options.snapshots ?? new NoopSnapshotProvider();
    this.registry =
      options.adapterRegistry ??
      createAdapterRegistry({
        mock: (agent) => createMockAdapter(agent, { now: this.now }),
      });

    if (options.seedTemplates !== false) {
      ensureBuiltinTemplates(this.store);
    }
    if (options.recoverOnStart !== false) {
      this.recoverInterrupted();
    }
  }

  registerAdapter(kind: string, factory: AdapterFactory): void {
    this.registry.register(kind, factory);
  }

  registerTemplate(definition: TemplateDefinition): void {
    this.store.upsertTemplate({ definition, plan: buildStagePlan(definition) });
  }

  /* ------------------------------ queries ------------------------------ */

  getRun(
    id: string,
    options: { includeEvents?: boolean } = {},
  ): RunDetail | undefined {
    return this.store.getRunDetail(id, {
      includeEvents: options.includeEvents !== false,
    });
  }

  requireDetail(id: string): RunDetail {
    const detail = this.getRun(id);
    if (!detail) throw new NotFoundError(`run ${id} not found`);
    return detail;
  }

  listRuns(query: Parameters<Store["listRuns"]>[0] = {}): RunRecord[] {
    return this.store.listRuns(query);
  }

  searchRuns(query: RunSearchQuery = {}): RunSearchHit[] {
    return this.store.searchRuns(query);
  }

  /** Poll the persisted status until it reaches one of `statuses` (or times out). */
  async waitForStatus(
    id: string,
    statuses: readonly RunStatus[],
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<RunRecord> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const intervalMs = options.intervalMs ?? 2;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = this.store.getRun(id);
      if (!run) throw new NotFoundError(`run ${id} not found`);
      if (statuses.includes(run.status)) return run;
      if (Date.now() > deadline) {
        throw new ConflictError(
          `run ${id} did not reach ${statuses.join("|")} within ${timeoutMs}ms (status ${run.status})`,
        );
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        // The poller must never keep the process alive on its own.
        timer.unref?.();
      });
    }
  }

  /** Wait until the run is no longer RUNNING (completed, waiting, failed, ...). */
  async waitForSettled(
    id: string,
    options: { timeoutMs?: number } = {},
  ): Promise<RunRecord> {
    return this.waitForStatus(id, SETTLED_RUN_STATUSES, options);
  }

  /** Await the in-flight driver of a run, if any. */
  async settle(
    id: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const driver = this.drivers.get(id);
    if (!driver) return;
    await withTimeout(
      driver,
      options.timeoutMs ?? this.driverTimeoutMs,
      () => new ConflictError(`run ${id} did not settle in time`),
    );
  }

  /* ---------------------------- run creation --------------------------- */

  async createRun(input: CreateRunInput): Promise<RunDetail> {
    const goal = (input.goal ?? "").trim();
    if (goal.length === 0)
      throw new ValidationError("createRun requires a non-empty goal");
    assertNoCredentials(goal, "goal");
    const constraints = (input.constraints ?? []).map((value) => String(value));
    for (const constraint of constraints)
      assertNoCredentials(constraint, "constraint");

    const project = this.store.getProject(input.projectId);
    if (!project)
      throw new NotFoundError(`project ${input.projectId} not found`);
    if (project.archived)
      throw new ValidationError(`project ${project.name} is archived`);

    const template = this.store.getTemplate(input.templateId);
    if (!template)
      throw new NotFoundError(
        `workflow template ${input.templateId} not found`,
      );
    const plan = this.store.getTemplatePlan(input.templateId);
    if (!plan)
      throw new ValidationError(
        `workflow template ${input.templateId} has no persisted stages`,
      );

    const roleMapping: Record<string, string> = {};
    const missing: string[] = [];
    for (const role of agentBackedRoles(plan)) {
      const agentId = input.agents?.[role];
      if (!agentId) {
        missing.push(role);
        continue;
      }
      const agent = this.store.getAgent(agentId);
      if (!agent)
        throw new NotFoundError(`agent ${agentId} (role ${role}) not found`);
      roleMapping[role] = agent.id;
    }
    if (missing.length > 0) {
      throw new ValidationError(
        `role mapping is missing agent ids for: ${missing.join(", ")}`,
        { missingRoles: missing },
      );
    }

    const policy: RunPolicy = {
      templateId: template.id,
      templateVersion: template.version,
      maxReviewCycles: template.defaultMaxReviewCycles,
      requireVerification: true,
      finalApprovalRequired: true,
      stopOnFailure: true,
      roleMapping,
      verificationCommands: project.verificationCommands,
      gitPolicy: "read-only",
      stoppingRule: STOPPING_RULE,
    };

    const detail = this.store.transaction(() => {
      const run = this.store.createRun({
        projectId: project.id,
        templateId: template.id,
        goal,
        constraints,
        roleMapping,
        policy,
        plan,
      });
      this.store.appendEvent({
        category: "run",
        type: "run.created",
        runId: run.id,
        projectId: project.id,
        actor: input.actor ?? this.actor,
        payload: {
          goal,
          templateId: template.id,
          templateVersion: template.version,
          roleMapping,
          stagePlan: plan.stages.map((stage) => ({
            key: stage.key,
            kind: stage.kind,
            role: stage.role,
            dormant: stage.loop !== null,
          })),
          constraints,
        },
      });
      this.store.appendEvent({
        category: "run",
        type: "run.plan_frozen",
        runId: run.id,
        projectId: project.id,
        payload: {
          entryStageKey: plan.entryStageKey,
          finalStageKey: plan.finalStageKey,
          stageCount: plan.stages.length,
        },
      });
      return this.requireDetail(run.id);
    });
    return detail;
  }

  /* ------------------------------ lifecycle ---------------------------- */

  async startRun(id: string): Promise<RunDetail> {
    const existing = this.store.requireRun(id);
    if (
      existing.status === "RUNNING" ||
      existing.status === "WAITING_APPROVAL" ||
      existing.status === "WAITING_INPUT"
    ) {
      throw new ConflictError(`run ${id} is already ${existing.status}`, {
        status: existing.status,
      });
    }
    if (isTerminalRunStatus(existing.status)) {
      throw new ConflictError(
        `run ${id} is terminal (${existing.status}) and cannot be restarted`,
        { status: existing.status },
      );
    }
    if (existing.status === "FAILED" || existing.status === "INTERRUPTED") {
      throw new ConflictError(
        `run ${id} is ${existing.status}; use retry(id, reason) to resume it deliberately`,
        {
          status: existing.status,
        },
      );
    }

    await this.mutex.run(id, () => {
      this.store.transaction(() => {
        const run = this.store.requireRun(id);
        if (run.status !== "DRAFT")
          throw new ConflictError(`run ${id} is already ${run.status}`);
        if (!canTransitionRun("DRAFT", "RUNNING"))
          throw new ConflictError("invalid transition");
        const lease = this.store.getActiveRunForProject(run.projectId);
        if (lease && lease.id !== id) {
          throw new ConflictError(
            `project ${run.projectRoot} already has an active run (${lease.id} is ${lease.status})`,
            {
              activeRunId: lease.id,
            },
          );
        }
        const updated = this.store.updateRunGuarded(id, ["DRAFT"], {
          status: "RUNNING",
          startedAt: this.now(),
          updatedAt: this.now(),
          epoch: run.epoch + 1,
          nextStageKey: run.nextStageKey ?? run.plan.entryStageKey,
          currentAttemptId: null,
        });
        if (!updated)
          throw new ConflictError(
            `run ${id} could not be started from ${run.status}`,
          );
        this.store.appendEvent({
          category: "run",
          type: "run.started",
          runId: id,
          projectId: run.projectId,
          actor: this.actor,
          payload: {
            projectRoot: run.projectRoot,
            entryStageKey: updated.nextStageKey,
            epoch: updated.epoch,
          },
        });
      });
    });

    this.resetAbort(id);
    await this.awaitProgress(id);
    return this.requireDetail(id);
  }

  /** Deliberate resume of a FAILED or INTERRUPTED run. Prior attempts are preserved. */
  async retry(id: string, reason: string): Promise<RunDetail> {
    const trimmed = (reason ?? "").trim();
    if (trimmed.length === 0)
      throw new ValidationError("retry requires a non-empty reason");
    assertNoCredentials(trimmed, "retry reason");

    await this.mutex.run(id, () => {
      this.store.transaction(() => {
        const run = this.store.requireRun(id);
        const active = this.store.getActiveRunForProject(run.projectId);
        if (active && active.id !== id)
          throw new ConflictError(
            `project already has active run ${active.id}`,
            { activeRunId: active.id },
          );
        if (run.status !== "FAILED" && run.status !== "INTERRUPTED") {
          throw new ConflictError(
            `run ${id} is ${run.status}; only FAILED or INTERRUPTED runs can be retried`,
            {
              status: run.status,
            },
          );
        }
        const pending = this.store.getPendingApproval(id);
        if (pending) {
          throw new ConflictError(
            `run ${id} has a pending ${approvalGateLabel(pending.gate)} gate; decide it with decideApproval()`,
          );
        }
        const stages = this.store.getStages(id);
        const target =
          stages.find(
            (stage) =>
              stage.key === run.nextStageKey &&
              (stage.status === "FAILED" || stage.status === "INTERRUPTED"),
          ) ??
          [...stages]
            .reverse()
            .find(
              (stage) =>
                stage.status === "FAILED" || stage.status === "INTERRUPTED",
            );
        if (!target)
          throw new ConflictError(
            `run ${id} has no FAILED or INTERRUPTED stage to retry`,
          );

        const runUpdated = this.store.updateRunGuarded(id, [run.status], {
          status: "RUNNING",
          failureReason: null,
          interruptReason: null,
          endedAt: null,
          startedAt: run.startedAt ?? this.now(),
          epoch: run.epoch + 1,
          updatedAt: this.now(),
        });
        if (!runUpdated)
          throw new ConflictError(
            `run ${id} could not be retried from ${run.status}`,
          );

        const attempt = this.beginAttemptTx(id, target, { reason: trimmed });
        this.store.appendEvent({
          category: "run",
          type: "run.retried",
          runId: id,
          projectId: run.projectId,
          actor: this.actor,
          stageKey: target.key,
          payload: {
            reason: trimmed,
            stageKey: target.key,
            attemptNumber: attempt.attemptNumber,
            epoch: runUpdated.epoch,
          },
        });
      });
    });

    this.resetAbort(id);
    await this.awaitProgress(id);
    return this.requireDetail(id);
  }

  /**
   * Cancellation records intent, stops the current owned group, waits for bounded
   * cleanup and then records the terminal state. Late completions cannot win.
   */
  async cancel(
    id: string,
    reason = "cancelled by operator",
  ): Promise<RunDetail> {
    const existing = this.store.requireRun(id);
    if (isTerminalRunStatus(existing.status)) {
      throw new ConflictError(
        `run ${id} is already terminal (${existing.status})`,
      );
    }
    const driver = this.drivers.get(id);

    await this.mutex.run(id, () => {
      this.store.transaction(() => {
        const run = this.store.requireRun(id);
        if (isTerminalRunStatus(run.status))
          throw new ConflictError(
            `run ${id} is already terminal (${run.status})`,
          );
        const now = this.now();
        const stages = this.store.getStages(id);
        const activeStage = stages.find(
          (stage) =>
            stage.status === "RUNNING" ||
            stage.status === "WAITING_INPUT" ||
            stage.status === "WAITING_APPROVAL",
        );
        const attemptId = run.currentAttemptId;

        // Signal intent before mutating: the driver observes the abort and unwinds.
        this.abortFor(id).abort(new Error(reason));

        const updated = this.store.updateRunGuarded(
          id,
          [
            "DRAFT",
            "RUNNING",
            "WAITING_APPROVAL",
            "WAITING_INPUT",
            "FAILED",
            "INTERRUPTED",
          ],
          {
            status: "CANCELLED",
            cancelReason: reason,
            endedAt: now,
            updatedAt: now,
            currentAttemptId: null,
            epoch: run.epoch + 1,
          },
        );
        if (!updated)
          throw new ConflictError(
            `run ${id} could not be cancelled from ${run.status}`,
          );

        if (activeStage) {
          this.store.updateStageGuarded(
            activeStage.id,
            ["RUNNING", "WAITING_INPUT", "WAITING_APPROVAL", "PENDING"],
            {
              status: "CANCELLED",
              endedAt: now,
              updatedAt: now,
            },
          );
        }
        if (attemptId) {
          this.store.updateAttemptGuarded(
            attemptId,
            ["RUNNING", "WAITING_INPUT"],
            {
              status: "CANCELLED",
              resultStatus: "cancelled",
              resultSummary: `cancelled: ${reason}`,
              endedAt: now,
            },
          );
        }
        const task = activeStage
          ? this.store.getTaskByStage(id, activeStage.key)
          : undefined;
        if (task) {
          this.store.updateTaskGuarded(
            task.id,
            ["RUNNING", "WAITING_INPUT", "WAITING_APPROVAL", "PENDING"],
            {
              status: "CANCELLED",
              updatedAt: now,
            },
          );
        }
        const superseded = this.store.supersedePendingApprovals(
          id,
          "reject",
          "system:cancel",
          `run cancelled: ${reason}`,
        );
        this.store.appendEvent({
          category: "run",
          type: "run.cancelled",
          runId: id,
          projectId: run.projectId,
          actor: this.actor,
          stageKey: activeStage?.key ?? null,
          attemptId: attemptId ?? null,
          payload: {
            reason,
            cancelledStage: activeStage?.key ?? null,
            attemptId: attemptId ?? null,
            supersededApprovals: superseded,
          },
        });
      });
    });

    this.releaseInputWait(id);
    if (driver) {
      await withTimeout(
        driver,
        this.driverTimeoutMs,
        () => new ConflictError(`run ${id} cleanup timed out`),
      ).catch(() => undefined);
    }
    await this.cancelLiveSessions(id, `run cancelled: ${reason}`);
    return this.requireDetail(id);
  }

  /* ------------------------------- gates ------------------------------- */

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    instruction?: string,
  ): Promise<RunDetail> {
    if (instruction !== undefined)
      assertNoCredentials(instruction, "approval instruction");

    const advance = await this.mutex.run(id, () =>
      this.store.transaction((): boolean => {
        const run = this.store.requireRun(id);
        if (run.status !== "WAITING_APPROVAL") {
          throw new ConflictError(
            `run ${id} is ${run.status}; approval is only accepted while WAITING_APPROVAL`,
          );
        }
        const gate = this.store.getPendingApproval(id);
        if (!gate)
          throw new ConflictError(`run ${id} has no pending approval gate`);
        if (!gate.allowed.includes(decision)) {
          throw new ValidationError(
            `gate ${gate.gate} does not accept decision '${decision}' (allowed: ${gate.allowed.join(", ")})`,
          );
        }
        const decided = this.store.decideApproval(gate.id, decision, {
          instruction: instruction ?? null,
          actor: this.actor,
        });
        if (!decided)
          throw new ConflictError(`approval ${gate.id} was already decided`);
        this.store.appendEvent({
          category: "approval",
          type: "approval.decided",
          runId: id,
          projectId: run.projectId,
          stageKey: gate.stageKey,
          attemptId: gate.attemptId,
          actor: this.actor,
          payload: {
            gate: gate.gate,
            decision,
            instruction: instruction ?? null,
            reason: gate.reason,
          },
        });

        const now = this.now();
        const stage = this.store.getStageByKey(id, gate.stageKey);
        const task = stage
          ? this.store.getTaskByStage(id, stage.key)
          : undefined;

        const completeRun = (summary: string): void => {
          const updated = this.store.updateRunGuarded(
            id,
            ["WAITING_APPROVAL"],
            {
              status: "COMPLETED",
              endedAt: now,
              updatedAt: now,
              currentAttemptId: null,
            },
          );
          if (!updated)
            throw new ConflictError(`run ${id} could not be completed`);
          if (stage) {
            this.store.updateStageGuarded(
              stage.id,
              ["WAITING_APPROVAL", "RUNNING"],
              {
                status: "COMPLETED",
                summary,
                endedAt: now,
                updatedAt: now,
              },
            );
          }
          if (task)
            this.store.updateTaskGuarded(
              task.id,
              ["WAITING_APPROVAL", "RUNNING"],
              { status: "COMPLETED", updatedAt: now },
            );
          if (gate.attemptId) {
            this.store.updateAttemptGuarded(
              gate.attemptId,
              ["RUNNING", "WAITING_INPUT"],
              {
                status: "COMPLETED",
                resultStatus: "accepted",
                resultSummary: summary,
                endedAt: now,
              },
            );
          }
          this.store.appendEvent({
            category: "run",
            type: "run.completed",
            runId: id,
            projectId: run.projectId,
            actor: this.actor,
            payload: { gate: gate.gate, decision, summary },
          });
        };

        const failRun = (failureReason: string): void => {
          const updated = this.store.updateRunGuarded(
            id,
            ["WAITING_APPROVAL"],
            {
              status: "FAILED",
              failureReason,
              endedAt: now,
              updatedAt: now,
              currentAttemptId: null,
            },
          );
          if (!updated)
            throw new ConflictError(`run ${id} could not be failed`);
          if (stage) {
            this.store.updateStageGuarded(
              stage.id,
              ["WAITING_APPROVAL", "RUNNING"],
              {
                status: "FAILED",
                failureReason,
                endedAt: now,
                updatedAt: now,
              },
            );
          }
          if (task)
            this.store.updateTaskGuarded(
              task.id,
              ["WAITING_APPROVAL", "RUNNING"],
              { status: "FAILED", updatedAt: now },
            );
          if (gate.attemptId) {
            this.store.updateAttemptGuarded(
              gate.attemptId,
              ["RUNNING", "WAITING_INPUT"],
              {
                status: "FAILED",
                resultStatus: "rejected",
                resultSummary: failureReason,
                endedAt: now,
              },
            );
          }
          this.store.appendEvent({
            category: "run",
            type: "run.failed",
            runId: id,
            projectId: run.projectId,
            actor: this.actor,
            stageKey: gate.stageKey,
            payload: { gate: gate.gate, decision, failureReason },
          });
        };

        switch (gate.gate) {
          case "final_acceptance": {
            if (decision === "approve") {
              completeRun(
                instruction?.trim()
                  ? `accepted by ${this.actor}: ${instruction.trim()}`
                  : `accepted by ${this.actor}`,
              );
              return false;
            }
            if (decision === "reject") {
              failRun(
                instruction?.trim()
                  ? `final acceptance rejected by ${this.actor}: ${instruction.trim()}`
                  : `final acceptance rejected by ${this.actor}`,
              );
              return false;
            }
            throw new ValidationError(
              `gate final_acceptance does not accept decision '${decision}'`,
            );
          }
          case "review_reject":
          case "review_cycle_exhausted": {
            if (decision === "reject") {
              failRun(
                instruction?.trim()
                  ? `review gate rejected by ${this.actor}: ${instruction.trim()}`
                  : `review gate rejected by ${this.actor} (${gate.reason ?? gate.gate})`,
              );
              return false;
            }
            if (decision === "override") {
              // An override is recorded and advances to the final human gate; it can
              // never skip verification or final acceptance.
              const reviewStage = stage;
              const nextKey = reviewStage?.nextStageKey ?? null;
              if (reviewStage) {
                const reopened = this.store.updateStageGuarded(
                  reviewStage.id,
                  ["WAITING_APPROVAL"],
                  {
                    status: "COMPLETED",
                    summary: `overridden by ${this.actor}: ${gate.reason ?? "review gate override"}`,
                    overridden: true,
                    endedAt: now,
                    updatedAt: now,
                  },
                );
                if (!reopened)
                  throw new ConflictError(
                    `stage ${reviewStage.key} could not be overridden`,
                  );
              }
              if (task)
                this.store.updateTaskGuarded(task.id, ["WAITING_APPROVAL"], {
                  status: "COMPLETED",
                  updatedAt: now,
                });
              const runUpdated = this.store.updateRunGuarded(
                id,
                ["WAITING_APPROVAL"],
                {
                  status: "RUNNING",
                  nextStageKey: nextKey,
                  currentAttemptId: null,
                  epoch: run.epoch + 1,
                  updatedAt: now,
                },
              );
              if (!runUpdated)
                throw new ConflictError(
                  `run ${id} could not resume after override`,
                );
              this.store.appendEvent({
                category: "review",
                type: "review.override_recorded",
                runId: id,
                projectId: run.projectId,
                actor: this.actor,
                stageKey: gate.stageKey,
                payload: {
                  instruction: instruction ?? null,
                  reason: gate.reason,
                  nextStageKey: nextKey,
                },
              });
              return true;
            }
            // decision === 'retry': a deliberate new review attempt on the same stage.
            if (!stage)
              throw new ConflictError(
                `stage ${gate.stageKey} not found for retry`,
              );
            const runUpdated = this.store.updateRunGuarded(
              id,
              ["WAITING_APPROVAL"],
              {
                status: "RUNNING",
                currentAttemptId: null,
                epoch: run.epoch + 1,
                updatedAt: now,
              },
            );
            if (!runUpdated)
              throw new ConflictError(`run ${id} could not resume for retry`);
            const prepared = this.store.updateStageGuarded(
              stage.id,
              ["WAITING_APPROVAL"],
              {
                status: "PENDING",
                updatedAt: now,
              },
            );
            if (!prepared)
              throw new ConflictError(
                `stage ${stage.key} could not be re-queued for retry`,
              );
            this.beginAttemptTx(id, prepared, {
              reason: instruction?.trim()
                ? `operator retry: ${instruction.trim()}`
                : `operator retry after ${gate.gate}`,
            });
            return true;
          }
        }
      }),
    );

    if (advance) {
      this.resetAbort(id);
      await this.awaitProgress(id);
    }
    return this.requireDetail(id);
  }

  /* ------------------------------- input ------------------------------- */

  async sendInput(runId: string, text: string): Promise<RunDetail> {
    const trimmed = (text ?? "").trim();
    if (!trimmed)
      throw new ValidationError("sendInput requires non-empty text");
    assertNoCredentials(trimmed, "operator input");
    const driver = this.drivers.get(runId);
    await this.mutex.run(runId, async () => {
      const run = this.store.requireRun(runId);
      if (run.status !== "WAITING_INPUT")
        throw new ConflictError(
          `run ${runId} is ${run.status}; input is only accepted while WAITING_INPUT`,
        );
      const attemptId = run.currentAttemptId;
      const live = attemptId ? this.sessions.get(attemptId) : undefined;
      if (!attemptId || !live)
        throw new ConflictError(
          "No live agent session; a deliberate retry is required",
        );
      try {
        await withTimeout(
          live.session.sendInput(trimmed),
          5000,
          () => new Error("Input delivery timed out"),
        );
      } catch (error) {
        this.store.appendEvent({
          category: "input",
          type: "input.delivery_failed",
          runId,
          projectId: run.projectId,
          attemptId,
          actor: this.actor,
          payload: {
            chars: trimmed.length,
            error: redactSecrets(errorMessage(error)),
          },
        });
        throw error;
      }
      this.store.transaction(() => {
        const current = this.store.requireRun(runId);
        if (current.status !== "WAITING_INPUT")
          throw new ConflictError("Run state changed during input delivery");
        const attempt = this.store.appendAttemptInput(attemptId, trimmed);
        if (!attempt)
          throw new ConflictError("Attempt is no longer waiting for input");
        const stage = this.store.getStageByKey(
          runId,
          current.nextStageKey ?? "",
        );
        if (stage) {
          this.store.updateStageGuarded(stage.id, ["WAITING_INPUT"], {
            status: "RUNNING",
            updatedAt: this.now(),
          });
          const task = this.store.getTaskByStage(runId, stage.key);
          if (task)
            this.store.updateTaskGuarded(task.id, ["WAITING_INPUT"], {
              status: "RUNNING",
              updatedAt: this.now(),
            });
        }
        this.store.updateRunGuarded(runId, ["WAITING_INPUT"], {
          status: "RUNNING",
          updatedAt: this.now(),
        });
        this.store.appendEvent({
          category: "input",
          type: "input.supplied",
          runId,
          projectId: current.projectId,
          attemptId,
          stageKey: stage?.key ?? null,
          actor: this.actor,
          payload: { chars: trimmed.length, text: redactSecrets(trimmed) },
        });
      });
      this.releaseInputWait(runId);
    });
    if (driver)
      await withTimeout(
        driver,
        this.driverTimeoutMs,
        () => new ConflictError(`run ${runId} did not resume in time`),
      ).catch(() => undefined);
    return this.requireDetail(runId);
  }

  /* ------------------------------ recovery ----------------------------- */

  /**
   * Mark persisted live attempts/stages/runs INTERRUPTED. Pending human gates
   * remain pending. No persisted PID is ever signalled and nothing is relaunched.
   */
  recoverInterrupted(): RecoveryReport {
    const report: RecoveryReport = {
      interruptedRuns: [],
      interruptedAttempts: [],
      interruptedStages: [],
      releasedSessions: [],
      pendingApprovals: [],
    };
    const now = this.now();
    this.store.transaction(() => {
      // A pending human gate is not a live execution: its run, stage and attempt
      // stay exactly as they were, and the gate remains pending across restarts.
      const awaitingHuman = new Set(
        this.store
          .listRuns({ statuses: ["WAITING_APPROVAL"] })
          .map((run) => run.id),
      );

      for (const attempt of this.store.listLiveAttempts()) {
        if (awaitingHuman.has(attempt.runId)) continue;
        const updated = this.store.updateAttemptGuarded(
          attempt.id,
          ["RUNNING", "WAITING_INPUT"],
          {
            status: "INTERRUPTED",
            resultStatus: "interrupted",
            resultSummary:
              "interrupted by AgentOps restart; deliberate retry required",
            endedAt: now,
          },
        );
        if (!updated) continue;
        report.interruptedAttempts.push(attempt.id);
        this.store.appendEvent({
          category: "attempt",
          type: "attempt.interrupted",
          runId: attempt.runId,
          attemptId: attempt.id,
          taskId: attempt.taskId,
          stageKey: attempt.stageKey,
          actor: "system",
          payload: {
            attemptNumber: attempt.attemptNumber,
            reason: "startup recovery",
          },
        });
      }

      for (const stage of this.store.listStagesByStatus([
        "RUNNING",
        "WAITING_INPUT",
      ])) {
        if (awaitingHuman.has(stage.runId)) continue;
        const updated = this.store.updateStageGuarded(
          stage.id,
          ["RUNNING", "WAITING_INPUT"],
          {
            status: "INTERRUPTED",
            failureReason: "interrupted by AgentOps restart",
            endedAt: now,
            updatedAt: now,
          },
        );
        if (!updated) continue;
        report.interruptedStages.push(stage.id);
        this.store.appendEvent({
          category: "stage",
          type: "stage.interrupted",
          runId: stage.runId,
          stageKey: stage.key,
          actor: "system",
          payload: { reason: "startup recovery" },
        });
      }

      for (const task of this.store.listTasksByStatus([
        "RUNNING",
        "WAITING_INPUT",
      ])) {
        if (awaitingHuman.has(task.runId)) continue;
        this.store.updateTaskGuarded(task.id, ["RUNNING", "WAITING_INPUT"], {
          status: "INTERRUPTED",
          updatedAt: now,
        });
      }

      for (const run of this.store.listRuns({
        statuses: LEASED_RUN_STATUSES,
      })) {
        if (run.status === "WAITING_APPROVAL") {
          // Pending human gates stay pending across restarts.
          report.pendingApprovals.push(run.id);
          continue;
        }
        const updated = this.store.updateRunGuarded(
          run.id,
          ["RUNNING", "WAITING_INPUT"],
          {
            status: "INTERRUPTED",
            interruptReason: "AgentOps restarted while the run was executing",
            endedAt: now,
            updatedAt: now,
            currentAttemptId: null,
            epoch: run.epoch + 1,
          },
        );
        if (!updated) continue;
        report.interruptedRuns.push(run.id);
        this.store.appendEvent({
          category: "run",
          type: "run.interrupted",
          runId: run.id,
          projectId: run.projectId,
          actor: "system",
          payload: { reason: "startup recovery", epoch: updated.epoch },
        });
      }

      for (const session of this.store.listLiveAgentSessions()) {
        this.store.updateAgentSession(session.id, {
          status: "interrupted",
          endedAt: now,
          cancelReason:
            "runtime handle released on restart; process was not signalled",
        });
        report.releasedSessions.push(session.id);
      }
    });
    return report;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runIds = [...this.aborts.keys()];
    for (const runId of runIds) {
      this.aborts.get(runId)?.abort(new Error("engine shutdown"));
      this.releaseInputWait(runId);
    }
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map(async (live) => {
        try {
          await withTimeout(
            live.session.cancel("engine shutdown"),
            2_000,
            () => new Error("session cancel timed out"),
          );
        } catch {
          // bounded: an unresponsive session must not block shutdown
        }
        this.store.updateAgentSession(live.sessionId, {
          status: live.session.getStatus(),
          endedAt: this.now(),
          cancelReason: "engine shutdown",
        });
      }),
    );
    const drivers = [...this.drivers.values()];
    await Promise.all(
      drivers.map((driver) =>
        withTimeout(
          driver,
          this.driverTimeoutMs,
          () => new Error("driver did not stop in time"),
        ).catch(() => undefined),
      ),
    );
    this.aborts.clear();
    this.sessions.clear();
    this.inputResumes.clear();
    this.drivers.clear();
  }

  /* --------------------------- internals: driver ------------------------ */

  private detail(id: string): RunDetail {
    return this.requireDetail(id);
  }

  private abortFor(runId: string): AbortController {
    let controller = this.aborts.get(runId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.aborts.set(runId, controller);
    }
    return controller;
  }

  private resetAbort(runId: string): AbortController {
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    return controller;
  }

  private driveIfIdle(runId: string): Promise<void> {
    const existing = this.drivers.get(runId);
    if (existing) return existing;
    const promise = this.drive(runId)
      .catch((error) => {
        this.recordDriverFailure(runId, error);
      })
      .finally(() => {
        if (this.drivers.get(runId) === promise) this.drivers.delete(runId);
      });
    this.drivers.set(runId, promise);
    return promise;
  }

  /**
   * Start (or join) the run's driver and resolve when it either finishes or the
   * run reaches a settled status. A long-running agent keeps this pending — that
   * is honest: automatic progress is genuinely still in flight.
   */
  private async awaitProgress(runId: string): Promise<void> {
    const driver = this.driveIfIdle(runId);
    await Promise.race([
      driver,
      this.waitForStatus(runId, SETTLED_RUN_STATUSES, {
        timeoutMs: 60_000,
        intervalMs: 50,
      })
        .then(() => undefined)
        .catch(() => undefined),
    ]);
  }

  private async drive(runId: string): Promise<void> {
    const controller = this.abortFor(runId);
    const signal = controller.signal;
    for (;;) {
      if (signal.aborted) return;
      const run = this.store.getRun(runId);
      if (!run || run.status !== "RUNNING") return;

      const stages = this.store.getStages(runId);
      const inFlight = stages.find(
        (stage) =>
          stage.status === "RUNNING" || stage.status === "WAITING_INPUT",
      );
      if (inFlight) {
        if (inFlight.kind === "final_approval") {
          // A retried human gate: no agent executes, the gate simply reopens.
          this.openApprovalGate(runId, inFlight, "final_acceptance", null);
          return;
        }
        const attempt = run.currentAttemptId
          ? this.store.getAttempt(run.currentAttemptId)
          : undefined;
        if (!attempt) {
          this.failStage(
            runId,
            inFlight,
            `stage ${inFlight.key} is ${inFlight.status} but has no current attempt`,
          );
          return;
        }
        const outcome = await this.executeAttempt(
          runId,
          inFlight,
          attempt,
          signal,
        );
        if (outcome !== "ADVANCED") return;
        continue;
      }

      const nextKey = run.nextStageKey;
      if (!nextKey) {
        this.completeRun(runId, "plan exhausted");
        return;
      }
      const stage = stages.find((candidate) => candidate.key === nextKey);
      if (!stage) {
        this.failRun(runId, `stage plan references unknown stage '${nextKey}'`);
        return;
      }
      if (stage.kind === "final_approval") {
        this.openApprovalGate(runId, stage, "final_acceptance", null);
        return;
      }
      const attempt = this.store.transaction(() =>
        this.beginAttemptTx(runId, stage, { reason: null }),
      );
      const outcome = await this.executeAttempt(runId, stage, attempt, signal);
      if (outcome !== "ADVANCED") return;
    }
  }

  private recordDriverFailure(runId: string, error: unknown): void {
    const message = `engine driver error: ${errorMessage(error)}`;
    try {
      this.store.transaction(() => {
        const run = this.store.getRun(runId);
        if (!run) return;
        this.store.appendEvent({
          category: "system",
          type: "engine.driver_error",
          runId,
          projectId: run.projectId,
          actor: "engine",
          payload: { message },
        });
        if (run.status === "RUNNING" || run.status === "WAITING_INPUT") {
          const stage = this.store
            .getStages(runId)
            .find(
              (s) => s.status === "RUNNING" || s.status === "WAITING_INPUT",
            );
          if (stage) this.failStageInTx(runId, stage, message);
          else this.failRunInTx(runId, message);
        }
      });
    } catch {
      // never mask the original error with a bookkeeping failure
    }
  }

  /* ------------------------ internals: transitions ---------------------- */

  private beginAttemptTx(
    runId: string,
    stage: StageRecord,
    options: { reason: string | null; previousAttemptId?: string | null },
  ): AttemptRecord {
    const run = this.store.requireRun(runId);
    const now = this.now();
    const task =
      this.store.getTaskByStage(runId, stage.key) ??
      this.store.createTask({
        runId,
        stageKey: stage.key,
        title: stage.name,
        kind: stage.kind,
        role: stage.role,
        agentId: stage.agentId,
        plan: { instructions: stage.instructions, loop: stage.loop },
      });
    const previous = this.store.lastAttempt(task.id);
    const attemptNumber = stage.attemptCount + 1;
    const isVerification = stage.kind === "verify";
    const isHumanGate = stage.kind === "final_approval";
    const agentId =
      isVerification || isHumanGate
        ? null
        : (run.roleMapping[stage.role] ?? stage.agentId ?? null);
    const agent = agentId ? this.store.getAgent(agentId) : undefined;

    const attempt = this.store.createAttempt({
      taskId: task.id,
      runId,
      stageKey: stage.key,
      attemptNumber,
      kind: isVerification ? "verification" : isHumanGate ? "human" : "agent",
      reason: options.reason,
      previousAttemptId: options.previousAttemptId ?? previous?.id ?? null,
      agentId,
      adapterKind: agent?.adapterKind ?? null,
      status: "RUNNING",
    });

    const stagePatch: StagePatch = {
      status: "RUNNING",
      attemptCount: attemptNumber,
      agentId: agentId ?? stage.agentId,
      startedAt: stage.startedAt ?? now,
      updatedAt: now,
      failureReason: null,
    };
    if (stage.kind === "review") stagePatch.cycle = attemptNumber;
    const stageUpdated = this.store.updateStageGuarded(
      stage.id,
      [
        "PENDING",
        "FAILED",
        "INTERRUPTED",
        "RUNNING",
        "WAITING_INPUT",
        "WAITING_APPROVAL",
        "COMPLETED",
      ],
      stagePatch,
    );
    if (!stageUpdated)
      throw new ConflictError(
        `stage ${stage.key} could not be started from ${stage.status}`,
      );

    this.store.updateTaskGuarded(
      task.id,
      [
        "PENDING",
        "SKIPPED",
        "COMPLETED",
        "FAILED",
        "INTERRUPTED",
        "WAITING_INPUT",
        "WAITING_APPROVAL",
        "RUNNING",
      ],
      {
        status: "RUNNING",
        attemptCount: attemptNumber,
        currentAttemptId: attempt.id,
        agentId,
        updatedAt: now,
      },
    );

    this.store.updateRunGuarded(runId, ["RUNNING"], {
      currentAttemptId: attempt.id,
      nextStageKey: stage.key,
      updatedAt: now,
    });

    this.store.appendEvent({
      category: "attempt",
      type: "attempt.created",
      runId,
      projectId: run.projectId,
      taskId: task.id,
      attemptId: attempt.id,
      stageKey: stage.key,
      actor: "engine",
      payload: {
        attemptNumber,
        reason: options.reason,
        previousAttemptId: attempt.previousAttemptId,
        kind: attempt.kind,
        agentId,
        stageKind: stage.kind,
        reviewCycle: stage.kind === "review" ? attemptNumber : null,
      },
    });
    this.store.appendEvent({
      category: "stage",
      type: attemptNumber === 1 ? "stage.started" : "stage.attempt_started",
      runId,
      projectId: run.projectId,
      taskId: task.id,
      attemptId: attempt.id,
      stageKey: stage.key,
      actor: "engine",
      payload: { attemptNumber, reason: options.reason },
    });
    return attempt;
  }

  private advanceAfterSuccess(
    runId: string,
    stage: StageRecord,
    options: { summary: string | null },
  ): void {
    const run = this.store.requireRun(runId);
    const now = this.now();
    const task = this.store.getTaskByStage(runId, stage.key);
    const stageUpdated = this.store.updateStageGuarded(
      stage.id,
      ["RUNNING", "WAITING_INPUT"],
      {
        status: "COMPLETED",
        summary: options.summary,
        failureReason: null,
        endedAt: now,
        updatedAt: now,
      },
    );
    if (!stageUpdated) return;
    if (task) {
      this.store.updateTaskGuarded(task.id, ["RUNNING", "WAITING_INPUT"], {
        status: "COMPLETED",
        updatedAt: now,
      });
    }
    const nextKey = stage.nextStageKey;
    const runUpdated = this.store.updateRunGuarded(runId, ["RUNNING"], {
      nextStageKey: nextKey,
      currentAttemptId: null,
      updatedAt: now,
    });
    if (!runUpdated) return;
    this.store.appendEvent({
      category: "stage",
      type: "stage.completed",
      runId,
      projectId: run.projectId,
      stageKey: stage.key,
      actor: "engine",
      payload: { summary: options.summary, nextStageKey: nextKey },
    });
    if (!nextKey) {
      this.completeRunInTx(runId, "plan exhausted");
    }
  }

  private completeRun(runId: string, summary: string): void {
    this.store.transaction(() => this.completeRunInTx(runId, summary));
  }

  private completeRunInTx(runId: string, summary: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const now = this.now();
    const updated = this.store.updateRunGuarded(runId, ["RUNNING"], {
      status: "COMPLETED",
      endedAt: now,
      updatedAt: now,
      currentAttemptId: null,
      nextStageKey: null,
    });
    if (!updated) return;
    this.store.appendEvent({
      category: "run",
      type: "run.completed",
      runId,
      projectId: run.projectId,
      actor: "engine",
      payload: { summary },
    });
  }

  private failRun(runId: string, reason: string): void {
    this.store.transaction(() => this.failRunInTx(runId, reason));
  }

  private failRunInTx(runId: string, reason: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const now = this.now();
    const updated = this.store.updateRunGuarded(
      runId,
      ["RUNNING", "WAITING_INPUT", "WAITING_APPROVAL"],
      {
        status: "FAILED",
        failureReason: reason,
        endedAt: now,
        updatedAt: now,
        currentAttemptId: null,
      },
    );
    if (!updated) return;
    this.store.appendEvent({
      category: "run",
      type: "run.failed",
      runId,
      projectId: run.projectId,
      actor: "engine",
      payload: { failureReason: reason },
    });
  }

  private failStage(runId: string, stage: StageRecord, reason: string): void {
    this.store.transaction(() => this.failStageInTx(runId, stage, reason));
  }

  /** Fail the stage and its run. Progression stops until a deliberate retry. */
  private failStageInTx(
    runId: string,
    stage: StageRecord,
    reason: string,
  ): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    const now = this.now();
    const stageUpdated = this.store.updateStageGuarded(
      stage.id,
      ["RUNNING", "WAITING_INPUT", "PENDING", "WAITING_APPROVAL"],
      {
        status: "FAILED",
        failureReason: reason,
        endedAt: now,
        updatedAt: now,
      },
    );
    if (!stageUpdated) return false;
    const task = this.store.getTaskByStage(runId, stage.key);
    if (task) {
      this.store.updateTaskGuarded(
        task.id,
        ["RUNNING", "WAITING_INPUT", "PENDING", "WAITING_APPROVAL", "SKIPPED"],
        {
          status: "FAILED",
          updatedAt: now,
        },
      );
    }
    const runUpdated = this.store.updateRunGuarded(
      runId,
      ["RUNNING", "WAITING_INPUT", "WAITING_APPROVAL"],
      {
        status: "FAILED",
        failureReason: reason,
        endedAt: now,
        updatedAt: now,
        currentAttemptId: null,
      },
    );
    if (!runUpdated) return false;
    this.store.appendEvent({
      category: "stage",
      type: "stage.failed",
      runId,
      projectId: run.projectId,
      stageKey: stage.key,
      actor: "engine",
      payload: { failureReason: reason },
    });
    this.store.appendEvent({
      category: "run",
      type: "run.failed",
      runId,
      projectId: run.projectId,
      stageKey: stage.key,
      actor: "engine",
      payload: { failureReason: reason },
    });
    return true;
  }

  private failAttempt(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    reason: string,
    extra: {
      exitCode?: number | null;
      usage?: Usage | null;
      resultStatus?: string;
    } = {},
  ): void {
    this.store.transaction(() => {
      const usage = extra.usage ?? null;
      const usageKnown =
        usage !== null &&
        (usage.inputTokens !== null ||
          usage.outputTokens !== null ||
          usage.totalTokens !== null);
      const attemptUpdated = this.store.updateAttemptGuarded(
        attempt.id,
        ["RUNNING", "WAITING_INPUT"],
        {
          status: "FAILED",
          resultStatus: extra.resultStatus ?? "failed",
          resultSummary: reason,
          exitCode: extra.exitCode ?? null,
          usage,
          usageKnown,
          error: reason,
          endedAt: this.now(),
        },
      );
      if (!attemptUpdated) return;
      this.store.appendEvent({
        category: "attempt",
        type: "attempt.failed",
        runId,
        attemptId: attempt.id,
        taskId: attempt.taskId,
        stageKey: stage.key,
        actor: "engine",
        payload: { reason, attemptNumber: attempt.attemptNumber },
      });
      this.failStageInTx(runId, stage, reason);
    });
  }

  private openApprovalGate(
    runId: string,
    stage: StageRecord,
    gate: ApprovalGateKind,
    reason: string | null,
  ): void {
    this.store.transaction(() =>
      this.openApprovalGateInTx(runId, stage, gate, reason),
    );
  }

  private openApprovalGateInTx(
    runId: string,
    stage: StageRecord,
    gate: ApprovalGateKind,
    reason: string | null,
  ): void {
    const run = this.store.requireRun(runId);
    const now = this.now();
    // A human gate is an attempt too: the decision is the attempt's result.
    let attemptId = run.currentAttemptId;
    if (!attemptId) {
      attemptId = this.beginAttemptTx(runId, stage, { reason: null }).id;
    }
    const stageUpdated = this.store.updateStageGuarded(
      stage.id,
      ["RUNNING", "PENDING", "WAITING_APPROVAL"],
      {
        status: "WAITING_APPROVAL",
        updatedAt: now,
      },
    );
    if (!stageUpdated) return;
    const task = this.store.getTaskByStage(runId, stage.key);
    if (task)
      this.store.updateTaskGuarded(
        task.id,
        ["RUNNING", "PENDING", "WAITING_APPROVAL"],
        { status: "WAITING_APPROVAL", updatedAt: now },
      );
    const runUpdated = this.store.updateRunGuarded(runId, ["RUNNING"], {
      status: "WAITING_APPROVAL",
      updatedAt: now,
    });
    if (!runUpdated) return;
    const approval = this.store.createApprovalRequest({
      runId,
      stageKey: stage.key,
      gate,
      allowed: allowedApprovalDecisions(gate),
      taskId: task?.id ?? null,
      attemptId,
      reason,
    });
    this.store.appendEvent({
      category: "approval",
      type: "approval.requested",
      runId,
      projectId: run.projectId,
      stageKey: stage.key,
      attemptId,
      actor: "engine",
      payload: {
        gate,
        approvalId: approval.id,
        allowed: approval.allowed,
        reason,
      },
    });
    this.store.appendEvent({
      category: "run",
      type: "run.waiting_approval",
      runId,
      projectId: run.projectId,
      stageKey: stage.key,
      actor: "engine",
      payload: { gate, reason },
    });
  }

  /* -------------------- internals: attempt execution -------------------- */

  private async executeAttempt(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    signal: AbortSignal,
  ): Promise<DriverOutcome> {
    if (stage.kind === "verify")
      return this.executeVerification(runId, stage, attempt, signal);
    return this.executeAgentStage(runId, stage, attempt, signal);
  }

  private async executeVerification(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const run = this.store.requireRun(runId);
    const project = this.store.getProject(run.projectId);
    if (!project) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `project ${run.projectId} is no longer registered`,
      );
      return "SETTLED";
    }
    const commands = run.policy.verificationCommands;

    const before = await this.captureSnapshot(
      runId,
      stage,
      attempt,
      "before",
      signal,
    );
    if (signal.aborted) return "SETTLED";

    let outcome: VerificationOutcome;
    try {
      outcome = await this.verification.run(
        { run, stage, attempt, project, commands },
        signal,
      );
    } catch (error) {
      if (signal.aborted) return "SETTLED";
      outcome = {
        status: "unavailable",
        summary: `verification executor failed: ${errorMessage(error)}`,
        reason: "executor-error",
        mode: this.verification.kind,
      };
    }
    if (signal.aborted) return "SETTLED";

    const after = await this.captureSnapshot(
      runId,
      stage,
      attempt,
      "after",
      signal,
    );
    if (signal.aborted) return "SETTLED";
    void before;
    void after;

    return this.store.transaction((): DriverOutcome => {
      const now = this.now();
      const counts = outcome.counts ?? null;
      const commandOutcomes = outcome.commands ?? [];
      const firstExit =
        commandOutcomes.find((command) => command.exitCode !== null)
          ?.exitCode ?? null;
      const passed = outcome.status === "passed";
      const attemptUpdated = this.store.updateAttemptGuarded(
        attempt.id,
        ["RUNNING", "WAITING_INPUT"],
        {
          status: passed ? "COMPLETED" : "FAILED",
          resultStatus: outcome.status,
          resultSummary: outcome.summary,
          exitCode: firstExit,
          usage: null,
          usageKnown: false,
          verification: {
            status: outcome.status,
            summary: outcome.summary,
            reason: outcome.reason ?? null,
            mode: outcome.mode ?? this.verification.kind,
            commandCount: commandOutcomes.length,
            counts,
          },
          error: passed ? null : outcome.summary,
          endedAt: now,
        },
      );
      if (!attemptUpdated) return "SETTLED";

      for (const command of commandOutcomes) {
        const record = this.store.insertShellCommand({
          runId,
          stageKey: stage.key,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          name: command.spec.name,
          executable: command.spec.executable,
          args: command.spec.args,
          cwd: command.spec.cwd ?? null,
          status: command.status,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          stdoutExcerpt: command.stdoutExcerpt
            ? redactSecrets(command.stdoutExcerpt).slice(0, 4000)
            : null,
          stderrExcerpt: command.stderrExcerpt
            ? redactSecrets(command.stderrExcerpt).slice(0, 4000)
            : null,
          truncated: command.truncated ?? false,
        });
        if (command.counts) {
          this.store.insertTestRun({
            runId,
            stageKey: stage.key,
            taskId: attempt.taskId,
            attemptId: attempt.id,
            framework: command.framework ?? "unknown",
            status:
              command.status === "passed"
                ? "passed"
                : command.status === "failed"
                  ? "failed"
                  : "unknown",
            passed: command.counts.passed,
            failed: command.counts.failed,
            skipped: command.counts.skipped,
            total: command.counts.total,
            parsedConfidently: command.parsedConfidently ?? false,
            summary: command.summary ?? null,
            durationMs: command.durationMs,
          });
        }
        this.store.appendEvent({
          category: "verification",
          type: `verification.command_${command.status}`,
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          attemptId: attempt.id,
          actor: "verifier",
          payload: {
            name: command.spec.name,
            executable: command.spec.executable,
            exitCode: command.exitCode,
          },
        });
      }

      this.store.appendEvent({
        category: "verification",
        type: passed ? "verification.passed" : "verification.failed",
        runId,
        projectId: run.projectId,
        stageKey: stage.key,
        attemptId: attempt.id,
        actor: "verifier",
        payload: {
          status: outcome.status,
          summary: outcome.summary,
          mode: outcome.mode ?? this.verification.kind,
          counts,
        },
      });

      if (!passed) {
        this.failStageInTx(
          runId,
          stage,
          `verification ${outcome.status}: ${outcome.summary}`,
        );
        return "SETTLED";
      }
      this.advanceAfterSuccess(runId, stage, { summary: outcome.summary });
      return "ADVANCED";
    });
  }

  private async executeAgentStage(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const run = this.store.requireRun(runId);
    const project = this.store.getProject(run.projectId);
    if (!project) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `project ${run.projectId} is no longer registered`,
      );
      return "SETTLED";
    }
    const agentId = run.roleMapping[stage.role] ?? stage.agentId ?? null;
    if (!agentId) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `no agent is mapped to role '${stage.role}'`,
      );
      return "SETTLED";
    }
    const agent = this.store.getAgent(agentId);
    if (!agent) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `agent ${agentId} mapped to role '${stage.role}' no longer exists`,
      );
      return "SETTLED";
    }
    if (!agent.enabled) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `agent ${agent.name} is disabled`,
      );
      return "SETTLED";
    }
    const adapter = this.resolveAdapter(agent);
    if (!adapter) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `no adapter is registered for adapter kind '${agent.adapterKind}' (agent ${agent.name})`,
      );
      return "SETTLED";
    }

    const checkpoint = await this.captureSnapshot(
      runId,
      stage,
      attempt,
      "before",
      signal,
    );
    if (signal.aborted) return "SETTLED";

    const packet = this.buildPacket({
      run,
      project,
      stage,
      attempt,
      agent,
      checkpoint,
    });
    const persisted = this.store.transaction((): boolean => {
      const updated = this.store.updateAttemptGuarded(attempt.id, ["RUNNING"], {
        promptPacket: packet,
        promptText: packet.promptText,
        agentId: agent.id,
        adapterKind: agent.adapterKind,
      });
      if (!updated) return false;
      this.store.appendEvent({
        category: "attempt",
        type: "attempt.prompt_persisted",
        runId,
        projectId: run.projectId,
        stageKey: stage.key,
        attemptId: attempt.id,
        actor: "engine",
        payload: {
          attemptNumber: attempt.attemptNumber,
          promptChars: packet.promptText.length,
          agentId: agent.id,
          adapterKind: agent.adapterKind,
          model: agent.model,
          effort: agent.effort,
        },
      });
      return true;
    });
    if (!persisted) return "SETTLED";
    if (signal.aborted) return "SETTLED";

    let session: AgentSession;
    try {
      session = await adapter.startTask(packet, {
        agentId: agent.id,
        adapterKind: agent.adapterKind,
        model: agent.model,
        effort: agent.effort,
        config: agent.config,
        timeoutMs: null,
      });
    } catch (error) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `agent ${agent.name} is unavailable: ${errorMessage(error)}`,
      );
      return "SETTLED";
    }
    if (signal.aborted) {
      await this.cancelSessionBounded(
        session,
        "run cancelled before the agent started",
      );
      return "SETTLED";
    }

    const sessionRecord = this.store.transaction(() =>
      this.store.createAgentSession({
        runId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        agentId: agent.id,
        adapterKind: agent.adapterKind,
        status: session.getStatus(),
        sessionId: session.id,
      }),
    );
    this.sessions.set(attempt.id, {
      session,
      sessionId: sessionRecord.id,
      agent,
      attemptId: attempt.id,
      runId,
    });
    const consumer = this.consumeEvents(runId, stage, attempt, session, signal);

    try {
      for (;;) {
        const result = await this.collectResultOrAbort(session, signal);
        if (result === "aborted") {
          await this.cancelSessionBounded(session, "run cancelled");
          return "SETTLED";
        }
        if (signal.aborted) return "SETTLED";

        if (result.status === "waiting_input") {
          const entered = this.enterInputWait(
            runId,
            stage,
            attempt,
            result.summary,
          );
          if (!entered) return "SETTLED";
          const resumed = await this.waitForResume(runId, signal);
          if (!resumed) {
            await this.cancelSessionBounded(
              session,
              "run cancelled while waiting for input",
            );
            return "SETTLED";
          }
          continue;
        }

        if (result.status === "cancelled") {
          const current = this.store.getRun(runId);
          if (!current || current.status === "CANCELLED" || signal.aborted)
            return "SETTLED";
          this.failAttempt(
            runId,
            stage,
            attempt,
            `agent cancelled without an operator request: ${result.summary}`,
          );
          return "SETTLED";
        }

        if (result.status === "unavailable") {
          this.failAttempt(
            runId,
            stage,
            attempt,
            `agent unavailable: ${result.error ?? result.summary}`,
            {
              exitCode: result.exitCode,
              usage: result.usage ?? null,
              resultStatus: "unavailable",
            },
          );
          return "SETTLED";
        }

        if (result.status === "failed") {
          this.failAttempt(
            runId,
            stage,
            attempt,
            result.error ?? result.summary,
            {
              exitCode: result.exitCode,
              usage: result.usage ?? null,
            },
          );
          return "SETTLED";
        }

        return await this.finishAgentAttempt(
          runId,
          stage,
          attempt,
          result,
          signal,
        );
      }
    } finally {
      await consumer.catch(() => undefined);
      this.sessions.delete(attempt.id);
      this.store.updateAgentSession(sessionRecord.id, {
        status: session.getStatus(),
        endedAt: this.now(),
      });
    }
  }

  private async finishAgentAttempt(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    result: AgentResult,
    signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const run = this.store.requireRun(runId);
    const project = this.store.getProject(run.projectId);
    if (!project) {
      this.failAttempt(
        runId,
        stage,
        attempt,
        `project ${run.projectId} is no longer registered`,
      );
      return "SETTLED";
    }

    // Artifact references must stay inside the registered repository.
    const artifactRefs = result.artifacts ?? [];
    const accepted: AgentArtifactRef[] = [];
    for (const ref of artifactRefs) {
      const check = validateArtifactRef(project, ref);
      if (!check.ok) {
        this.failAttempt(
          runId,
          stage,
          attempt,
          `artifact reference rejected: ${check.reason}`,
          {
            exitCode: result.exitCode,
            usage: result.usage ?? null,
          },
        );
        return "SETTLED";
      }
      accepted.push({ ...ref, path: check.path });
    }

    await this.captureSnapshot(runId, stage, attempt, "after", signal);
    if (signal.aborted) return "SETTLED";

    const usage: Usage | null = result.usage ?? null;
    const usageKnown =
      usage !== null &&
      (usage.inputTokens !== null ||
        usage.outputTokens !== null ||
        usage.totalTokens !== null);

    if (stage.kind === "review") {
      return this.handleReviewOutcome(runId, stage, attempt, result, {
        usage,
        usageKnown,
        artifacts: accepted,
      });
    }

    return this.store.transaction((): DriverOutcome => {
      const now = this.now();
      const attemptUpdated = this.store.updateAttemptGuarded(
        attempt.id,
        ["RUNNING", "WAITING_INPUT"],
        {
          status: "COMPLETED",
          resultStatus: result.status,
          resultSummary: result.summary,
          exitCode: result.exitCode,
          usage,
          usageKnown,
          artifacts: accepted,
          error: result.error ?? null,
          endedAt: now,
        },
      );
      if (!attemptUpdated) return "SETTLED";
      for (const ref of accepted) {
        this.store.insertArtifact({
          runId,
          stageKey: stage.key,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          path: ref.path,
          kind: ref.kind,
          creator: `agent:${attempt.agentId ?? "unknown"}`,
          exists: false,
          note: ref.note ?? null,
        });
      }
      this.store.appendEvent({
        category: "attempt",
        type: "attempt.completed",
        runId,
        projectId: run.projectId,
        stageKey: stage.key,
        attemptId: attempt.id,
        actor: "agent",
        payload: {
          attemptNumber: attempt.attemptNumber,
          summary: result.summary,
          exitCode: result.exitCode,
          usageKnown,
          usage,
          artifacts: accepted.map((ref) => ref.path),
        },
      });
      this.advanceAfterSuccess(runId, stage, { summary: result.summary });
      return "ADVANCED";
    });
  }

  private handleReviewOutcome(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    result: AgentResult,
    meta: {
      usage: Usage | null;
      usageKnown: boolean;
      artifacts: AgentArtifactRef[];
    },
  ): DriverOutcome {
    const run = this.store.requireRun(runId);
    const validation = validateReviewVerdict(result.review);

    if (!validation.ok) {
      return this.store.transaction((): DriverOutcome => {
        const now = this.now();
        const reason = `invalid review verdict: ${validation.errors.join("; ")}`;
        const verdict = this.store.insertReviewVerdict({
          runId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          stageKey: stage.key,
          cycle: attempt.attemptNumber,
          valid: false,
          validationErrors: validation.errors,
          verdict: null,
          summary: null,
          issues: [],
          confidence: null,
          reviewer: null,
          raw: validation.raw,
        });
        const attemptUpdated = this.store.updateAttemptGuarded(
          attempt.id,
          ["RUNNING", "WAITING_INPUT"],
          {
            status: "FAILED",
            resultStatus: "invalid_review",
            resultSummary: reason,
            exitCode: result.exitCode,
            usage: meta.usage,
            usageKnown: meta.usageKnown,
            artifacts: meta.artifacts,
            reviewVerdictId: verdict.id,
            error: reason,
            endedAt: now,
          },
        );
        if (!attemptUpdated) return "SETTLED";
        this.store.appendEvent({
          category: "review",
          type: "review.verdict_invalid",
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          attemptId: attempt.id,
          actor: "agent",
          payload: {
            cycle: attempt.attemptNumber,
            errors: validation.errors,
            raw: validation.raw.slice(0, 2000),
            exitCode: result.exitCode,
          },
        });
        this.failStageInTx(runId, stage, reason);
        return "SETTLED";
      });
    }

    const verdict: ReviewVerdict = validation.verdict;
    const reviewPlanEntry = planEntry(run.plan, stage.key);
    if (!reviewPlanEntry) {
      this.failStage(
        runId,
        stage,
        `stage ${stage.key} is missing from the frozen plan`,
      );
      return "SETTLED";
    }
    const branch = reviewVerdictBranch({
      plan: run.plan,
      reviewStage: reviewPlanEntry,
      verdict: verdict.verdict,
      reviewAttemptNumber: attempt.attemptNumber,
      maxReviewCycles: run.policy.maxReviewCycles,
    });

    const outcome = this.store.transaction(
      (): { outcome: DriverOutcome; summary: string } => {
        const now = this.now();
        const verdictRecord = this.store.insertReviewVerdict({
          runId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          stageKey: stage.key,
          cycle: attempt.attemptNumber,
          valid: true,
          validationErrors: [],
          verdict: verdict.verdict,
          summary: verdict.summary,
          issues: verdict.issues,
          confidence: verdict.confidence ?? null,
          reviewer: verdict.reviewer ?? null,
          raw: validation.raw,
        });
        const attemptUpdated = this.store.updateAttemptGuarded(
          attempt.id,
          ["RUNNING", "WAITING_INPUT"],
          {
            status: "COMPLETED",
            resultStatus: result.status,
            resultSummary: `${verdict.verdict}: ${verdict.summary}`,
            exitCode: result.exitCode,
            usage: meta.usage,
            usageKnown: meta.usageKnown,
            artifacts: meta.artifacts,
            reviewVerdictId: verdictRecord.id,
            error: null,
            endedAt: now,
          },
        );
        if (!attemptUpdated)
          return { outcome: "SETTLED", summary: "cancelled" };

        for (const ref of meta.artifacts) {
          this.store.insertArtifact({
            runId,
            stageKey: stage.key,
            taskId: attempt.taskId,
            attemptId: attempt.id,
            path: ref.path,
            kind: ref.kind,
            creator: `agent:${attempt.agentId ?? "unknown"}`,
            exists: false,
            note: ref.note ?? null,
          });
        }

        this.store.appendEvent({
          category: "review",
          type: "review.verdict_valid",
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          attemptId: attempt.id,
          actor: "agent",
          payload: {
            cycle: attempt.attemptNumber,
            verdict: verdict.verdict,
            summary: verdict.summary,
            issues: verdict.issues.length,
            confidence: verdict.confidence ?? null,
          },
        });

        if (branch.kind === "advance") {
          this.advanceAfterSuccess(runId, stage, {
            summary: `${verdict.verdict}: ${verdict.summary}`,
          });
          return { outcome: "ADVANCED", summary: verdict.summary };
        }

        if (branch.kind === "fix_loop") {
          const reviewStage = this.store.getStageByKey(runId, stage.key);
          const fixStage = this.store.getStageByKey(runId, branch.fixStageKey);
          if (!reviewStage || !fixStage) {
            this.failStageInTx(
              runId,
              stage,
              `plan is missing the fix loop stages for review ${stage.key}`,
            );
            return { outcome: "SETTLED", summary: "missing loop stages" };
          }
          // Close this review cycle, then reopen it for the next cycle.
          this.store.updateStageGuarded(reviewStage.id, ["RUNNING"], {
            status: "COMPLETED",
            summary: `${verdict.verdict}: ${verdict.summary}`,
            endedAt: now,
            updatedAt: now,
          });
          const reopened = this.store.updateStageGuarded(
            reviewStage.id,
            ["COMPLETED"],
            {
              status: "PENDING",
              updatedAt: now,
            },
          );
          if (!reopened) {
            this.failStageInTx(
              runId,
              stage,
              `review stage ${stage.key} could not be reopened for cycle ${branch.nextCycle}`,
            );
            return { outcome: "SETTLED", summary: "reopen failed" };
          }
          const task = this.store.getTaskByStage(runId, stage.key);
          if (task) {
            this.store.updateTaskGuarded(task.id, ["RUNNING"], {
              status: "PENDING",
              currentAttemptId: null,
              updatedAt: now,
            });
          }
          const activated = this.store.updateStageGuarded(
            fixStage.id,
            ["SKIPPED", "PENDING"],
            {
              status: "PENDING",
              skipReason: null,
              cycle: branch.cycle,
              updatedAt: now,
            },
          );
          if (!activated) {
            this.failStageInTx(
              runId,
              stage,
              `fix stage ${fixStage.key} could not be activated`,
            );
            return { outcome: "SETTLED", summary: "activation failed" };
          }
          // The whole loop group becomes active; the retest runs once the fix succeeds.
          for (const loopStage of loopStagesOf(run.plan, stage.key)) {
            if (loopStage.key === fixStage.key) continue;
            this.store.updateStageGuarded(
              (this.store.getStageByKey(runId, loopStage.key) ?? fixStage).id,
              ["SKIPPED", "PENDING"],
              {
                status: "PENDING",
                skipReason: null,
                cycle: branch.cycle,
                updatedAt: now,
              },
            );
          }
          const runUpdated = this.store.updateRunGuarded(runId, ["RUNNING"], {
            nextStageKey: branch.fixStageKey,
            currentAttemptId: null,
            reviewCycle: branch.nextCycle,
            updatedAt: now,
          });
          if (!runUpdated)
            return { outcome: "SETTLED", summary: "run advanced concurrently" };
          this.store.appendEvent({
            category: "review",
            type: "review.fixes_requested",
            runId,
            projectId: run.projectId,
            stageKey: stage.key,
            attemptId: attempt.id,
            actor: "agent",
            payload: {
              cycle: branch.cycle,
              nextCycle: branch.nextCycle,
              fixStageKey: branch.fixStageKey,
              issues: verdict.issues,
            },
          });
          this.store.appendEvent({
            category: "stage",
            type: "stage.reopened",
            runId,
            projectId: run.projectId,
            stageKey: stage.key,
            actor: "engine",
            payload: {
              nextCycle: branch.nextCycle,
              reason: "review requested fixes",
            },
          });
          this.store.appendEvent({
            category: "stage",
            type: "stage.activated",
            runId,
            projectId: run.projectId,
            stageKey: fixStage.key,
            actor: "engine",
            payload: { cycle: branch.cycle },
          });
          return { outcome: "ADVANCED", summary: verdict.summary };
        }

        // gate
        const reviewStage = this.store.getStageByKey(runId, stage.key);
        if (!reviewStage) {
          this.failStageInTx(
            runId,
            stage,
            `review stage ${stage.key} disappeared before the gate could open`,
          );
          return { outcome: "SETTLED", summary: "missing review stage" };
        }
        this.store.updateStageGuarded(reviewStage.id, ["RUNNING"], {
          status: "COMPLETED",
          summary: `${verdict.verdict}: ${verdict.summary}`,
          endedAt: now,
          updatedAt: now,
        });
        const gateStage = this.store.updateStageGuarded(
          reviewStage.id,
          ["COMPLETED"],
          {
            status: "WAITING_APPROVAL",
            updatedAt: now,
          },
        );
        if (!gateStage) {
          this.failStageInTx(
            runId,
            stage,
            `review gate for ${stage.key} could not be opened`,
          );
          return { outcome: "SETTLED", summary: "gate failed" };
        }
        const task = this.store.getTaskByStage(runId, stage.key);
        if (task)
          this.store.updateTaskGuarded(task.id, ["RUNNING"], {
            status: "WAITING_APPROVAL",
            updatedAt: now,
          });
        const runUpdated = this.store.updateRunGuarded(runId, ["RUNNING"], {
          status: "WAITING_APPROVAL",
          updatedAt: now,
        });
        if (!runUpdated)
          return { outcome: "SETTLED", summary: "run advanced concurrently" };
        const approval = this.store.createApprovalRequest({
          runId,
          stageKey: stage.key,
          gate: branch.gate,
          allowed: allowedApprovalDecisions(branch.gate),
          taskId: task?.id ?? null,
          attemptId: attempt.id,
          reason: branch.reason,
        });
        this.store.appendEvent({
          category: "approval",
          type: "approval.requested",
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          attemptId: attempt.id,
          actor: "engine",
          payload: {
            gate: branch.gate,
            approvalId: approval.id,
            allowed: approval.allowed,
            reason: branch.reason,
            verdict: verdict.verdict,
          },
        });
        this.store.appendEvent({
          category: "run",
          type: "run.waiting_approval",
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          actor: "engine",
          payload: { gate: branch.gate, reason: branch.reason },
        });
        return { outcome: "SETTLED", summary: verdict.summary };
      },
    );

    return outcome.outcome;
  }

  private enterInputWait(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    summary: string,
  ): boolean {
    return this.store.transaction((): boolean => {
      const run = this.store.requireRun(runId);
      const now = this.now();
      const attemptUpdated = this.store.updateAttemptGuarded(
        attempt.id,
        ["RUNNING"],
        {
          status: "WAITING_INPUT",
          resultStatus: "waiting_input",
          resultSummary: summary,
        },
      );
      if (!attemptUpdated) return false;
      const stageUpdated = this.store.updateStageGuarded(
        stage.id,
        ["RUNNING"],
        { status: "WAITING_INPUT", updatedAt: now },
      );
      if (!stageUpdated) return false;
      const task = this.store.getTaskByStage(runId, stage.key);
      if (task)
        this.store.updateTaskGuarded(task.id, ["RUNNING"], {
          status: "WAITING_INPUT",
          updatedAt: now,
        });
      const runUpdated = this.store.updateRunGuarded(runId, ["RUNNING"], {
        status: "WAITING_INPUT",
        updatedAt: now,
      });
      if (!runUpdated) return false;
      this.store.appendEvent({
        category: "input",
        type: "input.requested",
        runId,
        projectId: run.projectId,
        stageKey: stage.key,
        attemptId: attempt.id,
        actor: "agent",
        payload: { summary },
      });
      this.store.appendEvent({
        category: "run",
        type: "run.waiting_input",
        runId,
        projectId: run.projectId,
        stageKey: stage.key,
        actor: "engine",
        payload: { summary },
      });
      return true;
    });
  }

  private waitForResume(runId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (this.inputResumes.get(runId) === resume)
          this.inputResumes.delete(runId);
        resolve(value);
      };
      const onAbort = (): void => finish(false);
      const resume = (): void => finish(true);
      signal.addEventListener("abort", onAbort, { once: true });
      this.inputResumes.set(runId, resume);
    });
  }

  private releaseInputWait(runId: string): void {
    const resume = this.inputResumes.get(runId);
    if (resume) resume();
  }

  private async collectResultOrAbort(
    session: AgentSession,
    signal: AbortSignal,
  ): Promise<AgentResult | "aborted"> {
    if (signal.aborted) return "aborted";
    const abortPromise = new Promise<"aborted">((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
    });
    return Promise.race([session.collectResult(), abortPromise]);
  }

  private async cancelSessionBounded(
    session: AgentSession,
    reason: string,
  ): Promise<void> {
    try {
      await withTimeout(
        session.cancel(reason),
        2_000,
        () => new Error("session cancel timed out"),
      );
    } catch {
      // bounded: an unresponsive session must not wedge cancellation
    }
  }

  private async cancelLiveSessions(
    runId: string,
    reason: string,
  ): Promise<void> {
    const live = [...this.sessions.values()].filter(
      (entry) => entry.runId === runId,
    );
    await Promise.all(
      live.map(async (entry) => {
        await this.cancelSessionBounded(entry.session, reason);
        this.store.updateAgentSession(entry.sessionId, {
          status: entry.session.getStatus(),
          cancelReason: reason,
          endedAt: this.now(),
        });
      }),
    );
  }

  private consumeEvents(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    session: AgentSession,
    signal: AbortSignal,
  ): Promise<void> {
    return (async () => {
      let recorded = 0;
      let truncated = false;
      try {
        for await (const event of session.streamEvents()) {
          if (signal.aborted) return;
          const isOutput =
            event.type === "AGENT_OUTPUT" || event.type === "AGENT_TOOL_CALL";
          if (isOutput) {
            if (recorded >= this.outputEventLimit) {
              if (!truncated) {
                truncated = true;
                this.recordAgentEvent(
                  runId,
                  stage,
                  attempt,
                  "agent.output_truncated",
                  {
                    message: `output event cap reached (${this.outputEventLimit}); further output is not persisted`,
                    stream: "system",
                  },
                );
              }
              continue;
            }
            recorded += 1;
          }
          this.recordAgentEvent(
            runId,
            stage,
            attempt,
            EVENT_TYPE_BY_AGENT_EVENT[event.type],
            {
              message: event.message ?? null,
              stream: event.stream ?? null,
              data: event.data ?? null,
              at: event.at,
            },
          );
        }
      } catch (error) {
        this.recordAgentEvent(runId, stage, attempt, "agent.stream_error", {
          message: errorMessage(error),
          stream: "system",
        });
      }
    })();
  }

  private recordAgentEvent(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const message =
      typeof payload["message"] === "string"
        ? redactSecrets(payload["message"]).slice(0, 4000)
        : null;
    try {
      this.store.appendEvent({
        category: "agent",
        type,
        runId,
        stageKey: stage.key,
        attemptId: attempt.id,
        taskId: attempt.taskId,
        actor: "agent" as EventActor,
        payload: { ...payload, message },
      });
    } catch {
      // event persistence must never take the driver down
    }
  }

  /* -------------------- internals: snapshots and packets ---------------- */

  private async captureSnapshot(
    runId: string,
    stage: StageRecord,
    attempt: AttemptRecord | null,
    phase: "before" | "after",
    signal: AbortSignal,
  ): Promise<GitCheckpointSummary | null> {
    const run = this.store.getRun(runId);
    if (!run) return null;
    let summary: GitCheckpointSummary | null = null;
    let unavailableReason: string | null = null;
    try {
      summary = await this.snapshots.capture({ run, stage, attempt, phase });
    } catch (error) {
      unavailableReason = `snapshot provider failed: ${errorMessage(error)}`;
    }
    if (signal.aborted) return summary;
    try {
      this.store.transaction(() => {
        this.store.insertGitSnapshot({
          runId,
          stageKey: stage.key,
          attemptId: attempt?.id ?? null,
          phase,
          summary,
          unavailableReason,
        });
        this.store.appendEvent({
          category: "snapshot",
          type: summary ? "snapshot.captured" : "snapshot.unavailable",
          runId,
          projectId: run.projectId,
          stageKey: stage.key,
          attemptId: attempt?.id ?? null,
          actor: "engine",
          payload: {
            phase,
            headSha: summary?.headSha ?? null,
            branch: summary?.branch ?? null,
            dirty: summary?.dirty ?? null,
            provider: this.snapshots.kind,
            unavailableReason,
          },
        });
      });
    } catch {
      // snapshot bookkeeping failures must not corrupt the transition
    }
    return summary;
  }

  private buildPacket(input: {
    run: RunRecord;
    project: ProjectRecord;
    stage: StageRecord;
    attempt: AttemptRecord;
    agent: AgentRecord;
    checkpoint: GitCheckpointSummary | null;
  }): AgentTaskPacket {
    const { run, project, stage, attempt, agent } = input;
    const stages = this.store.getStages(run.id);
    const priorStageResults: PriorStageSummary[] = stages
      .filter(
        (candidate) =>
          candidate.key !== stage.key &&
          candidate.status !== "PENDING" &&
          candidate.status !== "SKIPPED",
      )
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((candidate) => ({
        stageKey: candidate.key,
        name: candidate.name,
        status: candidate.status,
        summary: candidate.summary,
        failureReason: candidate.failureReason,
      }));

    const task = this.store.getTaskByStage(run.id, stage.key);
    const priorAttempts: PriorAttemptSummary[] = (
      task ? this.store.listAttempts(task.id) : []
    )
      .filter((candidate) => candidate.id !== attempt.id)
      .map((candidate) => {
        const verdict = candidate.reviewVerdictId
          ? this.store.getReviewVerdict(candidate.reviewVerdictId)
          : undefined;
        return {
          stageKey: candidate.stageKey,
          attemptNumber: candidate.attemptNumber,
          status: candidate.status,
          summary: candidate.resultSummary,
          error: candidate.error,
          reviewVerdict: verdict?.valid ? verdict.verdict : null,
        };
      });

    const verification: VerificationSummary[] = this.store
      .listAttemptsForRun(run.id)
      .filter((candidate) => candidate.verification !== null)
      .map((candidate) => ({
        stageKey: candidate.stageKey,
        status: candidate.verification?.status ?? "unavailable",
        summary: candidate.verification?.summary ?? "",
      }));

    const artifacts = this.store.listArtifacts(run.id).map((record) => ({
      path: record.path,
      kind: record.kind,
      note: record.note,
    }));

    const reviewStageKeyForContext =
      stage.kind === "review"
        ? stage.key
        : stage.loop?.phase === "fix"
          ? stage.loop.reviewStageKey
          : null;
    const priorVerdicts: ReviewVerdict[] = reviewStageKeyForContext
      ? this.store
          .listReviewVerdicts(run.id, {
            stageKey: reviewStageKeyForContext,
            validOnly: true,
          })
          .map((record) => ({
            verdict: record.verdict ?? "REJECT",
            summary: record.summary ?? "",
            issues: record.issues,
            confidence: record.confidence,
            reviewer: record.reviewer,
          }))
      : [];

    const approvals = this.store.listApprovals(run.id);
    const lastInstruction =
      [...approvals].reverse().find((approval) => approval.instruction !== null)
        ?.instruction ?? null;

    const operatorInputs = attempt.inputs;

    return buildPromptPacket({
      run,
      project,
      stage,
      agent,
      attemptNumber: attempt.attemptNumber,
      attemptReason: attempt.reason,
      priorAttempts,
      priorStageResults,
      latestCheckpoint: input.checkpoint,
      verification,
      artifacts,
      review:
        reviewStageKeyForContext !== null
          ? {
              cycle:
                stage.kind === "review" ? attempt.attemptNumber : stage.cycle,
              maxCycles: run.policy.maxReviewCycles,
              priorVerdicts,
            }
          : null,
      humanInstruction: lastInstruction,
      operatorInputs,
    });
  }

  private resolveAdapter(agent: AgentRecord): AgentAdapter | undefined {
    if (this.options.resolveAdapter) {
      const adapter = this.options.resolveAdapter(agent);
      if (adapter) return adapter;
    }
    return this.registry.resolve(agent);
  }

  /** True while the engine has an in-flight driver for the run. */
  isDriving(runId: string): boolean {
    return this.drivers.has(runId);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function validateArtifactRef(
  project: ProjectRecord,
  ref: AgentArtifactRef,
): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = (ref.path ?? "").trim();
  if (raw.length === 0) return { ok: false, reason: "empty artifact path" };
  if (path.isAbsolute(raw)) {
    return {
      ok: false,
      reason: `artifact path must be repository-relative (received absolute path)`,
    };
  }
  const normalized = path.normalize(raw).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) {
    return { ok: false, reason: `artifact path escapes the repository root` };
  }
  if (normalized.includes("/../")) {
    return { ok: false, reason: `artifact path escapes the repository root` };
  }
  if (normalized.startsWith("/")) {
    return { ok: false, reason: `artifact path must be repository-relative` };
  }
  void project;
  return { ok: true, path: normalized };
}
