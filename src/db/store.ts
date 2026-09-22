/**
 * SQLite store: versioned schema, repositories and guarded transitions.
 *
 * Design notes:
 *  - all writes that change run state go through `update*Guarded`, which is a
 *    compare-and-set on the current status. A late completion from a cancelled
 *    or interrupted attempt therefore cannot overwrite a terminal state.
 *  - every state change and its audit events share one transaction.
 *  - `Store.db` is exposed for later integration (server/UI) without wrapping.
 */
import { DatabaseSync } from "node:sqlite";
import { redactSecrets, redactValue } from "../core/redaction.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../core/errors.js";
import { newId } from "../core/ids.js";
import {
  LATEST_MIGRATION_VERSION,
  appliedMigrations,
  migrate,
  schemaVersion,
  tableNames,
} from "./migrations.js";
import type { Migration, MigrateOptions } from "./migrations.js";
import type {
  AgentArtifactRef,
  AgentRecord,
  AgentSessionRecord,
  ApprovalDecision,
  ApprovalGateKind,
  ApprovalRecord,
  ArtifactRecord,
  AttemptKind,
  AttemptRecord,
  AttemptStatus,
  CommandSpec,
  EventActor,
  EventCategory,
  EventQuery,
  EventRecord,
  GitCheckpointSummary,
  GitSnapshotRecord,
  PromptPacket,
  ProjectRecord,
  ReviewIssue,
  ReviewVerdictKind,
  ReviewVerdictRecord,
  RoleKey,
  RunDetail,
  RunPolicy,
  RunRecord,
  RunSearchQuery,
  RunStatus,
  RunSearchHit,
  ShellCommandRecord,
  StageKind,
  StageLoopContext,
  StagePlan,
  StageRecord,
  StageStatus,
  TaskRecord,
  TaskStatus,
  TestRunRecord,
  Usage,
  VerificationOutcomeRecord,
  VcsKind,
  WorkflowStageRecord,
  WorkflowTemplateRecord,
} from "../core/types.js";
import {
  LEASED_RUN_STATUSES,
  LIVE_ATTEMPT_STATUSES,
  STAGE_STATUSES,
  TASK_STATUSES,
  ATTEMPT_STATUSES,
} from "../core/types.js";
import type { TemplateDefinition, TemplateStore } from "../core/templates.js";

type Row = Record<string, unknown>;

/* ----------------------------- value helpers ----------------------------- */

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function num(value: unknown, fallback = 0): number {
  return value === null || value === undefined ? fallback : Number(value);
}

function bool(value: unknown): boolean {
  return Number(value) !== 0;
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toSql(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return redactSecrets(value);
  return JSON.stringify(redactValue(value));
}

/**
 * Identifiers reach SQLite as bound parameters, so a missing or non-string id
 * would surface as an opaque binding error. Fail loudly and early instead.
 */
function guardId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`, {
      label,
      received: typeof value,
    });
  }
  return value;
}

/* ------------------------------ patch types ------------------------------ */

export interface RunPatch {
  status?: RunStatus;
  nextStageKey?: string | null;
  currentAttemptId?: string | null;
  reviewCycle?: number;
  epoch?: number;
  failureReason?: string | null;
  cancelReason?: string | null;
  interruptReason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string;
}

export interface StagePatch {
  status?: StageStatus;
  agentId?: string | null;
  cycle?: number;
  attemptCount?: number;
  summary?: string | null;
  failureReason?: string | null;
  skipReason?: string | null;
  overridden?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string;
}

export interface TaskPatch {
  status?: TaskStatus;
  agentId?: string | null;
  attemptCount?: number;
  currentAttemptId?: string | null;
  updatedAt?: string;
}

export interface AttemptPatch {
  status?: AttemptStatus;
  agentId?: string | null;
  adapterKind?: string | null;
  agentSessionId?: string | null;
  resultStatus?: string | null;
  resultSummary?: string | null;
  exitCode?: number | null;
  usage?: Usage | null;
  usageKnown?: boolean;
  artifacts?: AgentArtifactRef[];
  reviewVerdictId?: string | null;
  verification?: VerificationOutcomeRecord | null;
  error?: string | null;
  promptPacket?: PromptPacket | null;
  promptText?: string | null;
  inputs?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

const RUN_PATCH_COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  nextStageKey: "next_stage_key",
  currentAttemptId: "current_attempt_id",
  reviewCycle: "review_cycle",
  epoch: "epoch",
  failureReason: "failure_reason",
  cancelReason: "cancel_reason",
  interruptReason: "interrupt_reason",
  startedAt: "started_at",
  endedAt: "ended_at",
  updatedAt: "updated_at",
};

const STAGE_PATCH_COLUMNS: Record<keyof StagePatch, string> = {
  status: "status",
  agentId: "agent_id",
  cycle: "cycle",
  attemptCount: "attempt_count",
  summary: "summary",
  failureReason: "failure_reason",
  skipReason: "skip_reason",
  overridden: "overridden",
  startedAt: "started_at",
  endedAt: "ended_at",
  updatedAt: "updated_at",
};

const TASK_PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  status: "status",
  agentId: "agent_id",
  attemptCount: "attempt_count",
  currentAttemptId: "current_attempt_id",
  updatedAt: "updated_at",
};

const ATTEMPT_PATCH_COLUMNS: Record<keyof AttemptPatch, string> = {
  status: "status",
  agentId: "agent_id",
  adapterKind: "adapter_kind",
  agentSessionId: "agent_session_id",
  resultStatus: "result_status",
  resultSummary: "result_summary",
  exitCode: "exit_code",
  usage: "usage",
  usageKnown: "usage_known",
  artifacts: "artifacts",
  reviewVerdictId: "review_verdict_id",
  verification: "verification",
  error: "error",
  promptPacket: "prompt_packet",
  promptText: "prompt_text",
  inputs: "inputs",
  startedAt: "started_at",
  endedAt: "ended_at",
};

/* ------------------------------ row mappers ------------------------------ */

function mapProject(row: Row): ProjectRecord {
  return {
    id: str(row["id"]),
    name: str(row["name"]),
    canonicalRoot: str(row["canonical_root"]),
    vcs: str(row["vcs"]) as VcsKind,
    defaultBranch: strOrNull(row["default_branch"]),
    verificationCommands: jsonValue<CommandSpec[]>(
      row["verification_commands"],
      [],
    ),
    settings: jsonValue<Record<string, unknown>>(row["settings"], {}),
    archived: bool(row["archived"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapAgent(row: Row): AgentRecord {
  return {
    id: str(row["id"]),
    name: str(row["name"]),
    roleHint: strOrNull(row["role_hint"]),
    adapterKind: str(row["adapter_kind"]),
    model: strOrNull(row["model"]),
    effort: strOrNull(row["effort"]),
    enabled: bool(row["enabled"]),
    config: jsonValue<Record<string, unknown>>(row["config"], {}),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapTemplate(row: Row): WorkflowTemplateRecord {
  return {
    id: str(row["id"]),
    name: str(row["name"]),
    description: str(row["description"]),
    version: num(row["version"], 1),
    builtin: bool(row["builtin"]),
    defaultMaxReviewCycles: num(row["default_max_review_cycles"], 2),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapTemplateStage(row: Row): WorkflowStageRecord {
  return {
    id: str(row["id"]),
    templateId: str(row["template_id"]),
    key: str(row["key"]),
    name: str(row["name"]),
    kind: str(row["kind"]) as StageKind,
    role: str(row["role"]),
    orderIndex: num(row["order_index"]),
    instructions: str(row["instructions"]),
    dependsOn: jsonValue<string[]>(row["depends_on"], []),
    nextStageKey: strOrNull(row["next_stage_key"]),
    loop: jsonValue<StageLoopContext | null>(row["loop"], null),
    conditional: bool(row["conditional"]),
    maxReviewCycles: numOrNull(row["max_review_cycles"]),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: str(row["id"]),
    projectId: str(row["project_id"]),
    projectRoot: str(row["project_root"]),
    templateId: str(row["template_id"]),
    templateVersion: num(row["template_version"], 1),
    goal: str(row["goal"]),
    constraints: jsonValue<string[]>(row["constraints"], []),
    status: str(row["status"]) as RunStatus,
    roleMapping: jsonValue<Record<RoleKey, string>>(row["role_mapping"], {}),
    policy: jsonValue<RunPolicy>(row["policy"], {
      templateId: str(row["template_id"]),
      templateVersion: num(row["template_version"], 1),
      maxReviewCycles: 1,
      requireVerification: true,
      finalApprovalRequired: true,
      stopOnFailure: true,
      roleMapping: {},
      verificationCommands: [],
      gitPolicy: "read-only",
      stoppingRule: "",
    }),
    plan: jsonValue<StagePlan>(row["stage_plan"], {
      templateId: str(row["template_id"]),
      templateVersion: num(row["template_version"], 1),
      entryStageKey: "",
      finalStageKey: null,
      stages: [],
    }),
    nextStageKey: strOrNull(row["next_stage_key"]),
    currentAttemptId: strOrNull(row["current_attempt_id"]),
    reviewCycle: num(row["review_cycle"], 1),
    epoch: num(row["epoch"], 0),
    failureReason: strOrNull(row["failure_reason"]),
    cancelReason: strOrNull(row["cancel_reason"]),
    interruptReason: strOrNull(row["interrupt_reason"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
    startedAt: strOrNull(row["started_at"]),
    endedAt: strOrNull(row["ended_at"]),
  };
}

function mapStage(row: Row): StageRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    key: str(row["key"]),
    name: str(row["name"]),
    kind: str(row["kind"]) as StageKind,
    role: str(row["role"]),
    agentId: strOrNull(row["agent_id"]),
    orderIndex: num(row["order_index"]),
    status: str(row["status"]) as StageStatus,
    instructions: str(row["instructions"]),
    dependsOn: jsonValue<string[]>(row["depends_on"], []),
    nextStageKey: strOrNull(row["next_stage_key"]),
    loop: jsonValue<StageLoopContext | null>(row["loop"], null),
    conditional: bool(row["conditional"]),
    skipReason: strOrNull(row["skip_reason"]),
    cycle: num(row["cycle"], 1),
    attemptCount: num(row["attempt_count"]),
    summary: strOrNull(row["summary"]),
    failureReason: strOrNull(row["failure_reason"]),
    overridden: bool(row["overridden"]),
    startedAt: strOrNull(row["started_at"]),
    endedAt: strOrNull(row["ended_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapTask(row: Row): TaskRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    stageKey: str(row["stage_key"]),
    title: str(row["title"]),
    kind: str(row["kind"]) as StageKind,
    role: str(row["role"]),
    agentId: strOrNull(row["agent_id"]),
    status: str(row["status"]) as TaskStatus,
    plan: jsonValue<Record<string, unknown>>(row["plan"], {}),
    attemptCount: num(row["attempt_count"]),
    currentAttemptId: strOrNull(row["current_attempt_id"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapAttempt(row: Row): AttemptRecord {
  return {
    id: str(row["id"]),
    taskId: str(row["task_id"]),
    runId: str(row["run_id"]),
    stageKey: str(row["stage_key"]),
    attemptNumber: num(row["attempt_number"], 1),
    reason: strOrNull(row["reason"]),
    previousAttemptId: strOrNull(row["previous_attempt_id"]),
    kind: str(row["kind"]) as AttemptKind,
    status: str(row["status"]) as AttemptStatus,
    agentId: strOrNull(row["agent_id"]),
    adapterKind: strOrNull(row["adapter_kind"]),
    agentSessionId: strOrNull(row["agent_session_id"]),
    promptPacket: jsonValue<PromptPacket | null>(row["prompt_packet"], null),
    promptText: strOrNull(row["prompt_text"]),
    inputs: jsonValue<string[]>(row["inputs"], []),
    resultStatus: strOrNull(row["result_status"]),
    resultSummary: strOrNull(row["result_summary"]),
    exitCode: numOrNull(row["exit_code"]),
    usage: jsonValue<Usage | null>(row["usage"], null),
    usageKnown: bool(row["usage_known"]),
    artifacts: jsonValue<AgentArtifactRef[]>(row["artifacts"], []),
    reviewVerdictId: strOrNull(row["review_verdict_id"]),
    verification: jsonValue<VerificationOutcomeRecord | null>(
      row["verification"],
      null,
    ),
    error: strOrNull(row["error"]),
    createdAt: str(row["created_at"]),
    startedAt: strOrNull(row["started_at"]),
    endedAt: strOrNull(row["ended_at"]),
  };
}

function mapEvent(row: Row): EventRecord {
  return {
    id: num(row["id"]),
    projectId: strOrNull(row["project_id"]),
    runId: strOrNull(row["run_id"]),
    taskId: strOrNull(row["task_id"]),
    attemptId: strOrNull(row["attempt_id"]),
    stageKey: strOrNull(row["stage_key"]),
    category: str(row["category"]) as EventCategory,
    type: str(row["type"]),
    actor: str(row["actor"]) as EventActor,
    payload: jsonValue<Record<string, unknown>>(row["payload"], {}),
    createdAt: str(row["created_at"]),
  };
}

function mapApproval(row: Row): ApprovalRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    stageKey: str(row["stage_key"]),
    taskId: strOrNull(row["task_id"]),
    attemptId: strOrNull(row["attempt_id"]),
    gate: str(row["gate"]) as ApprovalGateKind,
    status: str(row["status"]) === "DECIDED" ? "DECIDED" : "PENDING",
    allowed: jsonValue<ApprovalDecision[]>(row["allowed"], []),
    reason: strOrNull(row["reason"]),
    requestedAt: str(row["requested_at"]),
    decision: (strOrNull(row["decision"]) as ApprovalDecision | null) ?? null,
    instruction: strOrNull(row["instruction"]),
    actor: strOrNull(row["actor"]),
    decidedAt: strOrNull(row["decided_at"]),
  };
}

function mapReviewVerdict(row: Row): ReviewVerdictRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    taskId: str(row["task_id"]),
    attemptId: str(row["attempt_id"]),
    stageKey: str(row["stage_key"]),
    cycle: num(row["cycle"], 1),
    valid: bool(row["valid"]),
    validationErrors: jsonValue<string[]>(row["validation_errors"], []),
    verdict: (strOrNull(row["verdict"]) as ReviewVerdictKind | null) ?? null,
    summary: strOrNull(row["summary"]),
    issues: jsonValue<ReviewIssue[]>(row["issues"], []),
    confidence: numOrNull(row["confidence"]),
    reviewer: strOrNull(row["reviewer"]),
    raw: str(row["raw"]),
    createdAt: str(row["created_at"]),
  };
}

function mapSession(row: Row): AgentSessionRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    taskId: str(row["task_id"]),
    attemptId: str(row["attempt_id"]),
    agentId: str(row["agent_id"]),
    adapterKind: str(row["adapter_kind"]),
    status: str(row["status"]),
    pid: numOrNull(row["pid"]),
    handle: jsonValue<Record<string, unknown>>(row["handle"], {}),
    cancelReason: strOrNull(row["cancel_reason"]),
    startedAt: str(row["started_at"]),
    endedAt: strOrNull(row["ended_at"]),
  };
}

function mapShellCommand(row: Row): ShellCommandRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    taskId: strOrNull(row["task_id"]),
    attemptId: strOrNull(row["attempt_id"]),
    stageKey: str(row["stage_key"]),
    testRunId: strOrNull(row["test_run_id"]),
    name: str(row["name"]),
    executable: str(row["executable"]),
    args: jsonValue<string[]>(row["args"], []),
    cwd: strOrNull(row["cwd"]),
    status: str(row["status"]) as ShellCommandRecord["status"],
    exitCode: numOrNull(row["exit_code"]),
    durationMs: numOrNull(row["duration_ms"]),
    stdoutExcerpt: strOrNull(row["stdout_excerpt"]),
    stderrExcerpt: strOrNull(row["stderr_excerpt"]),
    truncated: bool(row["truncated"]),
    createdAt: str(row["created_at"]),
  };
}

function mapTestRun(row: Row): TestRunRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    taskId: strOrNull(row["task_id"]),
    attemptId: strOrNull(row["attempt_id"]),
    stageKey: str(row["stage_key"]),
    framework: str(row["framework"]),
    status: str(row["status"]) as TestRunRecord["status"],
    passed: numOrNull(row["passed"]),
    failed: numOrNull(row["failed"]),
    skipped: numOrNull(row["skipped"]),
    total: numOrNull(row["total"]),
    parsedConfidently: bool(row["parsed_confidently"]),
    summary: strOrNull(row["summary"]),
    durationMs: numOrNull(row["duration_ms"]),
    createdAt: str(row["created_at"]),
  };
}

function mapGitSnapshot(row: Row): GitSnapshotRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    stageKey: str(row["stage_key"]),
    attemptId: strOrNull(row["attempt_id"]),
    phase: str(row["phase"]) === "after" ? "after" : "before",
    headSha: strOrNull(row["head_sha"]),
    branch: strOrNull(row["branch"]),
    detached: bool(row["detached"]),
    dirty: bool(row["dirty"]),
    stagedPaths: jsonValue<string[]>(row["staged_paths"], []),
    unstagedPaths: jsonValue<string[]>(row["unstaged_paths"], []),
    untrackedPaths: jsonValue<string[]>(row["untracked_paths"], []),
    diffStat: strOrNull(row["diff_stat"]),
    localCommits: jsonValue<{ sha: string; subject: string }[]>(
      row["local_commits"],
      [],
    ),
    ahead: numOrNull(row["ahead"]),
    behind: numOrNull(row["behind"]),
    unavailableReason: strOrNull(row["unavailable_reason"]),
    capturedAt: str(row["captured_at"]),
  };
}

function mapArtifact(row: Row): ArtifactRecord {
  return {
    id: str(row["id"]),
    runId: str(row["run_id"]),
    taskId: strOrNull(row["task_id"]),
    attemptId: strOrNull(row["attempt_id"]),
    stageKey: str(row["stage_key"]),
    path: str(row["path"]),
    kind: str(row["kind"]),
    creator: str(row["creator"]),
    exists: bool(row["exists_flag"]),
    sizeBytes: numOrNull(row["size_bytes"]),
    note: strOrNull(row["note"]),
    createdAt: str(row["created_at"]),
  };
}

/* -------------------------------- options -------------------------------- */

export interface StoreOptions {
  /** SQLite file path, or ':memory:'. Ignored when `db` is provided. */
  path?: string;
  db?: DatabaseSync;
  /** Apply migrations on open (default true). */
  migrate?: boolean;
  migrateUpTo?: number;
  /** Attach WAL and busy timeout (default true for file databases). */
  configure?: boolean;
  now?: () => string;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  canonicalRoot: string;
  vcs?: VcsKind;
  defaultBranch?: string | null;
  verificationCommands?: CommandSpec[];
  settings?: Record<string, unknown>;
}

export interface CreateAgentInput {
  id?: string;
  name: string;
  adapterKind: string;
  roleHint?: string | null;
  model?: string | null;
  effort?: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface CreateRunRowInput {
  id?: string;
  projectId: string;
  templateId: string;
  goal: string;
  constraints: string[];
  roleMapping: Record<RoleKey, string>;
  policy: RunPolicy;
  plan: StagePlan;
}

export interface CreateTaskInput {
  id?: string;
  runId: string;
  stageKey: string;
  title: string;
  kind: StageKind;
  role: RoleKey;
  agentId?: string | null;
  plan?: Record<string, unknown>;
}

export interface CreateAttemptInput {
  id?: string;
  taskId: string;
  runId: string;
  stageKey: string;
  attemptNumber: number;
  kind: AttemptKind;
  reason?: string | null;
  previousAttemptId?: string | null;
  agentId?: string | null;
  adapterKind?: string | null;
  agentSessionId?: string | null;
  promptPacket?: PromptPacket | null;
  promptText?: string | null;
  status?: AttemptStatus;
  startedAt?: string | null;
}

export interface AppendEventInput {
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  stageKey?: string | null;
  category: EventCategory;
  type: string;
  actor?: EventActor;
  payload?: Record<string, unknown>;
  at?: string;
}

export interface CreateApprovalInput {
  runId: string;
  stageKey: string;
  gate: ApprovalGateKind;
  allowed: readonly ApprovalDecision[];
  taskId?: string | null;
  attemptId?: string | null;
  reason?: string | null;
}

export interface InsertReviewVerdictInput {
  runId: string;
  taskId: string;
  attemptId: string;
  stageKey: string;
  cycle: number;
  valid: boolean;
  validationErrors: string[];
  verdict?: ReviewVerdictKind | null;
  summary?: string | null;
  issues?: ReviewIssue[];
  confidence?: number | null;
  reviewer?: string | null;
  raw: string;
}

export interface InsertGitSnapshotInput {
  runId: string;
  stageKey: string;
  attemptId?: string | null;
  phase: "before" | "after";
  summary: GitCheckpointSummary | null;
  unavailableReason?: string | null;
}

export interface InsertArtifactInput {
  runId: string;
  stageKey: string;
  taskId?: string | null;
  attemptId?: string | null;
  path: string;
  kind: string;
  creator: string;
  exists?: boolean;
  sizeBytes?: number | null;
  note?: string | null;
}

export interface InsertShellCommandInput {
  runId: string;
  stageKey: string;
  taskId?: string | null;
  attemptId?: string | null;
  testRunId?: string | null;
  name: string;
  executable: string;
  args: string[];
  cwd?: string | null;
  status: ShellCommandRecord["status"];
  exitCode?: number | null;
  durationMs?: number | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  truncated?: boolean;
}

export interface InsertTestRunInput {
  runId: string;
  stageKey: string;
  taskId?: string | null;
  attemptId?: string | null;
  framework: string;
  status: TestRunRecord["status"];
  passed?: number | null;
  failed?: number | null;
  skipped?: number | null;
  total?: number | null;
  parsedConfidently?: boolean;
  summary?: string | null;
  durationMs?: number | null;
}

export class Store implements TemplateStore {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly now: () => string;
  private txDepth = 0;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const path = options.path ?? ":memory:";
      this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      this.ownsDb = true;
      if (options.configure !== false && path !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA foreign_keys = ON;");
    }
    if (options.migrate !== false) {
      migrate(
        this.db,
        options.migrateUpTo === undefined
          ? {}
          : { upTo: options.migrateUpTo, now: this.now },
      );
    }
  }

  static memory(options: Omit<StoreOptions, "path"> = {}): Store {
    return new Store({ ...options, path: ":memory:" });
  }

  /* ------------------------------ migrations ----------------------------- */

  migrate(options: MigrateOptions = {}): {
    applied: number[];
    version: number;
  } {
    return migrate(this.db, { now: this.now, ...options });
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  get latestMigrationVersion(): number {
    return LATEST_MIGRATION_VERSION;
  }

  migrations(): { version: number; name: string; appliedAt: string }[] {
    return appliedMigrations(this.db);
  }

  tables(): string[] {
    return tableNames(this.db);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  /* ---------------------------- transactions ----------------------------- */

  /**
   * Run `fn` inside an IMMEDIATE transaction. Nested calls join the outer
   * transaction, so transition helpers can be composed safely.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the original error is more useful than a rollback failure
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  private rows<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => row as unknown as T);
  }

  private row<T>(
    sql: string,
    params: (string | number | null)[] = [],
  ): T | undefined {
    const found = this.db.prepare(sql).get(...params);
    return found === undefined ? undefined : (found as unknown as T);
  }

  private guardedUpdate(
    table: string,
    id: string,
    patch: Record<string, string | number | null>,
    from: readonly string[],
  ): boolean {
    const entries = Object.entries(patch).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length === 0) return false;
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    const placeholders = from.map(() => "?").join(", ");
    const sql = `UPDATE ${table} SET ${assignments} WHERE id = ? AND status IN (${placeholders})`;
    const result = this.db.prepare(sql).run(...values, id, ...from);
    return Number(result.changes) === 1;
  }

  private buildPatch<K extends string>(
    patch: Partial<Record<K, unknown>>,
    columns: Record<K, string>,
    transform?: (key: K, value: unknown) => unknown,
  ): Record<string, string | number | null> {
    const out: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(patch) as [K, unknown][]) {
      if (value === undefined) continue;
      const column = columns[key];
      if (!column) continue;
      const safe = redactValue(value);
      const transformed = transform ? transform(key, safe) : safe;
      out[column] = toSql(transformed);
    }
    return out;
  }

  /* ------------------------------- projects ------------------------------ */

  createProject(input: CreateProjectInput): ProjectRecord {
    input = redactValue(input);
    const id = input.id ?? newId("project");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, canonical_root, vcs, default_branch, verification_commands, settings, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.canonicalRoot,
        input.vcs ?? "git",
        input.defaultBranch ?? null,
        JSON.stringify(redactValue(input.verificationCommands ?? [])),
        JSON.stringify(redactValue(input.settings ?? {})),
        now,
        now,
      );
    const project = this.getProject(id);
    if (!project)
      throw new NotFoundError(`project ${id} vanished after insert`);
    return project;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.row<Row>("SELECT * FROM projects WHERE id = ?", [
      guardId(id, "project id"),
    ]);
    return row ? mapProject(row) : undefined;
  }

  getProjectByRoot(canonicalRoot: string): ProjectRecord | undefined {
    const row = this.row<Row>(
      "SELECT * FROM projects WHERE canonical_root = ?",
      [canonicalRoot],
    );
    return row ? mapProject(row) : undefined;
  }

  listProjects(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const sql = options.includeArchived
      ? "SELECT * FROM projects ORDER BY created_at, id"
      : "SELECT * FROM projects WHERE archived = 0 ORDER BY created_at, id";
    return this.rows<Row>(sql).map(mapProject);
  }

  updateProject(
    id: string,
    patch: Partial<{
      name: string;
      defaultBranch: string | null;
      verificationCommands: CommandSpec[];
      settings: Record<string, unknown>;
      archived: boolean;
    }>,
  ): ProjectRecord | undefined {
    const entries: [string, unknown][] = [];
    if (patch.name !== undefined) entries.push(["name", patch.name]);
    if (patch.defaultBranch !== undefined)
      entries.push(["default_branch", patch.defaultBranch]);
    if (patch.verificationCommands !== undefined)
      entries.push([
        "verification_commands",
        JSON.stringify(redactValue(patch.verificationCommands)),
      ]);
    if (patch.settings !== undefined)
      entries.push(["settings", JSON.stringify(redactValue(patch.settings))]);
    if (patch.archived !== undefined)
      entries.push(["archived", patch.archived ? 1 : 0]);
    if (entries.length === 0) return this.getProject(id);
    entries.push(["updated_at", this.now()]);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db
      .prepare(`UPDATE projects SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => toSql(value)), id);
    return this.getProject(id);
  }

  /* -------------------------------- agents ------------------------------- */

  createAgent(input: CreateAgentInput): AgentRecord {
    input = redactValue(input);
    const id = input.id ?? newId("agent");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role_hint, adapter_kind, model, effort, enabled, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.roleHint ?? null,
        input.adapterKind,
        input.model ?? null,
        input.effort ?? null,
        input.enabled === false ? 0 : 1,
        JSON.stringify(redactValue(input.config ?? {})),
        now,
        now,
      );
    const agent = this.getAgent(id);
    if (!agent) throw new NotFoundError(`agent ${id} vanished after insert`);
    return agent;
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.row<Row>("SELECT * FROM agents WHERE id = ?", [
      guardId(id, "agent id"),
    ]);
    return row ? mapAgent(row) : undefined;
  }

  getAgentByName(name: string): AgentRecord | undefined {
    const row = this.row<Row>("SELECT * FROM agents WHERE name = ?", [name]);
    return row ? mapAgent(row) : undefined;
  }

  listAgents(options: { enabledOnly?: boolean } = {}): AgentRecord[] {
    const sql = options.enabledOnly
      ? "SELECT * FROM agents WHERE enabled = 1 ORDER BY name"
      : "SELECT * FROM agents ORDER BY name";
    return this.rows<Row>(sql).map(mapAgent);
  }

  updateAgent(
    id: string,
    patch: Partial<{
      name: string;
      roleHint: string | null;
      adapterKind: string;
      model: string | null;
      effort: string | null;
      enabled: boolean;
      config: Record<string, unknown>;
    }>,
  ): AgentRecord | undefined {
    const entries: [string, unknown][] = [];
    if (patch.name !== undefined) entries.push(["name", patch.name]);
    if (patch.roleHint !== undefined)
      entries.push(["role_hint", patch.roleHint]);
    if (patch.adapterKind !== undefined)
      entries.push(["adapter_kind", patch.adapterKind]);
    if (patch.model !== undefined) entries.push(["model", patch.model]);
    if (patch.effort !== undefined) entries.push(["effort", patch.effort]);
    if (patch.enabled !== undefined)
      entries.push(["enabled", patch.enabled ? 1 : 0]);
    if (patch.config !== undefined)
      entries.push(["config", JSON.stringify(redactValue(patch.config))]);
    if (entries.length === 0) return this.getAgent(id);
    entries.push(["updated_at", this.now()]);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db
      .prepare(`UPDATE agents SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => toSql(value)), id);
    return this.getAgent(id);
  }

  /* ------------------------------ templates ------------------------------ */

  upsertTemplate(input: { definition: TemplateDefinition; plan: StagePlan }): {
    created: boolean;
    templateId: string;
    version: number;
  } {
    const { definition, plan } = input;
    const existing = this.getTemplate(definition.id);
    const now = this.now();
    return this.transaction(() => {
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO workflow_templates (id, name, description, version, builtin, default_max_review_cycles, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            definition.id,
            definition.name,
            definition.description,
            definition.version,
            definition.defaultMaxReviewCycles,
            now,
            now,
          );
      } else {
        this.db
          .prepare(
            `UPDATE workflow_templates SET name = ?, description = ?, version = ?, builtin = 1, default_max_review_cycles = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            definition.name,
            definition.description,
            definition.version,
            definition.defaultMaxReviewCycles,
            now,
            definition.id,
          );
        this.db
          .prepare("DELETE FROM workflow_stages WHERE template_id = ?")
          .run(definition.id);
      }
      for (const stage of plan.stages) {
        this.db
          .prepare(
            `INSERT INTO workflow_stages (id, template_id, key, name, kind, role, order_index, instructions, depends_on, next_stage_key, loop, max_review_cycles, conditional)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId("templateStage"),
            definition.id,
            stage.key,
            stage.name,
            stage.kind,
            stage.role,
            stage.orderIndex,
            stage.instructions,
            JSON.stringify(stage.dependsOn),
            stage.nextStageKey,
            stage.loop ? JSON.stringify(stage.loop) : null,
            stage.maxReviewCycles,
            stage.conditional ? 1 : 0,
          );
      }
      return {
        created: !existing,
        templateId: definition.id,
        version: definition.version,
      };
    });
  }

  getTemplate(id: string): WorkflowTemplateRecord | undefined {
    const row = this.row<Row>("SELECT * FROM workflow_templates WHERE id = ?", [
      id,
    ]);
    return row ? mapTemplate(row) : undefined;
  }

  listTemplates(): WorkflowTemplateRecord[] {
    return this.rows<Row>("SELECT * FROM workflow_templates ORDER BY id").map(
      mapTemplate,
    );
  }

  getTemplateStages(templateId: string): WorkflowStageRecord[] {
    return this.rows<Row>(
      "SELECT * FROM workflow_stages WHERE template_id = ? ORDER BY order_index",
      [templateId],
    ).map(mapTemplateStage);
  }

  /** Rebuild the plan snapshot from persisted template stages. */
  getTemplatePlan(templateId: string): StagePlan | undefined {
    const template = this.getTemplate(templateId);
    if (!template) return undefined;
    const stages = this.getTemplateStages(templateId);
    if (stages.length === 0) return undefined;
    const entry = stages
      .filter((stage) => stage.loop === null)
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];
    if (!entry) return undefined;
    const finalStage = stages.find((stage) => stage.kind === "final_approval");
    return {
      templateId,
      templateVersion: template.version,
      entryStageKey: entry.key,
      finalStageKey: finalStage?.key ?? null,
      stages: stages.map((stage) => ({
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
        role: stage.role,
        orderIndex: stage.orderIndex,
        instructions: stage.instructions,
        dependsOn: stage.dependsOn,
        nextStageKey: stage.nextStageKey,
        loop: stage.loop,
        conditional: stage.conditional,
        maxReviewCycles: stage.maxReviewCycles,
      })),
    };
  }

  /* --------------------------------- runs -------------------------------- */

  getActiveRunForProject(projectId: string): RunRecord | undefined {
    const placeholders = LEASED_RUN_STATUSES.map(() => "?").join(", ");
    const row = this.row<Row>(
      `SELECT * FROM runs WHERE project_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      [projectId, ...LEASED_RUN_STATUSES],
    );
    return row ? mapRun(row) : undefined;
  }

  /** Create a run plus its frozen stage/task rows, enforcing the project lease. */
  createRun(input: CreateRunRowInput): RunRecord {
    input = redactValue(input);
    const id = input.id ?? newId("run");
    const now = this.now();
    return this.transaction(() => {
      const active = this.getActiveRunForProject(input.projectId);
      if (active) {
        throw new ConflictError(
          `project already has an active run (${active.id} is ${active.status})`,
          {
            projectId: input.projectId,
            activeRunId: active.id,
          },
        );
      }
      const project = this.getProject(input.projectId);
      if (!project)
        throw new NotFoundError(`project ${input.projectId} not found`);

      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, project_root, template_id, template_version, goal, constraints, status, role_mapping, policy, stage_plan, next_stage_key, current_attempt_id, review_cycle, epoch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          project.canonicalRoot,
          input.templateId,
          input.plan.templateVersion,
          input.goal,
          JSON.stringify(redactValue(input.constraints)),
          "DRAFT",
          JSON.stringify(redactValue(input.roleMapping)),
          JSON.stringify(redactValue(input.policy)),
          JSON.stringify(redactValue(input.plan)),
          input.plan.entryStageKey,
          now,
          now,
        );

      for (const stage of input.plan.stages) {
        const dormant = stage.loop !== null;
        const role = stage.role;
        const agentId = input.roleMapping[role] ?? null;
        this.db
          .prepare(
            `INSERT INTO run_stages (id, run_id, key, name, kind, role, agent_id, order_index, status, instructions, depends_on, next_stage_key, loop, conditional, skip_reason, cycle, attempt_count, overridden, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`,
          )
          .run(
            newId("runStage"),
            id,
            stage.key,
            stage.name,
            stage.kind,
            role,
            agentId,
            stage.orderIndex,
            dormant ? "SKIPPED" : "PENDING",
            stage.instructions,
            JSON.stringify(stage.dependsOn),
            stage.nextStageKey,
            stage.loop ? JSON.stringify(stage.loop) : null,
            stage.conditional ? 1 : 0,
            dormant ? "loop_not_triggered" : null,
            now,
          );

        this.db
          .prepare(
            `INSERT INTO tasks (id, run_id, stage_key, title, kind, role, agent_id, status, plan, attempt_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            newId("task"),
            id,
            stage.key,
            stage.name,
            stage.kind,
            role,
            agentId,
            dormant ? "SKIPPED" : "PENDING",
            JSON.stringify({
              instructions: stage.instructions,
              loop: stage.loop,
            }),
            now,
            now,
          );
      }

      const run = this.getRun(id);
      if (!run) throw new NotFoundError(`run ${id} vanished after insert`);
      return run;
    });
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.row<Row>("SELECT * FROM runs WHERE id = ?", [
      guardId(id, "run id"),
    ]);
    return row ? mapRun(row) : undefined;
  }

  requireRun(id: string): RunRecord {
    const run = this.getRun(id);
    if (!run) throw new NotFoundError(`run ${id} not found`);
    return run;
  }

  listRuns(
    query: {
      projectId?: string | null;
      status?: RunStatus | null;
      statuses?: readonly RunStatus[] | null;
      limit?: number | null;
    } = {},
  ): RunRecord[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.projectId) {
      conditions.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.status) {
      conditions.push("status = ?");
      params.push(query.status);
    }
    if (query.statuses && query.statuses.length > 0) {
      conditions.push(
        `status IN (${query.statuses.map(() => "?").join(", ")})`,
      );
      params.push(...query.statuses);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 200;
    params.push(limit);
    return this.rows<Row>(
      `SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    ).map(mapRun);
  }

  /** History search across project, goal, agent, status, date, branch and verdict. */
  searchRuns(query: RunSearchQuery = {}): RunSearchHit[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.projectId) {
      conditions.push("r.project_id = ?");
      params.push(query.projectId);
    }
    if (query.status) {
      conditions.push("r.status = ?");
      params.push(query.status);
    }
    if (query.templateId) {
      conditions.push("r.template_id = ?");
      params.push(query.templateId);
    }
    if (query.goalContains) {
      conditions.push("r.goal LIKE '%' || ? || '%'");
      params.push(query.goalContains);
    }
    if (query.createdAfter) {
      conditions.push("r.created_at >= ?");
      params.push(query.createdAfter);
    }
    if (query.createdBefore) {
      conditions.push("r.created_at <= ?");
      params.push(query.createdBefore);
    }
    if (query.agentId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM task_attempts a WHERE a.run_id = r.id AND a.agent_id = ?)",
      );
      params.push(query.agentId);
    }
    if (query.branch) {
      conditions.push(
        "EXISTS (SELECT 1 FROM git_snapshots g WHERE g.run_id = r.id AND g.branch = ?)",
      );
      params.push(query.branch);
    }
    if (query.reviewVerdict) {
      conditions.push(
        "EXISTS (SELECT 1 FROM review_verdicts v WHERE v.run_id = r.id AND v.valid = 1 AND v.verdict = ?)",
      );
      params.push(query.reviewVerdict);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    params.push(limit, offset);

    const sql = `
      SELECT r.*,
        (SELECT g.branch FROM git_snapshots g WHERE g.run_id = r.id AND g.branch IS NOT NULL ORDER BY g.captured_at DESC LIMIT 1) AS branch,
        (SELECT v.verdict FROM review_verdicts v WHERE v.run_id = r.id AND v.valid = 1 ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS last_review_verdict
      FROM runs r
      ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`;
    return this.rows<Row>(sql, params).map((row) => ({
      ...mapRun(row),
      branch: strOrNull(row["branch"]),
      lastReviewVerdict:
        (strOrNull(row["last_review_verdict"]) as ReviewVerdictKind | null) ??
        null,
    }));
  }

  /** Compare-and-set update. Returns null when the guard did not match. */
  updateRunGuarded(
    id: string,
    from: readonly RunStatus[],
    patch: RunPatch,
  ): RunRecord | null {
    const mapped = this.buildPatch(patch, RUN_PATCH_COLUMNS);
    if (Object.keys(mapped).length === 0) return this.getRun(id) ?? null;
    const updated = this.guardedUpdate(
      "runs",
      guardId(id, "run id"),
      mapped,
      from,
    );
    return updated ? (this.getRun(id) ?? null) : null;
  }

  updateRunUnconditional(id: string, patch: RunPatch): RunRecord | undefined {
    const mapped = this.buildPatch(patch, RUN_PATCH_COLUMNS);
    if (Object.keys(mapped).length === 0) return this.getRun(id);
    const assignments = Object.keys(mapped)
      .map((column) => `${column} = ?`)
      .join(", ");
    this.db
      .prepare(`UPDATE runs SET ${assignments} WHERE id = ?`)
      .run(...Object.values(mapped), id);
    return this.getRun(id);
  }

  /* ------------------------------ run stages ----------------------------- */

  getStages(runId: string): StageRecord[] {
    return this.rows<Row>(
      "SELECT * FROM run_stages WHERE run_id = ? ORDER BY order_index",
      [runId],
    ).map(mapStage);
  }

  getStageByKey(runId: string, key: string): StageRecord | undefined {
    const row = this.row<Row>(
      "SELECT * FROM run_stages WHERE run_id = ? AND key = ?",
      [runId, key],
    );
    return row ? mapStage(row) : undefined;
  }

  getStage(id: string): StageRecord | undefined {
    const row = this.row<Row>("SELECT * FROM run_stages WHERE id = ?", [
      guardId(id, "stage id"),
    ]);
    return row ? mapStage(row) : undefined;
  }

  listStagesByStatus(statuses: readonly StageStatus[]): StageRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.rows<Row>(
      `SELECT * FROM run_stages WHERE status IN (${placeholders}) ORDER BY run_id, order_index`,
      [...statuses],
    ).map(mapStage);
  }

  updateStageGuarded(
    id: string,
    from: readonly StageStatus[],
    patch: StagePatch,
  ): StageRecord | null {
    const mapped = this.buildPatch(patch, STAGE_PATCH_COLUMNS);
    if (Object.keys(mapped).length === 0) return this.getStage(id) ?? null;
    const updated = this.guardedUpdate(
      "run_stages",
      guardId(id, "stage id"),
      mapped,
      from,
    );
    return updated ? (this.getStage(id) ?? null) : null;
  }

  /* --------------------------------- tasks ------------------------------- */

  createTask(input: CreateTaskInput): TaskRecord {
    input = redactValue(input);
    const id = input.id ?? newId("task");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, run_id, stage_key, title, kind, role, agent_id, status, plan, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.stageKey,
        input.title,
        input.kind,
        input.role,
        input.agentId ?? null,
        JSON.stringify(redactValue(input.plan ?? {})),
        now,
        now,
      );
    const task = this.getTask(id);
    if (!task) throw new NotFoundError(`task ${id} vanished after insert`);
    return task;
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.row<Row>("SELECT * FROM tasks WHERE id = ?", [
      guardId(id, "task id"),
    ]);
    return row ? mapTask(row) : undefined;
  }

  getTaskByStage(runId: string, stageKey: string): TaskRecord | undefined {
    const row = this.row<Row>(
      "SELECT * FROM tasks WHERE run_id = ? AND stage_key = ?",
      [runId, stageKey],
    );
    return row ? mapTask(row) : undefined;
  }

  listTasks(runId: string): TaskRecord[] {
    return this.rows<Row>(
      "SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, id",
      [runId],
    ).map(mapTask);
  }

  listTasksByStatus(statuses: readonly TaskStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.rows<Row>(
      `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY run_id, created_at`,
      [...statuses],
    ).map(mapTask);
  }

  updateTaskGuarded(
    id: string,
    from: readonly TaskStatus[],
    patch: TaskPatch,
  ): TaskRecord | null {
    const mapped = this.buildPatch(patch, TASK_PATCH_COLUMNS);
    if (Object.keys(mapped).length === 0) return this.getTask(id) ?? null;
    const updated = this.guardedUpdate("tasks", id, mapped, from);
    return updated ? (this.getTask(id) ?? null) : null;
  }

  /* -------------------------------- attempts ----------------------------- */

  createAttempt(input: CreateAttemptInput): AttemptRecord {
    input = redactValue(input);
    const id = input.id ?? newId("attempt");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO task_attempts (id, task_id, run_id, stage_key, attempt_number, reason, previous_attempt_id, kind, status, agent_id, adapter_kind, agent_session_id, prompt_packet, prompt_text, inputs, usage_known, artifacts, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, '[]', ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.runId,
        input.stageKey,
        input.attemptNumber,
        input.reason ?? null,
        input.previousAttemptId ?? null,
        input.kind,
        input.status ?? "RUNNING",
        input.agentId ?? null,
        input.adapterKind ?? null,
        input.agentSessionId ?? null,
        input.promptPacket
          ? JSON.stringify(redactValue(input.promptPacket))
          : null,
        input.promptText ?? null,
        now,
        input.startedAt ?? now,
      );
    const attempt = this.getAttempt(id);
    if (!attempt)
      throw new NotFoundError(`attempt ${id} vanished after insert`);
    return attempt;
  }

  getAttempt(id: string): AttemptRecord | undefined {
    const row = this.row<Row>("SELECT * FROM task_attempts WHERE id = ?", [
      guardId(id, "attempt id"),
    ]);
    return row ? mapAttempt(row) : undefined;
  }

  listAttempts(taskId: string): AttemptRecord[] {
    return this.rows<Row>(
      "SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number",
      [taskId],
    ).map(mapAttempt);
  }

  listAttemptsForRun(runId: string): AttemptRecord[] {
    return this.rows<Row>(
      "SELECT * FROM task_attempts WHERE run_id = ? ORDER BY created_at, attempt_number",
      [runId],
    ).map(mapAttempt);
  }

  listAttemptsByStatus(statuses: readonly AttemptStatus[]): AttemptRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.rows<Row>(
      `SELECT * FROM task_attempts WHERE status IN (${placeholders}) ORDER BY created_at`,
      [...statuses],
    ).map(mapAttempt);
  }

  listLiveAttempts(): AttemptRecord[] {
    return this.listAttemptsByStatus(LIVE_ATTEMPT_STATUSES);
  }

  lastAttempt(taskId: string): AttemptRecord | undefined {
    const row = this.row<Row>(
      "SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1",
      [taskId],
    );
    return row ? mapAttempt(row) : undefined;
  }

  updateAttemptGuarded(
    id: string,
    from: readonly AttemptStatus[],
    patch: AttemptPatch,
  ): AttemptRecord | null {
    const mapped = this.buildPatch(
      patch,
      ATTEMPT_PATCH_COLUMNS,
      (key, value) => {
        if (key === "usageKnown") return value ? 1 : 0;
        return value;
      },
    );
    if (Object.keys(mapped).length === 0) return this.getAttempt(id) ?? null;
    const updated = this.guardedUpdate(
      "task_attempts",
      guardId(id, "attempt id"),
      mapped,
      from,
    );
    return updated ? (this.getAttempt(id) ?? null) : null;
  }

  /** Record operator input on an attempt and hand the attempt back to RUNNING. */
  appendAttemptInput(attemptId: string, text: string): AttemptRecord | null {
    return this.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) return null;
      if (attempt.status !== "WAITING_INPUT") return null;
      const inputs = [...attempt.inputs, text];
      const updated = this.updateAttemptGuarded(attemptId, ["WAITING_INPUT"], {
        inputs,
        status: "RUNNING",
      });
      return updated;
    });
  }

  getAttemptPrompt(
    attemptId: string,
  ): { packet: PromptPacket | null; promptText: string | null } | undefined {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) return undefined;
    return { packet: attempt.promptPacket, promptText: attempt.promptText };
  }

  /* -------------------------------- events ------------------------------- */

  appendEvent(input: AppendEventInput): EventRecord {
    input = redactValue(input);
    const at = input.at ?? this.now();
    const result = this.db
      .prepare(
        `INSERT INTO events (project_id, run_id, task_id, attempt_id, stage_key, category, type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.runId ?? null,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.stageKey ?? null,
        input.category,
        input.type,
        input.actor ?? "engine",
        JSON.stringify(redactValue(input.payload ?? {})),
        at,
      );
    const id = Number(result.lastInsertRowid);
    const row = this.row<Row>("SELECT * FROM events WHERE id = ?", [id]);
    if (!row) throw new NotFoundError(`event ${id} vanished after insert`);
    return mapEvent(row);
  }

  listEvents(query: EventQuery = {}): EventRecord[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.runId) {
      conditions.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.projectId) {
      conditions.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.category) {
      conditions.push("category = ?");
      params.push(query.category);
    }
    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.afterId !== undefined && query.afterId !== null) {
      conditions.push("id > ?");
      params.push(query.afterId);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(query.limit ?? 1000);
    return this.rows<Row>(
      `SELECT * FROM events ${where} ORDER BY id LIMIT ?`,
      params,
    ).map(mapEvent);
  }

  getEvent(id: number): EventRecord | undefined {
    const row = this.row<Row>("SELECT * FROM events WHERE id = ?", [id]);
    return row ? mapEvent(row) : undefined;
  }

  countEvents(runId: string): number {
    const row = this.row<Row>(
      "SELECT COUNT(*) AS count FROM events WHERE run_id = ?",
      [runId],
    );
    return num(row?.["count"]);
  }

  /* ------------------------------ approvals ------------------------------ */

  createApprovalRequest(input: CreateApprovalInput): ApprovalRecord {
    input = redactValue(input);
    const id = newId("approval");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, stage_key, task_id, attempt_id, gate, status, allowed, reason, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.stageKey,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.gate,
        JSON.stringify([...input.allowed]),
        input.reason ?? null,
        now,
      );
    const approval = this.getApproval(id);
    if (!approval)
      throw new NotFoundError(`approval ${id} vanished after insert`);
    return approval;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.row<Row>("SELECT * FROM approvals WHERE id = ?", [id]);
    return row ? mapApproval(row) : undefined;
  }

  getPendingApproval(runId: string): ApprovalRecord | undefined {
    const row = this.row<Row>(
      "SELECT * FROM approvals WHERE run_id = ? AND status = 'PENDING' ORDER BY requested_at, id LIMIT 1",
      [runId],
    );
    return row ? mapApproval(row) : undefined;
  }

  listApprovals(runId: string): ApprovalRecord[] {
    return this.rows<Row>(
      "SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at, id",
      [runId],
    ).map(mapApproval);
  }

  listPendingApprovals(): ApprovalRecord[] {
    return this.rows<Row>(
      "SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY requested_at, id",
    ).map(mapApproval);
  }

  /** Record a decision. Fails (returns null) when the gate was already decided. */
  decideApproval(
    id: string,
    decision: ApprovalDecision,
    options: { instruction?: string | null; actor?: string | null } = {},
  ): ApprovalRecord | null {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'DECIDED', decision = ?, instruction = ?, actor = ?, decided_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(
        decision,
        options.instruction ?? null,
        options.actor ?? null,
        this.now(),
        id,
      );
    if (Number(result.changes) !== 1) return null;
    return this.getApproval(id) ?? null;
  }

  /** Mark a pending gate as no longer relevant (cancellation, retry). */
  supersedePendingApprovals(
    runId: string,
    decision: ApprovalDecision,
    actor: string,
    instruction?: string | null,
  ): number {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'DECIDED', decision = ?, instruction = ?, actor = ?, decided_at = ?
         WHERE run_id = ? AND status = 'PENDING'`,
      )
      .run(decision, instruction ?? null, actor, this.now(), runId);
    return Number(result.changes);
  }

  /* --------------------------- review verdicts --------------------------- */

  insertReviewVerdict(input: InsertReviewVerdictInput): ReviewVerdictRecord {
    input = redactValue(input);
    const id = newId("review");
    this.db
      .prepare(
        `INSERT INTO review_verdicts (id, run_id, task_id, attempt_id, stage_key, cycle, valid, validation_errors, verdict, summary, issues, confidence, reviewer, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId,
        input.attemptId,
        input.stageKey,
        input.cycle,
        input.valid ? 1 : 0,
        JSON.stringify(redactValue(input.validationErrors)),
        input.verdict ?? null,
        input.summary ?? null,
        JSON.stringify(redactValue(input.issues ?? [])),
        input.confidence ?? null,
        input.reviewer ?? null,
        input.raw,
        this.now(),
      );
    const record = this.getReviewVerdict(id);
    if (!record)
      throw new NotFoundError(`review verdict ${id} vanished after insert`);
    return record;
  }

  getReviewVerdict(id: string): ReviewVerdictRecord | undefined {
    const row = this.row<Row>("SELECT * FROM review_verdicts WHERE id = ?", [
      id,
    ]);
    return row ? mapReviewVerdict(row) : undefined;
  }

  listReviewVerdicts(
    runId: string,
    options: { stageKey?: string | null; validOnly?: boolean } = {},
  ): ReviewVerdictRecord[] {
    const conditions = ["run_id = ?"];
    const params: (string | number | null)[] = [runId];
    if (options.stageKey) {
      conditions.push("stage_key = ?");
      params.push(options.stageKey);
    }
    if (options.validOnly) conditions.push("valid = 1");
    return this.rows<Row>(
      `SELECT * FROM review_verdicts WHERE ${conditions.join(" AND ")} ORDER BY created_at, id`,
      params,
    ).map(mapReviewVerdict);
  }

  /* --------------------------- agent sessions ---------------------------- */

  createAgentSession(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    agentId: string;
    adapterKind: string;
    status: string;
    pid?: number | null;
    handle?: Record<string, unknown>;
    sessionId?: string;
  }): AgentSessionRecord {
    const id = input.sessionId ?? newId("session");
    this.db
      .prepare(
        `INSERT INTO agent_sessions (id, run_id, task_id, attempt_id, agent_id, adapter_kind, status, pid, handle, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId,
        input.attemptId,
        input.agentId,
        input.adapterKind,
        input.status,
        input.pid ?? null,
        JSON.stringify(redactValue(input.handle ?? {})),
        this.now(),
      );
    const session = this.getAgentSession(id);
    if (!session)
      throw new NotFoundError(`agent session ${id} vanished after insert`);
    return session;
  }

  getAgentSession(id: string): AgentSessionRecord | undefined {
    const row = this.row<Row>("SELECT * FROM agent_sessions WHERE id = ?", [
      id,
    ]);
    return row ? mapSession(row) : undefined;
  }

  listAgentSessions(runId: string): AgentSessionRecord[] {
    return this.rows<Row>(
      "SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY started_at, id",
      [runId],
    ).map(mapSession);
  }

  updateAgentSession(
    id: string,
    patch: {
      status?: string;
      cancelReason?: string | null;
      endedAt?: string | null;
      pid?: number | null;
    },
  ): AgentSessionRecord | undefined {
    const entries: [string, unknown][] = [];
    if (patch.status !== undefined) entries.push(["status", patch.status]);
    if (patch.cancelReason !== undefined)
      entries.push(["cancel_reason", patch.cancelReason]);
    if (patch.endedAt !== undefined) entries.push(["ended_at", patch.endedAt]);
    if (patch.pid !== undefined) entries.push(["pid", patch.pid]);
    if (entries.length === 0) return this.getAgentSession(id);
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.db
      .prepare(`UPDATE agent_sessions SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => toSql(value)), id);
    return this.getAgentSession(id);
  }

  listLiveAgentSessions(): AgentSessionRecord[] {
    return this.rows<Row>(
      "SELECT * FROM agent_sessions WHERE ended_at IS NULL ORDER BY started_at",
    ).map(mapSession);
  }

  /* ------------------- planned records: git/commands/tests --------------- */

  insertGitSnapshot(input: InsertGitSnapshotInput): GitSnapshotRecord {
    input = redactValue(input);
    const id = newId("gitSnapshot");
    const summary = input.summary;
    this.db
      .prepare(
        `INSERT INTO git_snapshots (id, run_id, stage_key, attempt_id, phase, head_sha, branch, detached, dirty, staged_paths, unstaged_paths, untracked_paths, diff_stat, local_commits, ahead, behind, unavailable_reason, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.stageKey,
        input.attemptId ?? null,
        input.phase,
        summary?.headSha ?? null,
        summary?.branch ?? null,
        summary?.detached ? 1 : 0,
        summary?.dirty ? 1 : 0,
        JSON.stringify(summary?.staged ?? []),
        JSON.stringify(summary?.unstaged ?? []),
        JSON.stringify(summary?.untracked ?? []),
        summary?.diffStat ?? null,
        JSON.stringify(summary?.localCommits ?? []),
        summary?.ahead ?? null,
        summary?.behind ?? null,
        input.unavailableReason ?? null,
        summary?.capturedAt ?? this.now(),
      );
    const record = this.getGitSnapshot(id);
    if (!record)
      throw new NotFoundError(`git snapshot ${id} vanished after insert`);
    return record;
  }

  getGitSnapshot(id: string): GitSnapshotRecord | undefined {
    const row = this.row<Row>("SELECT * FROM git_snapshots WHERE id = ?", [id]);
    return row ? mapGitSnapshot(row) : undefined;
  }

  listGitSnapshots(runId: string): GitSnapshotRecord[] {
    return this.rows<Row>(
      "SELECT * FROM git_snapshots WHERE run_id = ? ORDER BY captured_at, id",
      [runId],
    ).map(mapGitSnapshot);
  }

  insertArtifact(input: InsertArtifactInput): ArtifactRecord {
    input = redactValue(input);
    const id = newId("artifact");
    this.db
      .prepare(
        `INSERT INTO artifacts (id, run_id, task_id, attempt_id, stage_key, path, kind, creator, exists_flag, size_bytes, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.stageKey,
        input.path,
        input.kind,
        input.creator,
        input.exists === false ? 0 : 1,
        input.sizeBytes ?? null,
        input.note ?? null,
        this.now(),
      );
    const record = this.getArtifact(id);
    if (!record)
      throw new NotFoundError(`artifact ${id} vanished after insert`);
    return record;
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.row<Row>("SELECT * FROM artifacts WHERE id = ?", [id]);
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.rows<Row>(
      "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id",
      [runId],
    ).map(mapArtifact);
  }

  insertShellCommand(input: InsertShellCommandInput): ShellCommandRecord {
    input = redactValue(input);
    const id = newId("shellCommand");
    this.db
      .prepare(
        `INSERT INTO shell_commands (id, run_id, task_id, attempt_id, stage_key, test_run_id, name, executable, args, cwd, status, exit_code, duration_ms, stdout_excerpt, stderr_excerpt, truncated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.stageKey,
        input.testRunId ?? null,
        input.name,
        input.executable,
        JSON.stringify(redactValue(input.args)),
        input.cwd ?? null,
        input.status,
        input.exitCode ?? null,
        input.durationMs ?? null,
        input.stdoutExcerpt ?? null,
        input.stderrExcerpt ?? null,
        input.truncated ? 1 : 0,
        this.now(),
      );
    const record = this.getShellCommand(id);
    if (!record)
      throw new NotFoundError(`shell command ${id} vanished after insert`);
    return record;
  }

  getShellCommand(id: string): ShellCommandRecord | undefined {
    const row = this.row<Row>("SELECT * FROM shell_commands WHERE id = ?", [
      id,
    ]);
    return row ? mapShellCommand(row) : undefined;
  }

  listShellCommands(runId: string): ShellCommandRecord[] {
    return this.rows<Row>(
      "SELECT * FROM shell_commands WHERE run_id = ? ORDER BY created_at, id",
      [runId],
    ).map(mapShellCommand);
  }

  insertTestRun(input: InsertTestRunInput): TestRunRecord {
    input = redactValue(input);
    const id = newId("testRun");
    this.db
      .prepare(
        `INSERT INTO test_runs (id, run_id, task_id, attempt_id, stage_key, framework, status, passed, failed, skipped, total, parsed_confidently, summary, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.taskId ?? null,
        input.attemptId ?? null,
        input.stageKey,
        input.framework,
        input.status,
        input.passed ?? null,
        input.failed ?? null,
        input.skipped ?? null,
        input.total ?? null,
        input.parsedConfidently ? 1 : 0,
        input.summary ?? null,
        input.durationMs ?? null,
        this.now(),
      );
    const record = this.getTestRun(id);
    if (!record)
      throw new NotFoundError(`test run ${id} vanished after insert`);
    return record;
  }

  getTestRun(id: string): TestRunRecord | undefined {
    const row = this.row<Row>("SELECT * FROM test_runs WHERE id = ?", [id]);
    return row ? mapTestRun(row) : undefined;
  }

  listTestRuns(runId: string): TestRunRecord[] {
    return this.rows<Row>(
      "SELECT * FROM test_runs WHERE run_id = ? ORDER BY created_at, id",
      [runId],
    ).map(mapTestRun);
  }

  /* ------------------------------- details ------------------------------- */

  getRunDetail(
    runId: string,
    options: { includeEvents?: boolean; eventLimit?: number } = {},
  ): RunDetail | undefined {
    const run = this.getRun(guardId(runId, "run id"));
    if (!run) return undefined;
    runId = run.id;
    return {
      run,
      plan: run.plan,
      stages: this.getStages(runId),
      tasks: this.listTasks(runId),
      attempts: this.listAttemptsForRun(runId),
      approvals: this.listApprovals(runId),
      pendingApproval: this.getPendingApproval(runId) ?? null,
      reviewVerdicts: this.listReviewVerdicts(runId),
      events:
        options.includeEvents === false
          ? []
          : this.listEvents({ runId, limit: options.eventLimit ?? 5000 }),
    };
  }
}

/* Small helpers shared with the engine. */
export const STORE_STATUS_VALUES = {
  stage: STAGE_STATUSES,
  task: TASK_STATUSES,
  attempt: ATTEMPT_STATUSES,
} as const;
