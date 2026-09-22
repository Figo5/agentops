/**
 * AgentOps core domain types.
 *
 * This module is dependency-free: it must not import from `src/db` or
 * `src/adapters`. Every other module may import from here.
 *
 * Domain vocabulary (see DESIGN.md):
 *  - Run:   the durable workflow execution of one goal against one project.
 *  - Stage: a plan node inside a run (implement / verify / review / fix / retest / final).
 *  - Task:  the stable identity of a stage. Tasks are never re-created.
 *  - Attempt: one immutable execution of a task, with its own prompt packet and result.
 */

/* ------------------------------------------------------------------ */
/* Status unions                                                       */
/* ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  "DRAFT",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_INPUT",
  "FAILED",
  "INTERRUPTED",
  "COMPLETED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STAGE_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "INTERRUPTED",
  "CANCELLED",
  "SKIPPED",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const TASK_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "INTERRUPTED",
  "CANCELLED",
  "SKIPPED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "WAITING_INPUT",
  "INTERRUPTED",
  "CANCELLED",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_KINDS = ["agent", "verification", "human"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/** Terminal run statuses. A terminal run can never be restarted. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "COMPLETED",
  "CANCELLED",
];

/** Run statuses that hold the single-active-run lease for a project root. */
export const LEASED_RUN_STATUSES: readonly RunStatus[] = [
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_INPUT",
];

/** Run statuses that require a deliberate human action to move forward. */
export const BLOCKED_RUN_STATUSES: readonly RunStatus[] = [
  "WAITING_APPROVAL",
  "WAITING_INPUT",
  "FAILED",
  "INTERRUPTED",
];

/** Statuses in which the engine's driver is no longer expected to make progress on its own. */
export const SETTLED_RUN_STATUSES: readonly RunStatus[] = [
  "WAITING_APPROVAL",
  "WAITING_INPUT",
  "FAILED",
  "INTERRUPTED",
  "COMPLETED",
  "CANCELLED",
];

/** Attempt statuses that mean "this execution is still owned by a live process". */
export const LIVE_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  "RUNNING",
  "WAITING_INPUT",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isSettledRunStatus(status: RunStatus): boolean {
  return SETTLED_RUN_STATUSES.includes(status);
}

/* ------------------------------------------------------------------ */
/* Stage plan                                                          */
/* ------------------------------------------------------------------ */

/**
 * Stage kinds are deliberately small. `fix` and `retest` are *not* kinds: they are
 * loop instances of a `task` / `verify` stage, described by `StageLoopContext`.
 */
export const STAGE_KINDS = [
  "task",
  "review",
  "verify",
  "final_approval",
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** Roles are free-form strings mapped to agent ids per run. */
export type RoleKey = string;

export interface StageLoopContext {
  /** Key of the review stage that owns this loop stage. */
  reviewStageKey: string;
  /** `fix` = implement the review's requested fixes, `retest` = verify them. */
  phase: "fix" | "retest";
  maxReviewCycles: number;
}

/**
 * A single node of a run's frozen stage plan. Plans are snapshotted into
 * `runs.stage_plan` at creation and materialized as `run_stages` rows.
 */
export interface StagePlanEntry {
  key: string;
  name: string;
  kind: StageKind;
  role: RoleKey;
  orderIndex: number;
  instructions: string;
  /** Keys of stages that must reach COMPLETED or SKIPPED before this one runs. */
  dependsOn: string[];
  /** Cursor successor on the success path. `null` ends the plan. */
  nextStageKey: string | null;
  /** Loop stages (`fix` / `retest`) are dormant until a review asks for fixes. */
  loop: StageLoopContext | null;
  /** Conditional stages may end up SKIPPED. */
  conditional: boolean;
  /** Only for review stages: hard bound on review cycles before a human gate. */
  maxReviewCycles: number | null;
}

export interface StagePlan {
  templateId: string;
  templateVersion: number;
  entryStageKey: string;
  finalStageKey: string | null;
  stages: StagePlanEntry[];
}

export function planEntry(
  plan: StagePlan,
  key: string | null | undefined,
): StagePlanEntry | undefined {
  if (!key) return undefined;
  return plan.stages.find((stage) => stage.key === key);
}

/* ------------------------------------------------------------------ */
/* Review verdicts                                                     */
/* ------------------------------------------------------------------ */

export const REVIEW_VERDICTS = [
  "APPROVE",
  "APPROVE_WITH_FIXES",
  "REJECT",
] as const;
export type ReviewVerdictKind = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_SEVERITIES = ["blocking", "major", "minor", "nit"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewIssue {
  severity: ReviewSeverity;
  description: string;
  path?: string | null;
  line?: number | null;
}

/** Validated structured review verdict. Never inferred from an exit code. */
export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  summary: string;
  issues: ReviewIssue[];
  confidence?: number | null;
  reviewer?: string | null;
}

/* ------------------------------------------------------------------ */
/* Agent adapter contract                                              */
/* ------------------------------------------------------------------ */

export const AGENT_EVENT_TYPES = [
  "AGENT_STARTED",
  "AGENT_OUTPUT",
  "AGENT_TOOL_CALL",
  "AGENT_WAITING",
  "AGENT_COMPLETED",
  "AGENT_FAILED",
  "AGENT_CANCELLED",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent {
  type: AgentEventType;
  at: string;
  /** Output stream when the event carries process output. */
  stream?: "stdout" | "stderr" | "system";
  message?: string;
  data?: Record<string, unknown>;
}

export const AGENT_RESULT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "waiting_input",
  "unavailable",
] as const;
export type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number];

export type AgentSessionStatus =
  | "idle"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Measured usage. Field values may be individually unknown; an entirely
 * unknown usage is reported as `null` (never as zeros).
 */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd?: number | null;
  model?: string | null;
}

export interface AgentArtifactRef {
  /** Path relative to the project root. Must not escape it. */
  path: string;
  kind: string;
  note?: string | null;
}

export interface AgentResult {
  status: AgentResultStatus;
  summary: string;
  exitCode: number | null;
  /** Raw structured review payload; the core validates it before use. */
  review?: unknown;
  artifacts?: AgentArtifactRef[];
  /** `null` means UNKNOWN, not zero. */
  usage?: Usage | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  readonly id: string;
  sendInput(text: string): Promise<void>;
  cancel(reason: string): Promise<void>;
  getStatus(): AgentSessionStatus;
  streamEvents(): AsyncIterable<AgentEvent>;
  collectResult(): Promise<AgentResult>;
}

export interface AgentTaskConfig {
  agentId: string;
  adapterKind: string;
  model: string | null;
  effort: string | null;
  /** Adapter-specific configuration from the agent record (never credentials). */
  config: Record<string, unknown>;
  timeoutMs?: number | null;
}

export interface AgentAdapter {
  readonly kind: string;
  startTask(
    packet: AgentTaskPacket,
    config: AgentTaskConfig,
  ): Promise<AgentSession>;
}

/* ------------------------------------------------------------------ */
/* Prompt packets                                                      */
/* ------------------------------------------------------------------ */

export interface CommandSpec {
  name: string;
  executable: string;
  args: string[];
  cwd?: string | null;
  timeoutMs?: number | null;
}

export interface GitCheckpointSummary {
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  diffStat: string | null;
  localCommits: { sha: string; subject: string }[];
  ahead: number | null;
  behind: number | null;
  capturedAt: string;
}

export interface PriorAttemptSummary {
  stageKey: string;
  attemptNumber: number;
  status: AttemptStatus;
  summary: string | null;
  error: string | null;
  reviewVerdict: ReviewVerdictKind | null;
}

export interface PriorStageSummary {
  stageKey: string;
  name: string;
  status: StageStatus;
  summary: string | null;
  failureReason: string | null;
}

export interface VerificationSummary {
  stageKey: string;
  status: "passed" | "failed" | "unavailable";
  summary: string;
}

/**
 * The full context handed to an agent. Persisted verbatim (redacted) per attempt.
 */
export interface PromptPacket {
  packetVersion: 1;
  runId: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  goal: string;
  constraints: string[];
  stageKey: string;
  stageName: string;
  stageKind: StageKind;
  stageInstructions: string;
  role: RoleKey;
  agentId: string;
  adapterKind: string;
  attemptNumber: number;
  attemptReason: string | null;
  templateId: string;
  stoppingRule: string;
  priorAttempts: PriorAttemptSummary[];
  priorStageResults: PriorStageSummary[];
  latestCheckpoint: GitCheckpointSummary | null;
  verification: VerificationSummary[];
  artifacts: AgentArtifactRef[];
  review: {
    cycle: number;
    maxCycles: number;
    priorVerdicts: ReviewVerdict[];
  } | null;
  humanInstruction: string | null;
  operatorInputs: string[];
}

/** Packet + the exact rendered prompt text that is sent to the agent. */
export interface AgentTaskPacket extends PromptPacket {
  promptText: string;
}

/* ------------------------------------------------------------------ */
/* Persisted records                                                   */
/* ------------------------------------------------------------------ */

export type VcsKind = "git" | "none";

export interface ProjectRecord {
  id: string;
  name: string;
  canonicalRoot: string;
  vcs: VcsKind;
  defaultBranch: string | null;
  verificationCommands: CommandSpec[];
  settings: Record<string, unknown>;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  roleHint: string | null;
  adapterKind: string;
  model: string | null;
  effort: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateRecord {
  id: string;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  defaultMaxReviewCycles: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStageRecord extends StagePlanEntry {
  id: string;
  templateId: string;
}

export interface RunPolicy {
  templateId: string;
  templateVersion: number;
  maxReviewCycles: number;
  requireVerification: boolean;
  finalApprovalRequired: boolean;
  stopOnFailure: boolean;
  roleMapping: Record<RoleKey, string>;
  verificationCommands: CommandSpec[];
  gitPolicy: "read-only" | "branch-and-commit";
  stoppingRule: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  projectRoot: string;
  templateId: string;
  templateVersion: number;
  goal: string;
  constraints: string[];
  status: RunStatus;
  roleMapping: Record<RoleKey, string>;
  policy: RunPolicy;
  plan: StagePlan;
  nextStageKey: string | null;
  currentAttemptId: string | null;
  reviewCycle: number;
  /** Bumped on every cancellation/interruption so late writes can be rejected. */
  epoch: number;
  failureReason: string | null;
  cancelReason: string | null;
  interruptReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface StageRecord {
  id: string;
  runId: string;
  key: string;
  name: string;
  kind: StageKind;
  role: RoleKey;
  agentId: string | null;
  orderIndex: number;
  status: StageStatus;
  instructions: string;
  dependsOn: string[];
  nextStageKey: string | null;
  loop: StageLoopContext | null;
  conditional: boolean;
  skipReason: string | null;
  cycle: number;
  attemptCount: number;
  summary: string | null;
  failureReason: string | null;
  overridden: boolean;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  runId: string;
  stageKey: string;
  title: string;
  kind: StageKind;
  role: RoleKey;
  agentId: string | null;
  status: TaskStatus;
  plan: Record<string, unknown>;
  attemptCount: number;
  currentAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationOutcomeRecord {
  status: "passed" | "failed" | "unavailable";
  summary: string;
  reason: string | null;
  mode: string;
  commandCount: number;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
}

export interface AttemptRecord {
  id: string;
  taskId: string;
  runId: string;
  stageKey: string;
  attemptNumber: number;
  reason: string | null;
  previousAttemptId: string | null;
  kind: AttemptKind;
  status: AttemptStatus;
  agentId: string | null;
  adapterKind: string | null;
  agentSessionId: string | null;
  promptPacket: PromptPacket | null;
  promptText: string | null;
  inputs: string[];
  resultStatus: string | null;
  resultSummary: string | null;
  exitCode: number | null;
  /** `null` means UNKNOWN usage. */
  usage: Usage | null;
  usageKnown: boolean;
  artifacts: AgentArtifactRef[];
  reviewVerdictId: string | null;
  verification: VerificationOutcomeRecord | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface EventRecord {
  id: number;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  attemptId: string | null;
  stageKey: string | null;
  category: EventCategory;
  type: string;
  actor: EventActor;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const EVENT_CATEGORIES = [
  "run",
  "stage",
  "task",
  "attempt",
  "agent",
  "review",
  "approval",
  "verification",
  "input",
  "artifact",
  "snapshot",
  "project",
  "system",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_ACTORS = [
  "system",
  "engine",
  "operator",
  "agent",
  "adapter",
  "verifier",
] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const APPROVAL_GATES = [
  "final_acceptance",
  "review_reject",
  "review_cycle_exhausted",
] as const;
export type ApprovalGateKind = (typeof APPROVAL_GATES)[number];

export const APPROVAL_DECISIONS = [
  "approve",
  "reject",
  "override",
  "retry",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalRecord {
  id: string;
  runId: string;
  stageKey: string;
  taskId: string | null;
  attemptId: string | null;
  gate: ApprovalGateKind;
  status: "PENDING" | "DECIDED";
  allowed: ApprovalDecision[];
  reason: string | null;
  requestedAt: string;
  decision: ApprovalDecision | null;
  instruction: string | null;
  actor: string | null;
  decidedAt: string | null;
}

export interface ReviewVerdictRecord {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  stageKey: string;
  cycle: number;
  valid: boolean;
  validationErrors: string[];
  verdict: ReviewVerdictKind | null;
  summary: string | null;
  issues: ReviewIssue[];
  confidence: number | null;
  reviewer: string | null;
  raw: string;
  createdAt: string;
}

export interface AgentSessionRecord {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  agentId: string;
  adapterKind: string;
  status: string;
  pid: number | null;
  handle: Record<string, unknown>;
  cancelReason: string | null;
  startedAt: string;
  endedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Planned records: commands, tests, snapshots, artifacts              */
/* ------------------------------------------------------------------ */

export interface ShellCommandRecord {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  stageKey: string;
  testRunId: string | null;
  name: string;
  executable: string;
  args: string[];
  cwd: string | null;
  status: "planned" | "passed" | "failed" | "skipped" | "unavailable";
  exitCode: number | null;
  durationMs: number | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  truncated: boolean;
  createdAt: string;
}

export interface TestRunRecord {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  stageKey: string;
  framework: string;
  status: "passed" | "failed" | "unavailable" | "unknown";
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  parsedConfidently: boolean;
  summary: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface GitSnapshotRecord {
  id: string;
  runId: string;
  stageKey: string;
  attemptId: string | null;
  phase: "before" | "after";
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
  diffStat: string | null;
  localCommits: { sha: string; subject: string }[];
  ahead: number | null;
  behind: number | null;
  unavailableReason: string | null;
  capturedAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  stageKey: string;
  /** Repo-relative canonical path. Large payloads never enter SQLite. */
  path: string;
  kind: string;
  creator: string;
  exists: boolean;
  sizeBytes: number | null;
  note: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Detail aggregate                                                    */
/* ------------------------------------------------------------------ */

export interface RunDetail {
  run: RunRecord;
  plan: StagePlan;
  stages: StageRecord[];
  tasks: TaskRecord[];
  attempts: AttemptRecord[];
  approvals: ApprovalRecord[];
  pendingApproval: ApprovalRecord | null;
  reviewVerdicts: ReviewVerdictRecord[];
  events: EventRecord[];
}

export interface RunSearchQuery {
  projectId?: string | null;
  goalContains?: string | null;
  agentId?: string | null;
  status?: RunStatus | null;
  templateId?: string | null;
  branch?: string | null;
  reviewVerdict?: ReviewVerdictKind | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface RunSearchHit extends RunRecord {
  /** Latest known branch from captured git snapshots, when available. */
  branch: string | null;
  /** Most recent valid review verdict recorded for the run. */
  lastReviewVerdict: ReviewVerdictKind | null;
}

export interface EventQuery {
  runId?: string | null;
  projectId?: string | null;
  category?: EventCategory | null;
  type?: string | null;
  afterId?: number | null;
  limit?: number | null;
}

export interface RecoveryReport {
  interruptedRuns: string[];
  interruptedAttempts: string[];
  interruptedStages: string[];
  releasedSessions: string[];
  pendingApprovals: string[];
}
