/**
 * Run screen model (mission control).
 *
 * PASS 3 runs the run page as one screen instead of three parallel inspectors,
 * so everything the screen has to decide *before* rendering lives here as a
 * pure function:
 *
 *  1. `runStateView`   — the single 20px semantic state ("Ready for your
 *     review", "DeepSeek is implementing", "Implementation failed", …). It is
 *     never the persisted status enum and never a raw gate key.
 *  2. `buildRunMilestones` — the horizontal Plan · Build · Verify · Review ·
 *     Final progress, derived from the frozen plan with plain names, four
 *     honest states (complete / current / failed / wait) and an expandable
 *     review → fix → re-verification chronology.
 *  3. `runTabs`        — which of the five main tabs apply to this run.
 *  4. Evidence views for the decision sheet, Changes, Verification, Review and
 *     Activity panels: every number comes from a persisted record, `null` stays
 *     UNKNOWN, and a count is never summed across attempts.
 *
 * Nothing here reads the network, invents a value or paraphrases reviewer prose.
 */
import type {
  AgentRecord,
  EventRecord,
  GitSnapshotRecord,
  ReviewSeverity,
  ReviewVerdictKind,
  ShellCommandRecord,
  StagePlan,
  StageRecord,
  TestRunRecord,
  AttemptRecord,
  ReviewVerdictRecord,
} from "../core/types.js";
import {
  UNKNOWN,
  attemptCountsView,
  classifyDiff,
  commandLine,
  eventMessage,
  fixLoopCycleLabel,
  formatCount,
  formatDuration,
  formatTimestamp,
  issueDisposition,
  issueDispositionLabel,
  issueTally,
  parseDiffStats,
  reviewerIdentity,
  reviewerProvenanceLabel,
  statusLabel,
  text,
  verdictOutcomeLabel,
  verdictTone,
  verdictActionWord,
  verificationCountsLabel,
  verificationLabel,
  verificationShortLabel,
  type ApprovalEvidence,
  type AttemptCountsView,
  type DiffLine,
  type IssueDisposition,
  type ReviewerIdentity,
  type Tone,
} from "./view-model.js";

/* ------------------------------------------------------------------ */
/* The one semantic run state                                          */
/* ------------------------------------------------------------------ */

export interface RunStateView {
  /** The page's single 20px state sentence. */
  headline: string;
  /** `accent` is reserved for the one state that needs the operator now. */
  tone: "accent" | Tone;
  /** A short quiet second line, or null when the headline says it all. */
  detail: string | null;
}

function planningStage(stage: {
  name: string;
  kind: string;
  role?: string | null;
  key?: string | null;
}): boolean {
  const role = (stage.role ?? "").toLowerCase();
  if (role === "planner" || role === "researcher" || role === "documenter")
    return true;
  return PLANNING_PATTERN.test(`${stage.key ?? ""} ${stage.name}`);
}

/**
 * The single semantic state for the run header.
 *
 * Gates that ask for *changes* read "Changes requested"; only the final human
 * acceptance gate reads "Ready for your review". A failure names the stage that
 * failed in plain words ("Implementation failed") instead of the enum, and the
 * active work is described by what the stage actually does — planning,
 * implementing, running verification or reviewing — never by one generic verb.
 */
export function runStateView(input: {
  status: string;
  /** Pending approval gate key, when the run is stopped on a human gate. */
  gate?: string | null;
  /** Stage the run is on or next to, for plain naming. */
  stage?: {
    name: string;
    kind: string;
    role?: string | null;
    key?: string | null;
  } | null;
  /** Agent assigned to the active stage, when the run knows one. */
  agentName?: string | null;
  /** Plain name of the stage that failed/interrupted, when recorded. */
  failedStageName?: string | null;
}): RunStateView {
  const { status } = input;
  const stageName = input.stage?.name ?? null;
  switch (status) {
    case "COMPLETED":
      return { headline: "Completed", tone: "success", detail: null };
    case "CANCELLED":
      return {
        headline: "Cancelled",
        tone: "neutral",
        detail:
          "This run was terminated by an operator and cannot be restarted.",
      };
    case "FAILED":
      return {
        headline: `${input.failedStageName ?? stageName ?? "Run"} failed`,
        tone: "danger",
        detail: null,
      };
    case "INTERRUPTED":
      return {
        headline: `${stageName ?? "Run"} was interrupted`,
        tone: "danger",
        detail: null,
      };
    case "WAITING_INPUT":
      return {
        headline: input.agentName
          ? `${input.agentName} needs your input`
          : "Input is needed to continue",
        tone: "warn",
        detail: null,
      };
    case "WAITING_APPROVAL": {
      if (input.gate === "final_acceptance")
        return {
          headline: "Ready for your review",
          tone: "accent",
          detail: null,
        };
      if (
        input.gate === "review_reject" ||
        input.gate === "review_cycle_exhausted"
      )
        return { headline: "Changes requested", tone: "warn", detail: null };
      return {
        headline: "Waiting for your decision",
        tone: "warn",
        detail: null,
      };
    }
    case "RUNNING":
      return {
        headline: activeWorkSentence(input.stage, input.agentName),
        tone: "active",
        detail: null,
      };
    case "DRAFT":
      return {
        headline: "Draft — not started",
        tone: "neutral",
        detail: null,
      };
    default:
      return { headline: statusLabel(status), tone: "neutral", detail: null };
  }
}

/**
 * What the active stage is actually doing, in one sentence.
 *
 * Planning, implementing, verifying and reviewing are different work; a run
 * that is verifying must never claim an agent is implementing. When no agent is
 * assigned to the stage, the stage's own work is the subject instead.
 */
export function activeWorkSentence(
  stage:
    | { name: string; kind: string; role?: string | null; key?: string | null }
    | null
    | undefined,
  agentName: string | null | undefined,
): string {
  const kind = stage?.kind ?? "task";
  if (kind === "verify")
    return agentName
      ? `${agentName} is running verification`
      : "Verification is running";
  if (kind === "review")
    return agentName ? `${agentName} is reviewing` : "Review is running";
  if (kind === "final_approval") return "Waiting for your decision";
  const verb = stage && planningStage(stage) ? "planning" : "implementing";
  if (agentName) return `${agentName} is ${verb}`;
  return verb === "planning"
    ? "Planning is running"
    : "Implementation is running";
}

/* ------------------------------------------------------------------ */
/* Horizontal stage progress (Plan · Build · Verify · Review · Final)   */
/* ------------------------------------------------------------------ */

export type MilestoneState = "complete" | "current" | "failed" | "wait";

export interface MilestoneStageView {
  key: string;
  name: string;
  kind: string;
  role: string;
  status: string;
  statusWord: string;
  agentName: string | null;
  attemptCount: number;
  /** Plain sentence for a fix/retest branch, or null for a spine stage. */
  loopLabel: string | null;
  loopPhase: "fix" | "retest" | null;
  summary: string | null;
  failureReason: string | null;
  skippedReason: string | null;
  overridden: boolean;
  isCurrent: boolean;
}

export interface RunMilestoneView {
  id: string;
  name: string;
  state: MilestoneState;
  stateWord: string;
  icon: string;
  /** Status word of the stage the milestone is on, or null when it has none. */
  statusWord: string | null;
  /** Evidence tab a click on this milestone opens. */
  tab: RunTabId;
  attemptCount: number;
  stages: MilestoneStageView[];
}

const MILESTONE_STATE_WORDS: Record<MilestoneState, string> = {
  complete: "Complete",
  current: "Current",
  failed: "Failed",
  wait: "Waiting",
};

const MILESTONE_ICONS: Record<MilestoneState, string> = {
  complete: "✓",
  current: "●",
  failed: "!",
  wait: "○",
};

interface MilestoneDefinition {
  id: string;
  name: string;
  tab: RunTabId;
}

const MILESTONE_DEFINITIONS: readonly MilestoneDefinition[] = [
  { id: "plan", name: "Plan", tab: "overview" },
  { id: "build", name: "Build", tab: "changes" },
  { id: "verify", name: "Verify", tab: "verification" },
  { id: "review", name: "Review", tab: "review" },
  { id: "final", name: "Final", tab: "verification" },
];

/** Keys/names that read as planning work rather than implementation work. */
const PLANNING_PATTERN =
  /plan|reproduc|audit|investigat|research|survey|assess|explore|scope|recon/i;

const PLANNING_ROLES = new Set(["planner", "researcher"]);

const FAILED_STAGE_STATUSES = new Set(["FAILED", "CANCELLED", "INTERRUPTED"]);
const WAITING_STAGE_STATUSES = new Set([
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_INPUT",
]);

function milestoneState(stages: readonly MilestoneStageView[]): MilestoneState {
  if (stages.some((stage) => FAILED_STAGE_STATUSES.has(stage.status)))
    return "failed";
  if (
    stages.some(
      (stage) => stage.isCurrent || WAITING_STAGE_STATUSES.has(stage.status),
    )
  )
    return "current";
  if (
    stages.every(
      (stage) => stage.status === "COMPLETED" || stage.status === "SKIPPED",
    )
  )
    return "complete";
  return "wait";
}

/**
 * Groups the frozen plan into the five milestones the run screen shows.
 *
 * Order is taken from the plan itself, so a milestone that this template does
 * not have is omitted instead of being drawn as an empty step:
 *
 *   - everything after the review branch is **Final** (final verification and
 *     the human acceptance gate);
 *   - the review stage and its fix/retest loop are **Review**;
 *   - verification stages before the review are **Verify**;
 *   - the leading planning stage(s) are **Plan**, the rest of the leading work
 *     is **Build**.
 */
export function buildRunMilestones(
  plan: StagePlan,
  stages: readonly StageRecord[],
  agents: readonly Pick<AgentRecord, "id" | "name">[] = [],
  currentStageKey: string | null = null,
): RunMilestoneView[] {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const byKey = new Map(stages.map((stage) => [stage.key, stage]));
  const ordered = [...plan.stages].sort((a, b) => a.orderIndex - b.orderIndex);

  const toStage = (key: string): MilestoneStageView => {
    const entry = ordered.find((candidate) => candidate.key === key);
    const stage = byKey.get(key);
    const name = stage?.name ?? entry?.name ?? key;
    const kind = stage?.kind ?? entry?.kind ?? "task";
    const role = stage?.role ?? entry?.role ?? "unknown";
    const status = stage?.status ?? "PENDING";
    const loop = stage?.loop ?? entry?.loop ?? null;
    const agentId = stage?.agentId ?? null;
    return {
      key,
      name,
      kind,
      role,
      status,
      statusWord: statusLabel(status),
      agentName: agentId
        ? (agentNames.get(agentId) ?? `unknown agent ${agentId}`)
        : null,
      attemptCount: stage?.attemptCount ?? 0,
      loopLabel: loop
        ? fixLoopCycleLabel(stage?.cycle ?? 0, loop.maxReviewCycles)
        : null,
      loopPhase: loop ? loop.phase : null,
      summary: stage?.summary ?? null,
      failureReason: stage?.failureReason ?? null,
      skippedReason: stage?.skipReason ?? null,
      overridden: stage?.overridden ?? false,
      isCurrent: currentStageKey !== null && key === currentStageKey,
    };
  };

  const reviewKeys = ordered
    .filter((entry) => entry.kind === "review" || entry.loop !== null)
    .map((entry) => entry.key);

  // The final verification is the last verification stage; the Final milestone
  // is that stage plus everything after it (the human acceptance gate). A plan
  // without any verification stage therefore has no Final step to draw.
  const verifyIndexes = ordered
    .filter((entry) => entry.kind === "verify")
    .map((entry) => entry.orderIndex);
  const finalStart =
    verifyIndexes.length > 0
      ? Math.max(...verifyIndexes)
      : Number.POSITIVE_INFINITY;

  const finalKeys = ordered
    .filter((entry) => entry.orderIndex >= finalStart)
    .map((entry) => entry.key);
  const beforeFinal = ordered.filter((entry) => entry.orderIndex < finalStart);
  // The review loop (fix, re-verification) belongs to the Review milestone even
  // though the re-verification stage is a verification stage: counting it in
  // both places made Verify read "Complete Skipped" beside a completed review.
  const verifyKeys = beforeFinal
    .filter((entry) => entry.kind === "verify" && entry.loop === null)
    .map((entry) => entry.key);
  const workEntries = beforeFinal.filter(
    (entry) => entry.kind !== "verify" && !reviewKeys.includes(entry.key),
  );
  const planKeys: string[] = [];
  const buildKeys: string[] = [];
  let planning = true;
  for (const entry of workEntries) {
    const isPlanning =
      PLANNING_ROLES.has(entry.role) ||
      PLANNING_PATTERN.test(`${entry.key} ${entry.name}`);
    if (planning && isPlanning) planKeys.push(entry.key);
    else {
      planning = false;
      buildKeys.push(entry.key);
    }
  }

  const byMilestone: Record<string, string[]> = {
    plan: planKeys,
    build: buildKeys,
    verify: verifyKeys,
    review: reviewKeys,
    final: finalKeys,
  };

  const out: RunMilestoneView[] = [];
  for (const definition of MILESTONE_DEFINITIONS) {
    const keys = byMilestone[definition.id] ?? [];
    if (keys.length === 0) continue;
    const memberStages = keys.map(toStage);
    const state = milestoneState(memberStages);
    // One honest state word per milestone: a skipped dormant loop stage must not
    // label a completed milestone as "Skipped".
    const current =
      memberStages.find((stage) => stage.isCurrent) ??
      memberStages.find(
        (stage) => stage.status !== "PENDING" && stage.status !== "SKIPPED",
      ) ??
      memberStages.find((stage) => WAITING_STAGE_STATUSES.has(stage.status)) ??
      memberStages[0] ??
      null;
    out.push({
      id: definition.id,
      name: definition.name,
      state,
      stateWord: MILESTONE_STATE_WORDS[state],
      icon: MILESTONE_ICONS[state],
      statusWord:
        current && current.status !== "PENDING" && current.status !== "SKIPPED"
          ? current.statusWord
          : null,
      tab: definition.tab,
      attemptCount: memberStages.reduce(
        (total, stage) => total + stage.attemptCount,
        0,
      ),
      stages: memberStages,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Main tabs                                                           */
/* ------------------------------------------------------------------ */

export type RunTabId =
  | "overview"
  | "changes"
  | "verification"
  | "review"
  | "activity";

export interface RunTabView {
  id: RunTabId;
  label: string;
  count?: number;
}

const RUN_TAB_LABELS: readonly { id: RunTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Verification" },
  { id: "review", label: "Review" },
  { id: "activity", label: "Activity" },
];

/**
 * The tabs that apply to this run, in a fixed order.
 *
 * A tab that has nothing behind it is not rendered at all (no "Changes" tab for
 * a project registered without git, no Review tab for a plan without a review
 * stage and without a recorded verdict).
 */
export function runTabs(input: {
  /** A working-tree diff or a recorded checkpoint exists. */
  hasChanges: boolean;
  /** The plan has a verification stage, or a verification/test was recorded. */
  hasVerification: boolean;
  /** The plan has a review stage, or a verdict was recorded. */
  hasReview: boolean;
  counts?: Partial<Record<RunTabId, number>>;
}): RunTabView[] {
  const applicable: Record<RunTabId, boolean> = {
    overview: true,
    changes: input.hasChanges,
    verification: input.hasVerification,
    review: input.hasReview,
    activity: true,
  };
  return RUN_TAB_LABELS.filter((tab) => applicable[tab.id]).map((tab) => {
    const count = input.counts?.[tab.id];
    return count === undefined ? { ...tab } : { ...tab, count };
  });
}

/** The evidence tab a stage click should open. */
export function evidenceTabForStage(kind: string): RunTabId {
  switch (kind) {
    case "verify":
      return "verification";
    case "review":
      return "review";
    case "final_approval":
      return "overview";
    default:
      return "overview";
  }
}

/** Display label for a tab id (used by buttons that navigate to a panel). */
export function runTabLabel(id: RunTabId): string {
  return RUN_TAB_LABELS.find((tab) => tab.id === id)?.label ?? id;
}

/* ------------------------------------------------------------------ */
/* Activity (concise lifecycle sentences) and raw-log severity         */
/* ------------------------------------------------------------------ */

export type EventSeverity = "attention" | "progress" | "detail";

export const EVENT_SEVERITY_FILTERS = [
  "everything",
  "attention",
  "output",
] as const;
export type EventSeverityFilter = (typeof EVENT_SEVERITY_FILTERS)[number];

export const EVENT_SEVERITY_FILTER_LABELS: Record<EventSeverityFilter, string> =
  {
    everything: "Everything",
    attention: "Needs attention",
    output: "Output only",
  };

/** Words that mark an event as something an operator has to look at. */
const ATTENTION_PATTERN =
  /fail|error|reject|interrupt|cancel|blocked|unavailable|exhaust|invalid|timeout|denied|crash|missing/i;

/** Categories that are background record-keeping rather than progress. */
const DETAIL_CATEGORIES = new Set([
  "system",
  "project",
  "snapshot",
  "artifact",
]);

/** Event types whose payload is verbatim agent output, not run progress. */
const OUTPUT_EVENT_PATTERN =
  /output|tool_call|stream|chunk|token|frame|delta|heartbeat|debug/i;

/**
 * Severity of one raw log line.
 *
 * The engine persists no severity field, so this is derived from the persisted
 * type/category/payload only: a failing event is "attention", agent output is
 * "detail", everything else is "progress". It exists for the raw log filters —
 * the Activity list uses lifecycle sentences instead.
 */
export function eventSeverity(
  event: Pick<EventRecord, "type" | "category" | "payload">,
): EventSeverity {
  const error = event.payload?.["error"];
  const haystack = `${event.type} ${event.category}${
    typeof error === "string" ? ` ${error}` : ""
  }`;
  if (ATTENTION_PATTERN.test(haystack)) return "attention";
  if (
    DETAIL_CATEGORIES.has(event.category) ||
    OUTPUT_EVENT_PATTERN.test(event.type)
  )
    return "detail";
  return "progress";
}

export function eventSeverityLabel(severity: EventSeverity): string {
  switch (severity) {
    case "attention":
      return "Needs attention";
    case "progress":
      return "Progress";
    default:
      return "Output";
  }
}

/**
 * Event types that describe the run's lifecycle.
 *
 * Everything else — agent output frames, tool calls, snapshot bookkeeping — is
 * raw log material: it belongs in the raw log stream, not in the Activity list.
 */
const ACTIVITY_EVENT_TYPES = new Set([
  "run.created",
  "run.plan_frozen",
  "run.started",
  "run.retried",
  "run.waiting_approval",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "stage.started",
  "stage.activated",
  "stage.attempt_started",
  "stage.completed",
  "stage.failed",
  "stage.interrupted",
  "stage.reopened",
  "attempt.created",
  "attempt.completed",
  "attempt.failed",
  "attempt.interrupted",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.waiting",
  "agent.stream_error",
  "review.verdict_valid",
  "review.verdict_invalid",
  "review.fixes_requested",
  "review.override_recorded",
  "approval.requested",
  "approval.decided",
  "verification.passed",
  "verification.failed",
  "input.requested",
  "input.supplied",
  "input.delivery_failed",
]);

export interface ActivityContext {
  stageNames?: ReadonlyMap<string, string>;
  attemptNumbers?: ReadonlyMap<string, number>;
  agentNames?: ReadonlyMap<string, string>;
  /** Agent name of each attempt, so an agent event can name its own agent. */
  attemptAgents?: ReadonlyMap<string, string>;
}

export interface ActivityEntry {
  id: number;
  at: string;
  /** `true` when the sentence reports something that went wrong. */
  attention: boolean;
  sentence: string;
}

function payloadText(
  event: Pick<EventRecord, "payload">,
  key: string,
): string | null {
  const value = event.payload?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function stageNameFor(event: EventRecord, context: ActivityContext): string {
  if (!event.stageKey) return "the stage";
  return context.stageNames?.get(event.stageKey) ?? "the stage";
}

function agentNameFor(
  event: EventRecord,
  context: ActivityContext,
): string | null {
  const agentId = event.payload?.["agentId"];
  if (typeof agentId === "string" && agentId)
    return context.agentNames?.get(agentId) ?? null;
  // Agent events carry no agent id; the attempt they belong to does.
  if (event.attemptId)
    return context.attemptAgents?.get(event.attemptId) ?? null;
  return null;
}

function attemptNumberFor(
  event: EventRecord,
  context: ActivityContext,
): number | null {
  const fromPayload = event.payload?.["attemptNumber"];
  if (typeof fromPayload === "number" && Number.isFinite(fromPayload))
    return fromPayload;
  if (!event.attemptId) return null;
  return context.attemptNumbers?.get(event.attemptId) ?? null;
}

/**
 * One operator sentence for a lifecycle event.
 *
 * Sentences are built from the persisted event type and payload plus the run's
 * own stage/agent naming — never from a database field name, and never by
 * dumping a protocol frame. Anything not recognised as lifecycle is dropped
 * from the Activity list (the raw log stream still holds every frame).
 */
export function activitySentence(
  event: EventRecord,
  context: ActivityContext = {},
): string | null {
  if (!activityEvent(event)) return null;
  const stage = stageNameFor(event, context);
  const agent = agentNameFor(event, context);
  const attempt = attemptNumberFor(event, context);
  const on = attempt === null ? "" : ` (attempt ${attempt})`;
  const reason =
    payloadText(event, "reason") ??
    payloadText(event, "failureReason") ??
    payloadText(event, "error") ??
    payloadText(event, "message");
  switch (event.type) {
    case "run.created":
      return "Run created";
    case "run.plan_frozen":
      return "Plan frozen";
    case "run.started":
      return "Run started";
    case "run.retried":
      return reason ? `Retried: ${reason}` : "Retried";
    case "run.waiting_approval":
    case "approval.requested":
      return "Waiting for your decision";
    case "run.waiting_input":
    case "input.requested":
      return "Input requested";
    case "input.supplied":
      return "You supplied input";
    case "input.delivery_failed":
      return reason
        ? `Input could not be delivered: ${reason}`
        : "Input could not be delivered";
    case "run.completed":
      return "Run completed";
    case "run.failed":
      return reason ? `Run failed: ${reason}` : "Run failed";
    case "run.cancelled":
      return reason ? `Run cancelled: ${reason}` : "Run cancelled";
    case "run.interrupted":
      return "Run interrupted";
    case "stage.started":
      return `${agent ? `${agent} started ` : "Started "}${stage}`;
    case "stage.activated":
      return `${stage} activated`;
    case "stage.reopened":
      return `${stage} reopened${reason ? `: ${reason}` : ""}`;
    case "stage.attempt_started":
      return `Attempt started on ${stage}${on}`;
    case "stage.completed":
      return `${agent ? `${agent} finished ` : "Finished "}${stage}`;
    case "stage.failed":
      return `${stage} failed${reason ? `: ${reason}` : ""}`;
    case "stage.interrupted":
      return `${stage} interrupted`;
    case "attempt.created":
      return `Attempt created on ${stage}${on}`;
    case "attempt.completed":
      return `Attempt completed on ${stage}${on}`;
    case "attempt.failed":
      return `Attempt failed on ${stage}${on}${reason ? `: ${reason}` : ""}`;
    case "attempt.interrupted":
      return `Attempt interrupted on ${stage}${on}`;
    case "agent.started":
      return `${agent ?? "Agent"} started ${stage}`;
    case "agent.completed":
      return `${agent ?? "Agent"} finished ${stage}`;
    case "agent.failed":
      return `${agent ?? "Agent"} failed on ${stage}${reason ? `: ${reason}` : ""}`;
    case "agent.cancelled":
      return `${agent ?? "Agent"} was cancelled`;
    case "agent.waiting":
      return `${agent ?? "Agent"} is waiting for your answer`;
    case "agent.stream_error":
      return `Output stream error from ${agent ?? "the agent"}`;
    case "review.verdict_valid": {
      const verdict = payloadText(event, "verdict");
      return `${agent ?? "The reviewer"} ${reviewActionWord(verdict)}`;
    }
    case "review.verdict_invalid":
      return `${agent ?? "The reviewer"} returned an unusable verdict`;
    case "review.fixes_requested":
      return "Fixes requested by the reviewer";
    case "review.override_recorded":
      return reason
        ? `You overrode the rejection: ${reason}`
        : "You overrode the rejection";
    case "approval.decided": {
      const decision = payloadText(event, "decision");
      return decision ? `You decided: ${decision}` : "You decided";
    }
    case "verification.passed":
      return `Verification passed — ${stage}`;
    case "verification.failed":
      return `Verification failed — ${stage}${reason ? `: ${reason}` : ""}`;
    default:
      return null;
  }
}

/** `true` when an event belongs in the Activity list at all. */
export function activityEvent(event: Pick<EventRecord, "type">): boolean {
  return ACTIVITY_EVENT_TYPES.has(event.type);
}

/** The verdict in the reviewer's own words: approved, rejected, … */
function reviewActionWord(verdict: string | null): string {
  if (!verdict) return "recorded a verdict";
  return verdictActionWord(verdict as ReviewVerdictKind, true);
}

/**
 * One action, one line.
 *
 * A single attempt start or finish is recorded by the engine as several events
 * (attempt.created + stage.attempt_started + agent.started, then
 * agent.completed + stage.completed + attempt.completed). Activity shows the
 * most informative one per stage and action, so an operator reads one sentence,
 * not three bookkeeping rows — the raw logs keep all of them.
 */
type ActivityAction = "start" | "finish" | "fail" | "interrupt" | "wait";

const ACTIVITY_ACTIONS: Record<
  string,
  { action: ActivityAction; rank: number }
> = {
  "agent.started": { action: "start", rank: 3 },
  "stage.started": { action: "start", rank: 2 },
  "stage.attempt_started": { action: "start", rank: 1 },
  "attempt.created": { action: "start", rank: 1 },
  "verification.passed": { action: "finish", rank: 4 },
  "verification.failed": { action: "finish", rank: 4 },
  "agent.completed": { action: "finish", rank: 3 },
  "stage.completed": { action: "finish", rank: 2 },
  "attempt.completed": { action: "finish", rank: 1 },
  "agent.failed": { action: "fail", rank: 3 },
  "attempt.failed": { action: "fail", rank: 2 },
  "stage.failed": { action: "fail", rank: 2 },
  "attempt.interrupted": { action: "interrupt", rank: 2 },
  "stage.interrupted": { action: "interrupt", rank: 2 },
  "run.waiting_approval": { action: "wait", rank: 2 },
  "approval.requested": { action: "wait", rank: 1 },
  "run.waiting_input": { action: "wait", rank: 2 },
  "input.requested": { action: "wait", rank: 1 },
};

/**
 * The Activity list: meaningful lifecycle sentences, newest last.
 *
 * Output frames, tool calls and bookkeeping never reach this list; neither do
 * the duplicate events that describe one action (see `ACTIVITY_ACTIONS`).
 */
export function activityEntries(
  events: readonly EventRecord[],
  context: ActivityContext = {},
  options: { attentionOnly?: boolean } = {},
): ActivityEntry[] {
  interface Candidate {
    id: number;
    at: string;
    attention: boolean;
    sentence: string;
    key: string | null;
    rank: number;
  }
  const candidates: Candidate[] = [];
  for (const event of events) {
    const sentence = activitySentence(event, context);
    if (!sentence) continue;
    const attention = eventSeverity(event) === "attention";
    if (options.attentionOnly && !attention) continue;
    const mapping = ACTIVITY_ACTIONS[event.type];
    candidates.push({
      id: event.id,
      at: event.createdAt,
      attention,
      sentence,
      key: mapping ? `${event.stageKey ?? ""}|${mapping.action}` : null,
      rank: mapping ? mapping.rank : 0,
    });
  }
  // One line per (stage, action): the most informative wording wins.
  const bestRank = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    bestRank.set(
      candidate.key,
      Math.max(bestRank.get(candidate.key) ?? -1, candidate.rank),
    );
  }
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.key) {
      if (seen.has(candidate.key)) continue;
      if (candidate.rank !== bestRank.get(candidate.key)) continue;
      seen.add(candidate.key);
    }
    out.push({
      id: candidate.id,
      at: candidate.at,
      attention: candidate.attention,
      sentence: candidate.sentence,
    });
  }
  return out;
}

/** The raw log stream for one run, as the run's own stages name it. */
export function rawLogEntries(
  events: readonly EventRecord[],
  context: ActivityContext = {},
): RawLogLineView[] {
  return events.map((event) => {
    const stream = payloadText(event, "stream");
    const agentId = event.payload?.["agentId"];
    return {
      id: event.id,
      at: event.createdAt,
      category: event.category,
      actor: event.actor,
      agentName:
        typeof agentId === "string"
          ? (context.agentNames?.get(agentId) ?? null)
          : null,
      stageName: event.stageKey
        ? (context.stageNames?.get(event.stageKey) ?? event.stageKey)
        : null,
      attemptNumber: event.attemptId
        ? (context.attemptNumbers?.get(event.attemptId) ?? null)
        : null,
      stream:
        stream === "stdout" || stream === "stderr" || stream === "system"
          ? stream
          : "run",
      severity: eventSeverity(event),
      type: event.type,
      text: eventMessage(event),
    };
  });
}

export interface RawLogLineView {
  id: number;
  at: string;
  category: EventRecord["category"];
  actor: EventRecord["actor"];
  agentName: string | null;
  stageName: string | null;
  attemptNumber: number | null;
  /** Where the bytes came from: a process stream, or the run itself. */
  stream: "stdout" | "stderr" | "system" | "run";
  severity: EventSeverity;
  type: string;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Changes (unified diff + file navigation)                            */
/* ------------------------------------------------------------------ */

export interface DiffFileSection {
  path: string;
  /** Display label; `All changes` when the diff carries no file header. */
  label: string;
  lines: DiffLine[];
  additions: number;
  removals: number;
}

/**
 * Splits a unified diff into per-file sections for file navigation.
 *
 * Every input line is preserved: `classifyDiff` runs on each section and the
 * header lines stay part of it, so nothing is dropped from what git printed.
 */
export function diffFiles(diff: string): DiffFileSection[] {
  if (!diff.trim()) return [];
  const sections: { path: string; raw: string[] }[] = [];
  let current: { path: string; raw: string[] } | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (header) {
      if (current) sections.push(current);
      current = { path: header[2] ?? header[1] ?? "", raw: [line] };
      continue;
    }
    if (!current) current = { path: "", raw: [] };
    current.raw.push(line);
  }
  if (current) sections.push(current);
  return sections
    .filter((section) => section.raw.length > 0)
    .map((section) => {
      const lines = classifyDiff(section.raw.join("\n"));
      return {
        path: section.path,
        label: section.path === "" ? "All changes" : section.path,
        lines,
        additions: lines.filter((line) => line.kind === "add").length,
        removals: lines.filter((line) => line.kind === "remove").length,
      };
    });
}

export interface ChangedFilesView {
  /** `null` when no diff stat was recorded — never 0. */
  count: number | null;
  label: string;
  detail: string | null;
}

/**
 * Changed-file count for the decision sheet and the Changes badge.
 *
 * The count is the union of the paths the checkpoint actually recorded (staged,
 * unstaged, untracked) — a stat line that cannot be parsed never becomes "0
 * files changed". When no paths were recorded either, the count stays unknown.
 */
export function changedFilesView(input: {
  diffStat?: string | null;
  snapshot?: GitSnapshotRecord | null;
}): ChangedFilesView {
  const snapshot = input.snapshot ?? null;
  const paths = new Set<string>([
    ...(snapshot?.stagedPaths ?? []),
    ...(snapshot?.unstagedPaths ?? []),
    ...(snapshot?.untrackedPaths ?? []),
  ]);
  const stat = parseDiffStats(input.diffStat ?? snapshot?.diffStat ?? null);
  const fromStat =
    stat === null
      ? null
      : (stat.filesChanged ??
        (stat.files.length > 0 ? stat.files.length : null));
  const count = paths.size > 0 ? paths.size : fromStat;
  if (count === null)
    return { count: null, label: "Changed files UNKNOWN", detail: null };
  const insertions = stat?.insertions ?? null;
  const deletions = stat?.deletions ?? null;
  const parts: string[] = [];
  if (insertions !== null) parts.push(`+${formatCount(insertions)}`);
  if (deletions !== null) parts.push(`−${formatCount(deletions)}`);
  return {
    count,
    label: `${formatCount(count)} file${count === 1 ? "" : "s"} changed`,
    detail: parts.length > 0 ? parts.join(" / ") : null,
  };
}

/* ------------------------------------------------------------------ */
/* Verification history                                                */
/* ------------------------------------------------------------------ */

/** How many normalized test rows a single verification shows before folding. */
export const VERIFICATION_TEST_LIMIT = 7;

export interface VerificationTestRow {
  id: string;
  framework: string;
  status: string;
  countsLabel: string;
  durationMs: number | null;
  createdAt: string;
  summary: string | null;
}

export interface VerificationCommandRow {
  id: string;
  command: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  cwd: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  truncated: boolean;
}

export interface VerificationEntryView {
  attemptId: string;
  attemptNumber: number;
  stageKey: string;
  stageName: string;
  /** Recorded verification status, or UNKNOWN when none was recorded. */
  status: string;
  headline: string;
  shortLabel: string;
  counts: AttemptCountsView["counts"];
  countsSource: AttemptCountsView["source"];
  framework: string | null;
  countsLabel: string;
  summary: string | null;
  reason: string | null;
  tests: VerificationTestRow[];
  /** Normalized rows that exist beyond the shown ones. */
  testsHidden: number;
  commands: VerificationCommandRow[];
  latest: boolean;
  recordedAt: string | null;
}

function testRow(test: TestRunRecord): VerificationTestRow {
  return {
    id: test.id,
    framework: test.framework,
    status: test.status,
    countsLabel: verificationCountsLabel(
      test.total === null
        ? null
        : {
            passed: test.passed ?? 0,
            failed: test.failed ?? 0,
            total: test.total,
          },
    ),
    durationMs: test.durationMs,
    createdAt: test.createdAt,
    summary: test.summary,
  };
}

/**
 * Every verification the run recorded, newest first.
 *
 * One entry per attempt: the persisted verification outcome when the attempt
 * has one, otherwise the attempt's own commands and normalized test rows. A
 * "latest verification" is therefore one attempt, never a sum of two records —
 * that is what stops final verification from being double counted.
 */
export function verificationHistory(input: {
  attempts: readonly AttemptRecord[];
  tests: readonly TestRunRecord[];
  commands: readonly ShellCommandRecord[];
  stages?: readonly StageRecord[];
}): VerificationEntryView[] {
  const stageNames = new Map(
    (input.stages ?? []).map((stage) => [stage.key, stage.name]),
  );
  const entries = input.attempts.map((attempt) => {
    const tests = input.tests
      .filter((test) => test.attemptId === attempt.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const commands = input.commands
      .filter((command) => command.attemptId === attempt.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const displayed = tests.slice(0, VERIFICATION_TEST_LIMIT).map(testRow);
    const counts = attemptCountsView({
      attemptId: attempt.id,
      verification: attempt.verification,
      tests,
    });
    const verification = attempt.verification;
    return {
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      stageKey: attempt.stageKey,
      stageName: stageNames.get(attempt.stageKey) ?? attempt.stageKey,
      status: verification?.status ?? UNKNOWN,
      headline: verification
        ? verificationLabel({ ...verification, counts: counts.counts })
        : counts.counts
          ? `Verification ${UNKNOWN} · ${counts.counts.passed}/${counts.counts.total} passed`
          : `Verification ${UNKNOWN}`,
      shortLabel: verificationShortLabel({
        status: verification?.status ?? "unknown",
        counts: counts.counts,
      }),
      counts: counts.counts,
      countsSource: counts.source,
      framework: counts.framework,
      countsLabel: verificationCountsLabel(counts.counts),
      summary: verification?.summary ?? null,
      reason: verification?.reason ?? null,
      tests: displayed,
      testsHidden: Math.max(0, tests.length - displayed.length),
      commands: commands.map((command) => ({
        id: command.id,
        command: commandLine(command),
        status: command.status,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
        createdAt: command.createdAt,
        cwd: command.cwd,
        stdoutExcerpt: command.stdoutExcerpt,
        stderrExcerpt: command.stderrExcerpt,
        truncated: command.truncated,
      })),
      latest: false,
      recordedAt: tests[0]?.createdAt ?? attempt.endedAt ?? attempt.createdAt,
    } satisfies VerificationEntryView;
  });

  const relevant = entries.filter(
    (entry) =>
      entry.status !== UNKNOWN ||
      entry.commands.length > 0 ||
      entry.tests.length > 0,
  );
  relevant.sort((a, b) => {
    const left = a.recordedAt ?? "";
    const right = b.recordedAt ?? "";
    if (left === right) return b.attemptNumber - a.attemptNumber;
    return right.localeCompare(left);
  });
  return relevant.map((entry, index) => ({ ...entry, latest: index === 0 }));
}

/** `true` when a verification entry carries a command failure or a failed run. */
export function verificationFailed(entry: VerificationEntryView): boolean {
  if (entry.status === "failed") return true;
  return entry.commands.some((command) => command.status === "failed");
}

/**
 * The newest normalized test rows for one attempt.
 *
 * Used by the decision sheet, which shows the latest tests of the single
 * attempt its verification came from — never the sum of two attempts, and never
 * more rows than the operator can read in front of the decision.
 */
export function latestTestsForAttempt(
  tests: readonly TestRunRecord[],
  attemptId: string | null,
  limit = VERIFICATION_TEST_LIMIT,
): { rows: VerificationTestRow[]; hidden: number } {
  if (attemptId === null) return { rows: [], hidden: 0 };
  const own = tests
    .filter((test) => test.attemptId === attemptId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = own.slice(0, limit).map(testRow);
  return { rows, hidden: Math.max(0, own.length - rows.length) };
}

/* ------------------------------------------------------------------ */
/* Review history                                                      */
/* ------------------------------------------------------------------ */

export interface ReviewIssueView {
  severity: ReviewSeverity | string;
  disposition: IssueDisposition;
  dispositionLabel: string;
  description: string;
  location: string | null;
}

export interface ReviewEntryView {
  id: string;
  stageKey: string;
  stageName: string;
  cycle: number;
  label: string;
  kind: ReviewVerdictKind | null;
  tone: Tone;
  valid: boolean;
  reviewer: string;
  reviewerSource: ReviewerIdentity["source"];
  reviewerProvenance: string;
  summary: string | null;
  issues: ReviewIssueView[];
  tallyLabel: string;
  blockers: number;
  suggestions: number;
  validationErrors: string[];
  raw: string;
  createdAt: string;
}

/**
 * Recorded review verdicts, newest first.
 *
 * Each entry keeps every finding with its persisted severity word and location,
 * the reviewer resolved through the durable verdict → attempt → agent link, and
 * the raw payload, so nothing a reviewer wrote is dropped.
 */
export function reviewHistory(input: {
  verdicts: readonly ReviewVerdictRecord[];
  attempts: readonly Pick<AttemptRecord, "id" | "agentId">[];
  agents: readonly Pick<AgentRecord, "id" | "name">[];
  stages?: readonly StageRecord[];
}): ReviewEntryView[] {
  const stageNames = new Map(
    (input.stages ?? []).map((stage) => [stage.key, stage.name]),
  );
  return [...input.verdicts]
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return b.cycle - a.cycle;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((verdict) => {
      const identity = reviewerIdentity({
        reviewer: verdict.reviewer,
        attemptId: verdict.attemptId,
        attempts: input.attempts,
        agents: input.agents,
      });
      const tally = issueTally(verdict.issues);
      return {
        id: verdict.id,
        stageKey: verdict.stageKey,
        stageName: stageNames.get(verdict.stageKey) ?? verdict.stageKey,
        cycle: verdict.cycle,
        label: verdictOutcomeLabel(verdict.verdict, verdict.valid),
        kind: verdict.verdict,
        tone: verdictTone(verdict.verdict),
        valid: verdict.valid,
        reviewer: identity.name,
        reviewerSource: identity.source,
        reviewerProvenance: reviewerProvenanceLabel(identity),
        summary: verdict.summary,
        issues: verdict.issues.map((issue) => {
          const disposition = issueDisposition(issue.severity);
          return {
            severity: issue.severity,
            disposition,
            dispositionLabel: issueDispositionLabel(disposition),
            description: issue.description,
            location: issue.path
              ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
              : null,
          };
        }),
        tallyLabel: tally.label,
        blockers: tally.blockers,
        suggestions: tally.suggestions,
        validationErrors: [...verdict.validationErrors],
        raw: verdict.raw,
        createdAt: verdict.createdAt,
      } satisfies ReviewEntryView;
    });
}

/* ------------------------------------------------------------------ */
/* Decision sheet facts                                                */
/* ------------------------------------------------------------------ */

export interface DecisionFact {
  label: string;
  tone: Tone;
  detail: string | null;
}

/**
 * Blocker summary, valid-review-aware.
 *
 * A verdict payload that failed validation blocks nothing that was reviewed —
 * it is reported as unvalidated rather than as "no blockers".
 */
export function blockerFact(evidence: ApprovalEvidence): DecisionFact {
  const verdict = evidence.verdict;
  if (!verdict)
    return {
      label: "No review verdict recorded",
      tone: "warn",
      detail: "The gate comes from the run plan, not from a reviewer payload.",
    };
  if (!verdict.valid)
    return {
      label: "Reviewer payload failed validation",
      tone: "danger",
      detail:
        "No structured verdict was accepted, so no blockers were established. Every decision below would be recorded against an unvalidated payload.",
    };
  if (verdict.tally.blockers > 0)
    return {
      label: `${verdict.tally.blockers} blocker${
        verdict.tally.blockers === 1 ? "" : "s"
      }`,
      tone: "danger",
      detail: `Recorded by the reviewer${
        verdict.tally.suggestions > 0
          ? `, with ${verdict.tally.suggestions} further suggestion${
              verdict.tally.suggestions === 1 ? "" : "s"
            }`
          : ""
      }.`,
    };
  return {
    label: `0 blockers · ${verdict.tally.suggestions} suggestion${
      verdict.tally.suggestions === 1 ? "" : "s"
    }`,
    tone: verdict.tally.suggestions > 0 ? "neutral" : "success",
    detail:
      verdict.tally.suggestions > 0
        ? "None of the reviewer's findings are blocking."
        : "The reviewer recorded no findings.",
  };
}

/**
 * Checks summary for the decision sheet.
 *
 * Passing tests never make this read "All checks passed": the recorded
 * verification outcome is inspected too, and a command whose counts could not
 * be parsed stays explicitly unavailable.
 */
export function checksFact(evidence: ApprovalEvidence): DecisionFact {
  const verification = evidence.verification;
  if (!verification)
    return {
      label: "No verification outcome recorded",
      tone: "warn",
      detail: null,
    };
  if (verification.status === "failed")
    return {
      label: `Verification failed · ${verification.shortLabel}`,
      tone: "danger",
      detail: `Stage ${verification.stageKey} · attempt #${verification.attemptNumber}`,
    };
  if (verification.status === "unavailable")
    return {
      label: "Verification unavailable",
      tone: "warn",
      detail: "The command could not be run; this is not a pass.",
    };
  if (!verification.onGateStage)
    return {
      label: `Latest verification: ${verification.shortLabel}`,
      tone: "info",
      detail: `Recorded on stage ${verification.stageKey} · attempt #${verification.attemptNumber}, not on this gate's stage.`,
    };
  return {
    label: verification.shortLabel,
    tone: "success",
    detail: `Command passed${verification.framework ? ` · ${verification.framework}` : ""} · attempt #${verification.attemptNumber}`,
  };
}

/**
 * The facts the decision sheet shows before any button.
 *
 * Compact and summary-level: how many files changed, what the checks said, and
 * what the reviewer found. Each fact's provenance lives under Technical details,
 * so the sheet stays about the decision.
 */
export function decisionFacts(input: {
  evidence: ApprovalEvidence;
  snapshots: readonly GitSnapshotRecord[];
}): DecisionFact[] {
  const sorted = [...input.snapshots].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt),
  );
  const newest = sorted[sorted.length - 1] ?? null;
  const changed = changedFilesView({ snapshot: newest });
  return [
    {
      label: changed.label,
      tone: changed.count === null ? "muted" : "neutral",
      detail: changed.detail,
    },
    checksFact(input.evidence),
    blockerFact(input.evidence),
  ];
}

/**
 * The decision sheet's one summary line: who reviewed and what they decided.
 *
 * The verification count is not repeated here — it is one of the facts below.
 */
export function decisionLead(evidence: ApprovalEvidence): string {
  const verdict = evidence.verdict;
  if (!verdict) return "No review verdict recorded for this gate";
  if (verdict.reviewerSource === "none")
    return `Verdict recorded (reviewer not recorded)`;
  return `${verdict.reviewer} ${verdictActionWord(verdict.kind, verdict.valid)}`;
}

/** Count text for a `null`-able count without ever rendering a fake zero. */
export function attemptCountLabel(count: number): string {
  return `${formatCount(count)} attempt${count === 1 ? "" : "s"}`;
}

/** One quiet line for a stage's timing, `UNKNOWN` when it never ran. */
export function stageTimingLabel(stage: {
  startedAt: string | null;
  endedAt: string | null;
}): string {
  if (!stage.startedAt) return "not started";
  if (!stage.endedAt) return `started ${formatTimestamp(stage.startedAt)}`;
  return `${formatTimestamp(stage.startedAt)} → ${formatTimestamp(stage.endedAt)} · ${formatDuration(
    new Date(stage.endedAt).getTime() - new Date(stage.startedAt).getTime(),
  )}`;
}

/** Quiet one-line preview of an event for the Overview/Activity lists. */
export function eventLine(event: EventRecord): string {
  return text(eventMessage(event), event.type);
}
