/**
 * Pure view-model helpers for the AgentOps UI.
 *
 * This module contains no React, no DOM and no network access on purpose: every
 * function here is deterministic and unit-testable under `node --test`. The
 * React components are thin renderers over these helpers, so the interesting
 * decisions (status grouping, rail layout, form validation, search parameters)
 * are all verifiable without a browser.
 *
 * Rules that matter for correctness:
 *  - `null` never renders as a number. Unknown usage/size/duration is shown as
 *    UNKNOWN, mirroring the domain rule in `src/core/types.ts`.
 *  - Nothing here invents data. A missing agent name, verdict or count renders
 *    as an explicit absence, never a plausible default.
 */
import {
  BLOCKED_RUN_STATUSES,
  LEASED_RUN_STATUSES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  REVIEW_VERDICTS,
  APPROVAL_DECISIONS,
  EVENT_CATEGORIES,
} from "../core/types.js";
import type { RunListRecord } from "./ui-types.js";
import type {
  AgentRecord,
  ApprovalDecision,
  ApprovalRecord,
  ArtifactRecord,
  AttemptRecord,
  CommandSpec,
  EventActor,
  EventCategory,
  EventRecord,
  GitSnapshotRecord,
  ProjectRecord,
  ReviewVerdictRecord,
  ReviewVerdictKind,
  RunRecord,
  StagePlan,
  StagePlanEntry,
  StageRecord,
  TaskRecord,
  TestRunRecord,
  Usage,
  VerificationOutcomeRecord,
} from "../core/types.js";

/* ------------------------------------------------------------------ */
/* Small text utilities                                                */
/* ------------------------------------------------------------------ */

export const UNKNOWN = "UNKNOWN";

/** Renders a nullable text field without inventing a value. */
export function text(
  value: string | null | undefined,
  fallback = UNKNOWN,
): string {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : value;
}

export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}

/* ------------------------------------------------------------------ */
/* Numbers, sizes, durations, timestamps                               */
/* ------------------------------------------------------------------ */

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return UNKNOWN;
  return value.toLocaleString("en-US");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return UNKNOWN;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return UNKNOWN;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Local, compact, stable timestamp. Invalid input renders honestly. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return `unparsed: ${iso}`;
  const month = MONTHS[date.getMonth()] ?? "???";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
  return `${month} ${date.getDate()} ${date.getFullYear()} ${time}`;
}

/** Minutes-resolution clock for dense log rows. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
}

export function relativeTime(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!iso) return UNKNOWN;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unparsed";
  const deltaSeconds = Math.round((nowMs - then) / 1000);
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(iso);
}

export function shortenSha(sha: string | null | undefined): string {
  if (!sha) return UNKNOWN;
  return sha.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Status presentation                                                 */
/* ------------------------------------------------------------------ */

export type Tone =
  | "neutral"
  | "active"
  | "success"
  | "warn"
  | "danger"
  | "info"
  | "muted";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  RUNNING: "Running",
  WAITING_APPROVAL: "Waiting for you",
  WAITING_INPUT: "Waiting for input",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  PENDING: "Pending",
  SKIPPED: "Skipped",
  planned: "Planned",
  passed: "Passed",
  failed: "Failed",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return UNKNOWN;
  return STATUS_LABELS[status] ?? status;
}

/**
 * Status as an icon plus a word (design system): the glyph carries the tone,
 * the word carries the meaning, and the raw persisted enum stays available as
 * a `title` on the rendered element. No uppercase monospace state labels.
 */
export function statusIcon(status: string | null | undefined): string {
  switch (status) {
    case "COMPLETED":
    case "completed":
    case "passed":
      return "✓";
    case "RUNNING":
    case "running":
      return "●";
    case "WAITING_APPROVAL":
    case "WAITING_INPUT":
    case "waiting_input":
    case "unknown":
      return "!";
    case "FAILED":
    case "failed":
    case "INTERRUPTED":
    case "CANCELLED":
    case "unavailable":
      return "!";
    case "PENDING":
    case "planned":
    case "SKIPPED":
      return "○";
    default:
      return "○";
  }
}

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "RUNNING":
    case "running":
      return "active";
    case "COMPLETED":
    case "completed":
    case "passed":
      return "success";
    case "WAITING_APPROVAL":
    case "WAITING_INPUT":
    case "waiting_input":
    case "unavailable":
    case "SKIPPED":
    case "skipped":
      return "warn";
    case "FAILED":
    case "failed":
    case "INTERRUPTED":
    case "CANCELLED":
      return "danger";
    case "DRAFT":
    case "PENDING":
    case "planned":
      return "neutral";
    default:
      return "muted";
  }
}

export function isBlockedRun(status: string | null | undefined): boolean {
  return BLOCKED_RUN_STATUSES.includes(
    status as (typeof BLOCKED_RUN_STATUSES)[number],
  );
}

export function isActiveRun(status: string | null | undefined): boolean {
  return LEASED_RUN_STATUSES.includes(
    status as (typeof LEASED_RUN_STATUSES)[number],
  );
}

export function isTerminalRun(status: string | null | undefined): boolean {
  return TERMINAL_RUN_STATUSES.includes(
    status as (typeof TERMINAL_RUN_STATUSES)[number],
  );
}

/** `true` when the run needs a human click before anything else can happen. */
export function needsHuman(status: string | null | undefined): boolean {
  return isBlockedRun(status);
}

export const ALL_RUN_STATUSES = RUN_STATUSES;
export const ALL_REVIEW_VERDICTS = REVIEW_VERDICTS;
export const ALL_APPROVAL_DECISIONS = APPROVAL_DECISIONS;
export const ALL_EVENT_CATEGORIES = EVENT_CATEGORIES;

/** Categories that belong in the streaming log drawer, in display order. */
export const LOG_CATEGORIES: readonly EventCategory[] = [
  "agent",
  "attempt",
  "stage",
  "task",
  "verification",
  "review",
  "approval",
  "input",
  "artifact",
  "snapshot",
  "run",
  "project",
  "system",
];

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * Log line for an event.
 *
 * The engine owns the payload shape; the UI only reads the conventional keys it
 * may carry (`message`, `text`, `summary`) and otherwise renders the payload as
 * compact JSON rather than dropping or paraphrasing it.
 */
export function eventMessage(
  event: Pick<EventRecord, "payload" | "type">,
): string {
  const payload = event.payload ?? {};
  for (const key of ["message", "text", "summary", "detail"] as const) {
    const candidate = payload[key];
    if (typeof candidate === "string" && candidate.trim().length > 0)
      return candidate;
  }
  if (
    typeof payload["error"] === "string" &&
    payload["error"].trim().length > 0
  )
    return payload["error"];
  const keys = Object.keys(payload);
  if (keys.length === 0) return event.type;
  try {
    return `${event.type} ${JSON.stringify(payload)}`;
  } catch {
    return event.type;
  }
}

export interface EventFilter {
  categories?: readonly EventCategory[];
  actors?: readonly EventActor[];
  attempts?: readonly string[];
  text?: string;
}

export function filterEvents(
  events: readonly EventRecord[],
  filter: EventFilter,
): EventRecord[] {
  const categories =
    filter.categories && filter.categories.length > 0
      ? new Set(filter.categories)
      : null;
  const actors =
    filter.actors && filter.actors.length > 0 ? new Set(filter.actors) : null;
  const attempts =
    filter.attempts && filter.attempts.length > 0
      ? new Set(filter.attempts)
      : null;
  const needle = filter.text?.trim().toLowerCase() ?? "";
  return events.filter((event) => {
    if (categories && !categories.has(event.category)) return false;
    if (actors && !actors.has(event.actor)) return false;
    if (attempts && (!event.attemptId || !attempts.has(event.attemptId)))
      return false;
    if (needle) {
      const haystack =
        `${event.type} ${event.actor} ${event.category} ${event.stageKey ?? ""} ${eventMessage(event)}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function categoryCounts(
  events: readonly EventRecord[],
): { category: EventCategory; count: number }[] {
  const counts = new Map<EventCategory, number>();
  for (const event of events)
    counts.set(event.category, (counts.get(event.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Highest persisted event id, used as the SSE `afterId` cursor. */
export function lastEventId(events: readonly EventRecord[]): number {
  let max = 0;
  for (const event of events)
    if (Number.isFinite(event.id) && event.id > max) max = event.id;
  return max;
}

/**
 * Events belonging to one run. Server-level events (`runId: null`) are kept
 * because they are not run-scoped state; events of other runs are dropped so a
 * stream buffer can never leak across runs.
 */
export function eventsForRun(
  events: readonly EventRecord[],
  runId: string,
): EventRecord[] {
  return events.filter(
    (event) => event.runId === runId || event.runId === null,
  );
}

/** Appends replayed/subscribed events without duplicating ids. */
export function mergeEvents(
  existing: readonly EventRecord[],
  incoming: readonly EventRecord[],
  cap = 2000,
): EventRecord[] {
  const byId = new Map<number, EventRecord>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Roles a human must map to an agent: task and review stages only. */
export function planRoleOptions(
  plan: StagePlan,
): { role: string; stageKeys: string[]; kinds: string[] }[] {
  const map = new Map<
    string,
    { role: string; stageKeys: string[]; kinds: string[] }
  >();
  for (const stage of plan.stages) {
    if (stage.kind !== "task" && stage.kind !== "review") continue;
    const entry = map.get(stage.role) ?? {
      role: stage.role,
      stageKeys: [],
      kinds: [],
    };
    entry.stageKeys.push(stage.key);
    if (!entry.kinds.includes(stage.kind)) entry.kinds.push(stage.kind);
    map.set(stage.role, entry);
  }
  return [...map.values()].sort((a, b) => a.role.localeCompare(b.role));
}

export interface PlanRow {
  key: string;
  name: string;
  kind: StagePlanEntry["kind"];
  role: string;
  orderIndex: number;
  dependsOn: string[];
  branching: boolean;
  instructions: string;
}

export function planRows(plan: StagePlan): PlanRow[] {
  return [...plan.stages]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((stage) => ({
      key: stage.key,
      name: stage.name,
      kind: stage.kind,
      role: stage.role,
      orderIndex: stage.orderIndex,
      dependsOn: [...stage.dependsOn],
      branching: stage.loop !== null,
      instructions: stage.instructions,
    }));
}

/* ------------------------------------------------------------------ */
/* Line diffing (prompt revisions and repository diffs)                 */
/* ------------------------------------------------------------------ */

export interface DiffLine {
  kind: "same" | "add" | "remove" | "hunk" | "meta" | "context";
  text: string;
  leftLine: number | null;
  rightLine: number | null;
}

/**
 * Deterministic line diff (longest common subsequence, bounded).
 *
 * Used for "compare with previous prompt" and for repository diffs. Inputs with
 * more than `MAX_DIFF_LINES` lines fall back to a coarse common-prefix/suffix
 * diff so the UI stays responsive; the fallback still reports only real
 * additions and removals.
 */
export const MAX_DIFF_LINES = 1500;
export const MAX_DIFF_CELLS = 250_000;

export function diffLines(previous: string, current: string): DiffLine[] {
  const left = previous.length === 0 ? [] : previous.split("\n");
  const right = current.length === 0 ? [] : current.split("\n");
  if (
    left.length + right.length > MAX_DIFF_LINES ||
    left.length * right.length > MAX_DIFF_CELLS
  ) {
    return coarseDiff(left, right);
  }
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table: Uint32Array = new Uint32Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        left[i] === right[j]
          ? (table[(i + 1) * cols + (j + 1)] ?? 0) + 1
          : Math.max(
              table[(i + 1) * cols + j] ?? 0,
              table[i * cols + (j + 1)] ?? 0,
            );
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({
        kind: "same",
        text: left[i] ?? "",
        leftLine: i + 1,
        rightLine: j + 1,
      });
      i += 1;
      j += 1;
      continue;
    }
    const skipLeft = table[(i + 1) * cols + j] ?? 0;
    const skipRight = table[i * cols + (j + 1)] ?? 0;
    if (skipLeft >= skipRight) {
      out.push({
        kind: "remove",
        text: left[i] ?? "",
        leftLine: i + 1,
        rightLine: null,
      });
      i += 1;
    } else {
      out.push({
        kind: "add",
        text: right[j] ?? "",
        leftLine: null,
        rightLine: j + 1,
      });
      j += 1;
    }
  }
  while (i < left.length) {
    out.push({
      kind: "remove",
      text: left[i] ?? "",
      leftLine: i + 1,
      rightLine: null,
    });
    i += 1;
  }
  while (j < right.length) {
    out.push({
      kind: "add",
      text: right[j] ?? "",
      leftLine: null,
      rightLine: j + 1,
    });
    j += 1;
  }
  return out;
}

function coarseDiff(
  left: readonly string[],
  right: readonly string[],
): DiffLine[] {
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const out: DiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    out.push({
      kind: "same",
      text: left[index] ?? "",
      leftLine: index + 1,
      rightLine: index + 1,
    });
  }
  for (let index = prefix; index < left.length - suffix; index += 1) {
    out.push({
      kind: "remove",
      text: left[index] ?? "",
      leftLine: index + 1,
      rightLine: null,
    });
  }
  for (let index = prefix; index < right.length - suffix; index += 1) {
    out.push({
      kind: "add",
      text: right[index] ?? "",
      leftLine: null,
      rightLine: index + 1,
    });
  }
  for (let index = right.length - suffix; index < right.length; index += 1) {
    const leftIndex = left.length - (right.length - index);
    out.push({
      kind: "same",
      text: right[index] ?? "",
      leftLine: leftIndex + 1,
      rightLine: index + 1,
    });
  }
  return out;
}

export interface PromptComparison {
  attemptId: string;
  previousAttemptId: string | null;
  attemptNumber: number;
  previousAttemptNumber: number | null;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  previousPrompt: string | null;
  currentPrompt: string | null;
}

export interface AttemptLike {
  id: string;
  taskId: string;
  stageKey: string;
  attemptNumber: number;
  previousAttemptId: string | null;
  promptText: string | null;
}

/**
 * Pairs every attempt that has a predecessor with the previous attempt of the
 * *same task*, so the UI can show the exact prompt revision rather than a diff
 * of unrelated stages.
 */
export function promptComparisons(
  attempts: readonly AttemptLike[],
): PromptComparison[] {
  const byTask = new Map<string, AttemptLike[]>();
  for (const attempt of attempts) {
    const list = byTask.get(attempt.taskId);
    if (list) list.push(attempt);
    else byTask.set(attempt.taskId, [attempt]);
  }
  const out: PromptComparison[] = [];
  for (const list of byTask.values()) {
    const ordered = [...list].sort((a, b) => a.attemptNumber - b.attemptNumber);
    ordered.forEach((attempt, index) => {
      if (index === 0 && !attempt.previousAttemptId) return;
      const previous =
        ordered.find(
          (candidate) => candidate.id === attempt.previousAttemptId,
        ) ?? (index > 0 ? ordered[index - 1] : undefined);
      const previousPrompt = previous?.promptText ?? null;
      const currentPrompt = attempt.promptText;
      const diff =
        previousPrompt !== null && currentPrompt !== null
          ? diffLines(previousPrompt, currentPrompt)
          : [];
      out.push({
        attemptId: attempt.id,
        previousAttemptId: previous?.id ?? null,
        attemptNumber: attempt.attemptNumber,
        previousAttemptNumber: previous?.attemptNumber ?? null,
        changed: previousPrompt !== currentPrompt,
        addedLines: diff.filter((line) => line.kind === "add").length,
        removedLines: diff.filter((line) => line.kind === "remove").length,
        previousPrompt,
        currentPrompt,
      });
    });
  }
  return out;
}

/** Classifies a unified repository diff for display. Input is never rewritten. */
export function classifyDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const out: DiffLine[] = [];
  let leftLine = 0;
  let rightLine = 0;
  for (const line of lines) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      out.push({ kind: "meta", text: line, leftLine: null, rightLine: null });
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      leftLine = match ? Number(match[1]) : 0;
      rightLine = match && match[2] ? Number(match[2]) : 0;
      out.push({ kind: "hunk", text: line, leftLine: null, rightLine: null });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({
        kind: "add",
        text: line.slice(1),
        leftLine: null,
        rightLine: rightLine || null,
      });
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      out.push({
        kind: "remove",
        text: line.slice(1),
        leftLine: leftLine || null,
        rightLine: null,
      });
      leftLine += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      out.push({ kind: "meta", text: line, leftLine: null, rightLine: null });
      continue;
    }
    out.push({
      kind: "context",
      text: line.replace(/^ /, ""),
      leftLine: leftLine || null,
      rightLine: rightLine || null,
    });
    leftLine += 1;
    rightLine += 1;
  }
  return out;
}

export interface DiffStatsFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface DiffStats {
  files: DiffStatsFile[];
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

/** Parses `git diff --stat` output. Null input is UNKNOWN, never "0 changed". */
export function parseDiffStats(
  diffStat: string | null | undefined,
): DiffStats | null {
  if (!diffStat || !diffStat.trim()) return null;
  const files: DiffStatsFile[] = [];
  let filesChanged: number | null = null;
  let insertions: number | null = null;
  let deletions: number | null = null;
  for (const raw of diffStat.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const summary =
      /^\s*(\d+)\s+files? changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/.exec(
        line,
      );
    if (summary) {
      filesChanged = Number(summary[1]);
      insertions = summary[2] === undefined ? 0 : Number(summary[2]);
      deletions = summary[3] === undefined ? 0 : Number(summary[3]);
      continue;
    }
    const binary = /^\s*(.+?)\s*\|\s*Bin\b/.exec(line);
    if (binary) {
      files.push({
        path: (binary[1] ?? "").trim(),
        insertions: 0,
        deletions: 0,
      });
      continue;
    }
    const file = /^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)(?:\s*)$/.exec(line);
    if (file) {
      const bar = file[3] ?? "";
      files.push({
        path: (file[1] ?? "").trim(),
        insertions: (bar.match(/\+/g) ?? []).length,
        deletions: (bar.match(/-/g) ?? []).length,
      });
    }
  }
  return { files, filesChanged, insertions, deletions };
}

/* ------------------------------------------------------------------ */
/* Git snapshots                                                       */
/* ------------------------------------------------------------------ */

export interface SnapshotView {
  head: string;
  branch: string;
  dirtyLabel: string;
  staged: number;
  unstaged: number;
  untracked: number;
  changedPaths: string[];
  commits: { sha: string; subject: string }[];
  ahead: string;
  behind: string;
  diffStats: DiffStats | null;
  unavailableReason: string | null;
}

export function snapshotView(snapshot: GitSnapshotRecord): SnapshotView {
  return {
    head: shortenSha(snapshot.headSha),
    branch: snapshot.detached ? "detached HEAD" : text(snapshot.branch),
    dirtyLabel: snapshot.dirty ? "dirty" : "clean",
    staged: snapshot.stagedPaths.length,
    unstaged: snapshot.unstagedPaths.length,
    untracked: snapshot.untrackedPaths.length,
    changedPaths: [
      ...snapshot.stagedPaths,
      ...snapshot.unstagedPaths,
      ...snapshot.untrackedPaths,
    ],
    commits: snapshot.localCommits,
    ahead: snapshot.ahead === null ? UNKNOWN : String(snapshot.ahead),
    behind: snapshot.behind === null ? UNKNOWN : String(snapshot.behind),
    diffStats: parseDiffStats(snapshot.diffStat),
    unavailableReason: snapshot.unavailableReason,
  };
}

/* ------------------------------------------------------------------ */
/* Tests, commands, artifacts, usage                                   */
/* ------------------------------------------------------------------ */

/**
 * Shown whenever a command outcome or test record exists but no counts were
 * parsed confidently. A passed command with unparsed counts is still a passed
 * command; the count itself stays explicitly unavailable rather than zero.
 */
export const TEST_COUNT_UNAVAILABLE = "Test count unavailable";

export function testCountsLabel(test: {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
  parsedConfidently: boolean;
}): string {
  if (!test.parsedConfidently || test.total === null)
    return `${TEST_COUNT_UNAVAILABLE} (counts not parsed confidently)`;
  const parts = [`${formatCount(test.passed)} passed`];
  if (test.failed !== null && test.failed > 0)
    parts.push(`${formatCount(test.failed)} failed`);
  if (test.skipped !== null && test.skipped > 0)
    parts.push(`${formatCount(test.skipped)} skipped`);
  parts.push(`${formatCount(test.total)} total`);
  return parts.join(" / ");
}

/** Counts for a persisted verification outcome, or an explicit absence. */
export function verificationCountsLabel(
  counts: { passed: number; failed: number; total: number } | null | undefined,
): string {
  if (!counts) return TEST_COUNT_UNAVAILABLE;
  return `${formatCount(counts.passed)} passed / ${formatCount(counts.failed)} failed / ${formatCount(counts.total)} total`;
}

export interface AttemptCountsView {
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
  /** Where the numbers came from, so nothing looks more certain than it is. */
  source: "verification record" | "normalized test run" | "none";
  framework: string | null;
}

/**
 * Counts for one attempt.
 *
 * A persisted verification outcome can carry `counts: null` while the
 * normalized test runs for the same attempt were parsed confidently (the real
 * runs behave this way). The attempt's own rows are correlated by `attemptId` —
 * the newest confidently parsed row is used, never a sum, so an earlier
 * verification is never double-counted and no prose is parsed.
 */
export function attemptCountsView(input: {
  attemptId: string;
  verification: VerificationOutcomeRecord | null;
  tests: readonly Pick<
    TestRunRecord,
    | "attemptId"
    | "framework"
    | "passed"
    | "failed"
    | "skipped"
    | "total"
    | "parsedConfidently"
    | "createdAt"
  >[];
}): AttemptCountsView {
  if (input.verification?.counts)
    return {
      counts: input.verification.counts,
      source: "verification record",
      framework: null,
    };
  const newest = input.tests
    .filter(
      (test) =>
        test.attemptId === input.attemptId &&
        test.parsedConfidently &&
        test.total !== null,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (newest && newest.total !== null)
    return {
      counts: {
        passed: newest.passed ?? 0,
        failed: newest.failed ?? 0,
        skipped: newest.skipped ?? 0,
        total: newest.total,
      },
      source: "normalized test run",
      framework: newest.framework,
    };
  return { counts: null, source: "none", framework: null };
}

export function testSummary(test: TestRunRecord): string {
  return `${test.framework} · ${testCountsLabel(test)}${test.summary ? ` · ${singleLine(test.summary)}` : ""}`;
}

/** Quotes a single argument for display only. Execution always uses argv arrays. */
export function shellQuoteArgument(argument: string): string {
  if (argument.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument))
    return argument;
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(
  command: Pick<CommandSpec, "executable" | "args">,
): string {
  return [command.executable, ...command.args]
    .map(shellQuoteArgument)
    .join(" ");
}

/**
 * One honest sentence for a persisted verification outcome.
 *
 * A successful command whose counts were not parsed confidently still reads as
 * "Command passed" — with the count explicitly unavailable rather than invented.
 */
export function verificationLabel(
  outcome:
    | (Pick<VerificationOutcomeRecord, "status" | "summary"> & {
        counts: {
          passed: number;
          failed: number;
          skipped: number;
          total: number;
        } | null;
      })
    | null,
): string {
  if (!outcome) return `verification ${UNKNOWN}`;
  if (outcome.status === "unavailable")
    return `verification unavailable · ${singleLine(outcome.summary)}`;
  const verb =
    outcome.status === "passed"
      ? "Command passed"
      : outcome.status === "failed"
        ? "Command failed"
        : `verification ${outcome.status}`;
  const counts = outcome.counts
    ? ` · ${outcome.counts.passed}/${outcome.counts.total} passed${outcome.counts.failed > 0 ? `, ${outcome.counts.failed} failed` : ""}`
    : ` · ${TEST_COUNT_UNAVAILABLE}`;
  return `${verb}${counts}`;
}

export interface ArtifactView {
  summary: string;
  size: string;
  exists: string;
  canRegister: boolean;
}

export function artifactView(artifact: ArtifactRecord): ArtifactView {
  return {
    summary: `${text(artifact.kind, "artifact")} · ${artifact.path}`,
    size: formatBytes(artifact.sizeBytes),
    exists: artifact.exists ? "present" : "missing on disk",
    canRegister: Boolean(artifact.path),
  };
}

export interface UsageView {
  input: string;
  output: string;
  total: string;
  cost: string;
  model: string;
  known: boolean;
}

/** `null` usage is UNKNOWN (never zeros) — the domain's explicit rule. */
export function usageView(
  usage: Usage | null | undefined,
  usageKnown?: boolean,
): UsageView {
  const known = usageKnown !== false && usage !== null && usage !== undefined;
  if (!known) {
    return {
      input: UNKNOWN,
      output: UNKNOWN,
      total: UNKNOWN,
      cost: UNKNOWN,
      model: UNKNOWN,
      known: false,
    };
  }
  const cost =
    usage.costUsd === null || usage.costUsd === undefined
      ? UNKNOWN
      : `$${usage.costUsd.toFixed(4)}`;
  return {
    input: formatCount(usage.inputTokens),
    output: formatCount(usage.outputTokens),
    total: formatCount(usage.totalTokens),
    cost,
    model: text(usage.model),
    known: true,
  };
}

/* ------------------------------------------------------------------ */
/* Review verdicts                                                     */
/* ------------------------------------------------------------------ */

export function verdictTone(verdict: ReviewVerdictKind | null): Tone {
  if (verdict === "APPROVE") return "success";
  if (verdict === "APPROVE_WITH_FIXES") return "warn";
  if (verdict === "REJECT") return "danger";
  return "muted";
}

export function verdictLabel(
  verdict: ReviewVerdictKind | null,
  valid = true,
): string {
  if (!verdict)
    return valid ? "No structured verdict" : "Invalid verdict payload";
  const words = verdict.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Issues are grouped into the two dispositions an operator decides on:
 * `blocking` stops the run, everything else (major, minor, nit) is a
 * suggestion. The persisted severity word is preserved verbatim on the issue
 * itself, so the grouping never hides what the reviewer actually wrote.
 */
export type IssueDisposition = "blocker" | "suggestion";

export function issueDisposition(severity: string): IssueDisposition {
  return severity.trim().toLowerCase() === "blocking"
    ? "blocker"
    : "suggestion";
}

export function issueDispositionLabel(disposition: IssueDisposition): string {
  return disposition === "blocker" ? "Blocker" : "Suggestion";
}

export interface IssueTally {
  blockers: number;
  suggestions: number;
  /** `true` when the payload listed no issues at all. */
  empty: boolean;
  /** One short phrase: `2 suggestions`, `1 blocker · 2 suggestions`, … */
  label: string;
}

export function issueTally(
  issues: readonly { severity: string }[],
): IssueTally {
  let blockers = 0;
  let suggestions = 0;
  for (const issue of issues) {
    if (issueDisposition(issue.severity) === "blocker") blockers += 1;
    else suggestions += 1;
  }
  const parts: string[] = [];
  if (blockers > 0)
    parts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
  if (suggestions > 0)
    parts.push(`${suggestions} suggestion${suggestions === 1 ? "" : "s"}`);
  return {
    blockers,
    suggestions,
    empty: blockers + suggestions === 0,
    label: parts.length > 0 ? parts.join(" · ") : "No issues recorded",
  };
}

/**
 * One short sentence for a verification outcome, for the concise evidence
 * summary: `7 tests passed`. Counts come from a single verification attempt —
 * the newest row correlated by attempt id — and are never summed across runs
 * (two 7-test records are 7 tests, not 14).
 */
export function verificationShortLabel(outcome: {
  status: string;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } | null;
}): string {
  const { counts } = outcome;
  if (!counts || counts.total === null)
    return outcome.status === "passed"
      ? "Command passed, test count unavailable"
      : `Verification ${outcome.status}, test count unavailable`;
  const total = formatCount(counts.total);
  const passed = formatCount(counts.passed);
  if (counts.failed > 0) return `${passed} of ${total} tests passed`;
  return `${passed} test${counts.passed === 1 ? "" : "s"} passed`;
}

/**
 * Reviewer identity as a plain name.
 *
 * Review payloads carry a free-form `reviewer` string. When that string happens
 * to be a configured agent id, the operator sees the agent's display name; an
 * unknown string is shown verbatim and an absent one says so. Nothing is
 * guessed — an absent identity is never replaced by a plausible name.
 */
export function reviewerName(
  reviewer: string | null | undefined,
  agents: readonly Pick<AgentRecord, "id" | "name">[] = [],
): string {
  const value = (reviewer ?? "").trim();
  if (!value) return "reviewer not recorded";
  return agents.find((agent) => agent.id === value)?.name ?? value;
}

export interface ReviewerIdentity {
  /** Display name, or an explicit absence. Never invented. */
  name: string;
  /** Where the name came from, so the UI can be honest about the source. */
  source: "verdict field" | "reviewer attempt agent" | "none";
  agentId: string | null;
}

/**
 * Durable reviewer identity.
 *
 * A real verdict payload often omits the free-form `reviewer` string, but the
 * verdict still records `attemptId`, and that attempt records the agent that
 * produced it. That persisted relationship is used instead of reporting the
 * reviewer as unknown, and the source is reported with the name. Nothing is
 * inferred: when neither the field nor the attempt resolves, the identity stays
 * explicitly absent.
 */
export function reviewerIdentity(input: {
  reviewer?: string | null;
  attemptId?: string | null;
  attempts?: readonly Pick<AttemptRecord, "id" | "agentId">[];
  agents?: readonly Pick<AgentRecord, "id" | "name">[];
}): ReviewerIdentity {
  const agents = input.agents ?? [];
  const value = (input.reviewer ?? "").trim();
  if (value) {
    const agent = agents.find((candidate) => candidate.id === value);
    return {
      name: reviewerName(value, agents),
      source: "verdict field",
      agentId: agent?.id ?? null,
    };
  }
  const attempt = input.attempts?.find(
    (candidate) => candidate.id === input.attemptId,
  );
  const agentId = attempt?.agentId ?? null;
  if (agentId) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent)
      return {
        name: agent.name,
        source: "reviewer attempt agent",
        agentId,
      };
    return { name: agentId, source: "reviewer attempt agent", agentId };
  }
  return { name: "reviewer not recorded", source: "none", agentId: null };
}

/**
 * The run-level review counter.
 *
 * `run.reviewCycle` is the 1-based review pass the run is on (the store seeds a
 * new run at pass 1). The rail's fix/retest nodes instead count the fix
 * iterations that were activated, so the two must never share an unqualified
 * "cycle N" label or the numbers appear to contradict each other.
 */
export interface ReviewCycleView {
  /** Review pass currently in progress (1-based, clamped to the budget). */
  cycle: number;
  /** Hard budget from the frozen run policy. */
  max: number;
  /** Fix iterations that can have run before the current pass. */
  used: number;
  /** `true` once the last allowed review pass has been reached. */
  exhausted: boolean;
  /** One label for every surface that shows the run-level counter. */
  label: string;
}

export function reviewCycleView(run: {
  reviewCycle: number;
  policy: { maxReviewCycles: number };
}): ReviewCycleView {
  const max = Math.max(1, Math.trunc(run.policy.maxReviewCycles) || 1);
  const raw = Math.trunc(run.reviewCycle);
  const cycle = Math.min(Math.max(1, Number.isFinite(raw) ? raw : 1), max);
  return {
    cycle,
    max,
    used: cycle - 1,
    exhausted: cycle >= max,
    label: `review cycle ${cycle} of ${max}`,
  };
}

/**
 * Label for a fix/retest branch: the number is the review pass that requested
 * the fixes, never a run-level counter.
 */
export function fixLoopCycleLabel(cycle: number, max: number): string {
  const value = Math.trunc(cycle);
  if (!Number.isFinite(value) || value <= 0)
    return `no fix cycle has run yet (max ${max})`;
  return `fixes from review cycle ${value} of ${max}`;
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export const APPROVAL_GATE_LABELS: Record<string, string> = {
  final_acceptance: "Final acceptance gate",
  review_reject: "Review rejected — human decision required",
  review_cycle_exhausted: "Review cycles exhausted",
};

export function approvalGateLabel(gate: string): string {
  return APPROVAL_GATE_LABELS[gate] ?? gate;
}

/**
 * The one primary state sentence for a pending gate.
 *
 * This is the page's semantic state ("Ready for your review"), not a repeat of
 * the run status word and not a raw gate key: `final_acceptance` and
 * `final_verify` never reach the screen as identifiers. The run page's own 20px
 * state comes from `run-view.ts`; this headline belongs to the decision sheet,
 * where the final gate reads "Ready to finish" because the work is done and the
 * remaining question is whether to accept it.
 */
export function approvalStateHeadline(gate: string): string {
  switch (gate) {
    case "final_acceptance":
      return "Ready to finish";
    case "review_reject":
      return "Review rejected — your call";
    case "review_cycle_exhausted":
      return "Changes requested — fix cycles exhausted";
    default:
      return "Waiting for your decision";
  }
}

export interface DecisionOption {
  decision: ApprovalDecision;
  label: string;
  detail: string;
  tone: Tone;
  /** `true` when the decision cannot be submitted without a reason. */
  requiresInstruction: boolean;
  /** Mandatory-reason field label; `null` when the decision takes no reason. */
  reasonLabel: string | null;
  /** Why the reason is required and where it is stored. */
  reasonHelp: string | null;
}

const DECISION_LIBRARY: Record<
  ApprovalDecision,
  Omit<DecisionOption, "decision">
> = {
  approve: {
    label: "Approve",
    detail:
      "Accept this gate. The run advances to the next stage (final verification still runs where the plan requires it).",
    tone: "success",
    requiresInstruction: false,
    reasonLabel: null,
    reasonHelp: null,
  },
  reject: {
    label: "Reject",
    detail:
      "Reject the work at this gate and stop the run. Nothing is accepted and no override is recorded.",
    tone: "danger",
    requiresInstruction: true,
    reasonLabel: "Reason for rejecting",
    reasonHelp:
      "Mandatory. Stored on the approval record as your decision reason, so the rejection is auditable later.",
  },
  override: {
    label: "Override rejection and continue",
    detail:
      "Record an operator override of the reviewer's blocking verdict and let the run continue. The override is audited, is stored with your reason, and cannot skip final verification or the final human acceptance gate.",
    tone: "warn",
    requiresInstruction: true,
    reasonLabel: "Reason for overriding the rejection",
    reasonHelp:
      "Mandatory. Explains why the blocking verdict is being overridden; stored on the approval record with your decision.",
  },
  retry: {
    label: "Retry stage",
    detail:
      "Create a new attempt for this stage. The failed attempt is kept as immutable history.",
    tone: "info",
    requiresInstruction: true,
    reasonLabel: "Reason for retrying the stage",
    reasonHelp: "Mandatory. Stored on the new attempt as its immutable reason.",
  },
};

/** The approve decision reads as an explicit acceptance at the final gate. */
const FINAL_ACCEPTANCE_APPROVE: Pick<DecisionOption, "label" | "detail"> = {
  label: "Accept run",
  detail:
    "Accept this completed run at the final human gate. Your acceptance, not the reviewer's exit code, is what ends the workflow.",
};

/**
 * Decisions the server actually allows for this gate, in a stable order.
 * `allowed` is authoritative — the UI never offers an unavailable decision.
 */
export function approvalDecisionOptions(
  approval: ApprovalRecord | null | undefined,
): DecisionOption[] {
  if (!approval) return [];
  const order: ApprovalDecision[] = ["approve", "retry", "override", "reject"];
  return order
    .filter((decision) => approval.allowed.includes(decision))
    .map((decision) => {
      const base = { decision, ...DECISION_LIBRARY[decision] };
      if (decision === "approve" && approval.gate === "final_acceptance")
        return { ...base, ...FINAL_ACCEPTANCE_APPROVE };
      return base;
    });
}

/* ------------------------------------------------------------------ */
/* Approval evidence and operator input                                */
/* ------------------------------------------------------------------ */

export interface ApprovalEvidenceIssue {
  severity: string;
  description: string;
  location: string | null;
}

export interface ApprovalEvidenceVerdict {
  label: string;
  /** The persisted verdict kind, so copy can be derived without re-parsing. */
  kind: ReviewVerdictKind | null;
  tone: Tone;
  valid: boolean;
  cycle: number;
  /** Stage that produced the verdict, so a fallback verdict is never misread. */
  stageKey: string;
  reviewer: string;
  /** How the reviewer name was resolved (verdict field vs recorded attempt). */
  reviewerSource: ReviewerIdentity["source"];
  /** Where the reviewer identity came from, in words, for the details view. */
  reviewerProvenance: string;
  summary: string | null;
  issues: ApprovalEvidenceIssue[];
  /** Blocking findings vs suggestions, with the persisted severity kept. */
  tally: IssueTally;
  createdAt: string;
}

export interface ApprovalEvidence {
  gate: string;
  gateLabel: string;
  reason: string | null;
  stageKey: string | null;
  cycle: ReviewCycleView;
  /** The verdict that stopped the run, when the gate came from a review. */
  verdict: ApprovalEvidenceVerdict | null;
  /** Latest verification recorded for the run, with the stage it came from. */
  verification: ApprovalEvidenceVerification | null;
}

export interface ApprovalEvidenceVerification {
  status: string;
  label: string;
  /** Short form for the concise summary: `7 tests passed`. */
  shortLabel: string;
  /** Attempt the verification belongs to, so its own test rows can be shown. */
  attemptId: string;
  attemptNumber: number;
  stageKey: string;
  /** `true` when the verification belongs to the stage that opened the gate. */
  onGateStage: boolean;
  /** Where the counts in the label came from. */
  countsSource: AttemptCountsView["source"];
  framework: string | null;
}

/**
 * The persisted facts behind a pending human gate.
 *
 * The UI renders this *before* the decision buttons, so an operator decides
 * from the recorded evidence (verdict, issues, verification, cycle) instead of
 * from a bare pair of buttons. Every field is read from the payload; nothing is
 * summarised away and nothing is invented.
 *
 * The gating stage is preferred, and the latest run-wide record is used when
 * that stage has none (the final acceptance gate is opened by the human stage
 * itself, and the evidence that matters there is the last verification the run
 * recorded — reported with its own stage so the operator can see where it is
 * from).
 */
export function approvalEvidenceView(input: {
  approval: Pick<ApprovalRecord, "gate" | "reason" | "stageKey"> | null;
  reviewCycle: ReviewCycleView;
  verdicts: readonly ReviewVerdictRecord[];
  attempts: readonly Pick<
    AttemptRecord,
    | "id"
    | "attemptNumber"
    | "stageKey"
    | "agentId"
    | "verification"
    | "reviewVerdictId"
  >[];
  tests?: readonly Pick<
    TestRunRecord,
    | "attemptId"
    | "framework"
    | "passed"
    | "failed"
    | "skipped"
    | "total"
    | "parsedConfidently"
    | "createdAt"
  >[];
  agents?: readonly Pick<AgentRecord, "id" | "name">[];
}): ApprovalEvidence | null {
  const { approval } = input;
  if (!approval) return null;
  const verdictRecord =
    input.verdicts
      .filter((verdict) => verdict.stageKey === approval.stageKey)
      .at(-1) ?? input.verdicts.at(-1);
  const tests = input.tests ?? [];
  /** Newest test record timestamp for one attempt (`""` when it has none). */
  const testRecency = (attemptId: string): string =>
    tests
      .filter((test) => test.attemptId === attemptId)
      .reduce(
        (newest, test) => (test.createdAt > newest ? test.createdAt : newest),
        "",
      );
  const verified = input.attempts.filter((candidate) => candidate.verification);
  const byRecency = [...verified].sort((a, b) =>
    testRecency(a.id).localeCompare(testRecency(b.id)),
  );
  const attempt =
    // 1. the gate's own stage, or 2. the attempt the verdict came from,
    // otherwise 3. the newest verification recorded anywhere in the run —
    // never a blend, and never a sum of two verification records.
    verified.find((candidate) => candidate.stageKey === approval.stageKey) ??
    (verdictRecord
      ? verified.find(
          (candidate) =>
            candidate.attemptNumber === verdictRecord.cycle &&
            candidate.stageKey === verdictRecord.stageKey,
        )
      : undefined) ??
    byRecency.at(-1);
  const counts = attempt
    ? attemptCountsView({
        attemptId: attempt.id,
        verification: attempt.verification,
        tests: input.tests ?? [],
      })
    : null;
  const identity = verdictRecord
    ? reviewerIdentity({
        reviewer: verdictRecord.reviewer,
        attemptId: verdictRecord.attemptId,
        attempts: input.attempts,
        agents: input.agents,
      })
    : null;
  return {
    gate: approval.gate,
    gateLabel: approvalGateLabel(approval.gate),
    reason: approval.reason,
    stageKey: approval.stageKey,
    cycle: input.reviewCycle,
    verdict:
      verdictRecord && identity
        ? {
            label: verdictLabel(verdictRecord.verdict, verdictRecord.valid),
            kind: verdictRecord.verdict,
            tone: verdictTone(verdictRecord.verdict),
            valid: verdictRecord.valid,
            cycle: verdictRecord.cycle,
            stageKey: verdictRecord.stageKey,
            reviewer: identity.name,
            reviewerSource: identity.source,
            reviewerProvenance: reviewerProvenanceLabel(identity),
            summary: verdictRecord.summary,
            issues: verdictRecord.issues.map((issue) => ({
              severity: issue.severity,
              description: issue.description,
              location: issue.path
                ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
                : null,
            })),
            tally: issueTally(verdictRecord.issues),
            createdAt: verdictRecord.createdAt,
          }
        : null,
    verification:
      attempt && attempt.verification && counts
        ? {
            status: attempt.verification.status,
            label: verificationLabel({
              ...attempt.verification,
              counts: counts.counts,
            }),
            shortLabel: verificationShortLabel({
              status: attempt.verification.status,
              counts: counts.counts,
            }),
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            stageKey: attempt.stageKey,
            onGateStage: attempt.stageKey === approval.stageKey,
            countsSource: counts.source,
            framework: counts.framework,
          }
        : null,
  };
}

/** How the reviewer identity was established, in words. */
export function reviewerProvenanceLabel(identity: ReviewerIdentity): string {
  switch (identity.source) {
    case "verdict field":
      return "read from the verdict's reviewer field";
    case "reviewer attempt agent":
      return identity.agentId
        ? `resolved through the verdict's attempt (${identity.agentId}) to the agent record`
        : "resolved through the verdict's attempt";
    default:
      return "no reviewer field and no attempt on the verdict";
  }
}

/** `approved` · `rejected` · `approved with fixes required` · explicit absence. */
export function verdictActionWord(
  verdict: ReviewVerdictKind | null,
  valid: boolean,
): string {
  if (!valid) return "returned an invalid payload";
  switch (verdict) {
    case "APPROVE":
      return "approved";
    case "APPROVE_WITH_FIXES":
      return "approved with fixes required";
    case "REJECT":
      return "rejected";
    default:
      return "returned no structured verdict";
  }
}

/**
 * The one-line summary of the persisted evidence, shown before the buttons:
 * `Claude approved · 7 tests passed`. Both halves come from the payload — the
 * reviewer through the durable verdict→attempt→agent relationship, and the
 * count from a single verification attempt (never a sum of test records).
 */
export function approvalSummaryLine(evidence: ApprovalEvidence): string {
  const parts: string[] = [];
  const verdict = evidence.verdict;
  if (verdict) {
    if (verdict.reviewerSource === "none")
      parts.push(`Verdict recorded (reviewer not recorded)`);
    else
      parts.push(
        `${verdict.reviewer} ${verdictActionWord(verdict.kind, verdict.valid)}`,
      );
  } else {
    parts.push("No review verdict recorded for this gate");
  }
  parts.push(
    evidence.verification
      ? evidence.verification.shortLabel
      : "No verification recorded",
  );
  return parts.join(" · ");
}

export interface PendingInputQuestion {
  /** The agent's own words, verbatim from the persisted record. */
  text: string;
  source: "input.requested" | "agent.waiting" | "attempt summary" | "none";
  attemptNumber: number | null;
  stageKey: string | null;
  at: string | null;
}

/**
 * The actual question an agent is blocked on.
 *
 * The operator must see what was asked, next to the input box, taken verbatim
 * from the record and scoped to the attempt that is actually waiting: the
 * newest `agent.waiting` message of that attempt first (that is the agent's own
 * question), then its `input.requested` summary, then its stored result
 * summary. An attempt that is no longer waiting never contributes its stale
 * question, and an absent question is reported as absent instead of being
 * paraphrased or invented.
 */
export function pendingInputQuestion(input: {
  events: readonly EventRecord[];
  attempts: readonly Pick<
    AttemptRecord,
    "id" | "attemptNumber" | "stageKey" | "status" | "resultSummary"
  >[];
}): PendingInputQuestion {
  const waiting = [...input.attempts]
    .filter((candidate) => candidate.status === "WAITING_INPUT")
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  const scoped = waiting
    ? input.events.filter((event) => event.attemptId === waiting.id)
    : [];
  const newest = (
    events: readonly EventRecord[],
    type: string,
  ): { text: string; event: EventRecord } | null => {
    const event = events.filter((candidate) => candidate.type === type).at(-1);
    if (!event) return null;
    const message = eventMessage(event).trim();
    return message ? { text: message, event } : null;
  };
  const found =
    newest(scoped, "agent.waiting") ??
    newest(scoped, "input.requested") ??
    (waiting ? null : newest(input.events, "input.requested"));
  if (found) {
    const attempt = input.attempts.find(
      (candidate) => candidate.id === found.event.attemptId,
    );
    return {
      text: found.text,
      source:
        found.event.type === "agent.waiting"
          ? "agent.waiting"
          : "input.requested",
      attemptNumber: attempt?.attemptNumber ?? waiting?.attemptNumber ?? null,
      stageKey: found.event.stageKey ?? waiting?.stageKey ?? null,
      at: found.event.createdAt,
    };
  }
  if (waiting?.resultSummary?.trim())
    return {
      text: waiting.resultSummary.trim(),
      source: "attempt summary",
      attemptNumber: waiting.attemptNumber,
      stageKey: waiting.stageKey,
      at: null,
    };
  return {
    text: "",
    source: "none",
    attemptNumber: waiting?.attemptNumber ?? null,
    stageKey: waiting?.stageKey ?? null,
    at: null,
  };
}

/* ------------------------------------------------------------------ */
/* Home sections                                                       */
/* ------------------------------------------------------------------ */

export interface HomeSections {
  active: RunRecord[];
  waiting: RunRecord[];
  failed: RunRecord[];
  recent: RunRecord[];
}

function byUpdatedDesc(a: RunRecord, b: RunRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** Compact dashboard buckets. Each run appears in exactly one section. */
export function homeSections(
  runs: readonly RunRecord[],
  recentLimit = 6,
): HomeSections {
  const sorted = [...runs].sort(byUpdatedDesc);
  const active: RunRecord[] = [];
  const waiting: RunRecord[] = [];
  const failed: RunRecord[] = [];
  const recent: RunRecord[] = [];
  for (const run of sorted) {
    if (run.status === "RUNNING") active.push(run);
    else if (
      run.status === "WAITING_APPROVAL" ||
      run.status === "WAITING_INPUT"
    )
      waiting.push(run);
    else if (run.status === "FAILED" || run.status === "INTERRUPTED")
      failed.push(run);
    else recent.push(run);
  }
  return { active, waiting, failed, recent: recent.slice(0, recentLimit) };
}

/**
 * A time-appropriate greeting for the operational home.
 *
 * Deterministic from the clock the caller passes (tests pass a fixed time);
 * nothing is invented beyond the hour of day.
 */
export function greetingFor(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export interface HomeSummary {
  /** Runs that stopped and are waiting on an operator: gates plus failures. */
  needsYou: RunRecord[];
  running: RunRecord[];
  recent: RunRecord[];
  /** The number the greeting states: needs-you plus running. */
  attention: number;
  /** One honest sentence for the greeting line. */
  attentionLabel: string;
}

/**
 * The operational home summary.
 *
 * Only the three sections an operator acts on: what needs them, what is
 * running, and what finished recently. Empty categories are absent from the
 * model entirely (the view renders nothing for them) instead of appearing as
 * placeholder cards.
 */
export function homeSummary(
  runs: readonly RunRecord[],
  recentLimit = 6,
): HomeSummary {
  const { active, waiting, failed, recent } = homeSections(runs, recentLimit);
  const needsYou = [...waiting, ...failed].sort(byUpdatedDesc);
  const attention = needsYou.length + active.length;
  let attentionLabel = "Nothing needs you right now";
  if (needsYou.length > 0 && active.length > 0)
    attentionLabel = `${needsYou.length} need you · ${active.length} running`;
  else if (needsYou.length > 0)
    attentionLabel = `${needsYou.length} need${needsYou.length === 1 ? "s" : ""} you`;
  else if (active.length > 0) attentionLabel = `${active.length} running`;
  return { needsYou, running: active, recent, attention, attentionLabel };
}

/* ------------------------------------------------------------------ */
/* History search                                                      */
/* ------------------------------------------------------------------ */

export interface RunSearchForm {
  q: string;
  projectId: string;
  agentId: string;
  status: string;
  branch: string;
  verdict: string;
  from: string;
  to: string;
}

export const EMPTY_RUN_SEARCH: RunSearchForm = {
  q: "",
  projectId: "",
  agentId: "",
  status: "",
  branch: "",
  verdict: "",
  from: "",
  to: "",
};

function endOfDayIso(date: string): string | null {
  const parsed = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function startOfDayIso(date: string): string | null {
  const parsed = new Date(`${date}T00:00:00.000`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Maps the search form onto the `GET /api/runs` query contract
 * (`q`, `projectId`, `agentId`, `status`, `branch`, `verdict`, `from`, `to`).
 * Empty fields are omitted so the server applies no filter for them.
 */
export function buildRunSearchParams(
  form: RunSearchForm,
): Record<string, string> {
  const params: Record<string, string> = {};
  const set = (key: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) params[key] = trimmed;
  };
  set("q", form.q);
  set("projectId", form.projectId);
  set("agentId", form.agentId);
  set("status", form.status);
  set("branch", form.branch);
  set("verdict", form.verdict);
  const from = form.from ? startOfDayIso(form.from) : null;
  if (from) params["from"] = from;
  const to = form.to ? endOfDayIso(form.to) : null;
  if (to) params["to"] = to;
  return params;
}

/** Serializes defined, non-empty string fields; other values are ignored. */
export function serializeQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `GET /api/runs` rows may carry the derived branch/verdict columns when the server provides them. */
export type RunListItem = RunListRecord;

/** Client-side echo of the server's filters, used only for optimistic feedback. */
export function runMatchesSearch(
  run: RunListItem,
  form: RunSearchForm,
  projectName?: string,
  agentName?: string,
): boolean {
  if (form.q) {
    const needle = form.q.trim().toLowerCase();
    const haystack = `${run.goal} ${projectName ?? ""} ${run.id}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (form.projectId && run.projectId !== form.projectId) return false;
  if (form.status && run.status !== form.status) return false;
  if (form.branch && (run.branch ?? "") !== form.branch) return false;
  if (form.verdict && (run.lastReviewVerdict ?? "") !== form.verdict)
    return false;
  if (
    form.agentId &&
    !Object.values(run.roleMapping).includes(form.agentId) &&
    agentName !== form.agentId
  )
    return false;
  if (form.from) {
    const from = startOfDayIso(form.from);
    if (from && run.createdAt < from) return false;
  }
  if (form.to) {
    const to = endOfDayIso(form.to);
    if (to && run.createdAt > to) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Forms: projects, agents                                             */
/* ------------------------------------------------------------------ */

export const VERIFICATION_COMMAND_NAMES = [
  "test",
  "build",
  "lint",
  "typecheck",
] as const;
export type VerificationCommandName =
  (typeof VERIFICATION_COMMAND_NAMES)[number];

export const ADAPTER_KINDS = [
  "mock",
  "generic-cli",
  "codex",
  "claude-code",
  "hermes-opencode",
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const ADAPTER_LABELS: Record<AdapterKind, string> = {
  mock: "Mock (deterministic local scenarios)",
  "generic-cli": "Generic CLI (configured executable + args)",
  codex: "Codex CLI",
  "claude-code": "Claude Code CLI",
  "hermes-opencode": "Hermes / OpenCode CLI",
};

export const ADAPTER_NOTES: Record<AdapterKind, string> = {
  mock: "Runs an in-process deterministic scenario. Nothing is executed and no network call is made.",
  "generic-cli":
    "Launches the configured executable with the configured argument array and writes the prompt to stdin.",
  codex:
    "Launches the configured Codex executable. The model and effort strings are sent as configured.",
  "claude-code":
    "Launches the configured Claude Code executable in non-interactive mode.",
  "hermes-opencode":
    "Launches the Hermes/OpenCode CLI. One-shot mode auto-bypasses its own approval prompts — enable it deliberately.",
};

export const MOCK_SCENARIO_VALUES = [
  "success",
  "failure",
  "fixes",
  "rejection",
  "failure-then-success",
  "long-running",
  "input-required",
  "malformed-review",
  "no-verdict",
  "unavailable",
  "unavailable-result",
] as const;

export interface VerificationCommandForm {
  name: string;
  executable: string;
  argsJson: string;
}

export interface ProjectForm {
  name: string;
  path: string;
  vcs: "git" | "none";
  notes: string;
  allowedAdapters: string[];
  verificationCommands: VerificationCommandForm[];
}

export const EMPTY_PROJECT_FORM: ProjectForm = {
  name: "",
  path: "",
  vcs: "git",
  notes: "",
  allowedAdapters: ["mock"],
  verificationCommands: [],
};

export function emptyVerificationCommand(): VerificationCommandForm {
  return { name: "test", executable: "npm", argsJson: '["test"]' };
}

export interface ArgsParseOk {
  ok: true;
  args: string[];
}
export interface ArgsParseError {
  ok: false;
  error: string;
}

/**
 * Parses the argument *array* box. Shell strings are never accepted: a single
 * command string is a hard error, because the server contract is
 * `{executable, args: string[]}`.
 */
export function parseArgsJson(input: string): ArgsParseOk | ArgsParseError {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, args: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Expected a JSON array, e.g. ["test", "--runInBand"]',
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Expected a JSON array of arguments, not a command string",
    };
  }
  const args: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string")
      return { ok: false, error: "Every argument must be a string" };
    if (item.includes("\0"))
      return { ok: false, error: "Arguments must not contain NUL bytes" };
    args.push(item);
  }
  return { ok: true, args };
}

export interface ProjectPayload {
  name: string;
  path: string;
  vcs: "git" | "none";
  verificationCommands: { name: string; executable: string; args: string[] }[];
  notes: string;
  allowedAdapters: string[];
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export function validateProjectForm(
  form: ProjectForm,
): ValidationResult<ProjectPayload> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors["name"] = "A project name is required";
  if (!form.path.trim())
    errors["path"] = "An absolute repository path is required";
  else if (!form.path.trim().startsWith("/"))
    errors["path"] = "Use an absolute path, e.g. /Users/you/code/project";
  const commands: { name: string; executable: string; args: string[] }[] = [];
  const seenNames = new Set<string>();
  form.verificationCommands.forEach((command, index) => {
    const name = command.name.trim();
    const executable = command.executable.trim();
    if (!VERIFICATION_COMMAND_NAMES.includes(name as VerificationCommandName)) {
      errors[`verificationCommands.${index}.name`] =
        `Name must be one of ${VERIFICATION_COMMAND_NAMES.join(", ")}`;
    } else if (seenNames.has(name)) {
      errors[`verificationCommands.${index}.name`] =
        `Duplicate ${name} command`;
    }
    seenNames.add(name);
    if (!executable)
      errors[`verificationCommands.${index}.executable`] =
        "An executable is required (not a shell string)";
    const parsed = parseArgsJson(command.argsJson);
    if (!parsed.ok) errors[`verificationCommands.${index}.args`] = parsed.error;
    if (
      name &&
      executable &&
      parsed.ok &&
      !errors[`verificationCommands.${index}.name`]
    ) {
      commands.push({ name, executable, args: parsed.args });
    }
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: form.name.trim(),
      path: form.path.trim(),
      vcs: form.vcs,
      verificationCommands: commands,
      notes: form.notes,
      allowedAdapters: [...form.allowedAdapters],
    },
  };
}

export interface AgentForm {
  name: string;
  roleHint: string;
  adapterKind: AdapterKind;
  model: string;
  effort: string;
  enabled: boolean;
  executable: string;
  argsJson: string;
  scenario: string;
  manual: boolean;
  provider: string;
  allowHermesOneshot: boolean;
}

export const EMPTY_AGENT_FORM: AgentForm = {
  name: "",
  roleHint: "",
  adapterKind: "mock",
  model: "",
  effort: "",
  enabled: true,
  executable: "",
  argsJson: "[]",
  scenario: "success",
  manual: false,
  provider: "",
  allowHermesOneshot: false,
};

export interface AgentPayload {
  name: string;
  roleHint: string;
  adapterKind: AdapterKind;
  model: string | null;
  effort: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** Adapter kinds that must have an executable configured to be launchable. */
export const EXECUTABLE_REQUIRED: readonly AdapterKind[] = [
  "generic-cli",
  "codex",
  "claude-code",
  "hermes-opencode",
];

export function validateAgentForm(
  form: AgentForm,
): ValidationResult<AgentPayload> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors["name"] = "A name is required";
  if (!ADAPTER_KINDS.includes(form.adapterKind))
    errors["adapterKind"] = "Unknown adapter kind";
  const config: Record<string, unknown> = {};
  const manual = form.manual;
  if (manual) config["manual"] = true;
  if (!manual && EXECUTABLE_REQUIRED.includes(form.adapterKind)) {
    if (!form.executable.trim())
      errors["executable"] = "An executable is required for this adapter";
    else config["executable"] = form.executable.trim();
    const parsed = parseArgsJson(form.argsJson);
    if (!parsed.ok) errors["args"] = parsed.error;
    else if (parsed.args.length > 0) config["args"] = parsed.args;
  }
  if (form.adapterKind === "mock") {
    if (
      !MOCK_SCENARIO_VALUES.includes(
        form.scenario as (typeof MOCK_SCENARIO_VALUES)[number],
      )
    ) {
      errors["scenario"] = "Unknown mock scenario";
    } else {
      config["scenario"] = form.scenario;
    }
  }
  if (form.adapterKind === "hermes-opencode") {
    if (form.provider.trim()) config["provider"] = form.provider.trim();
    if (form.allowHermesOneshot) config["allowHermesOneshot"] = true;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: form.name.trim(),
      roleHint: form.roleHint.trim(),
      adapterKind: form.adapterKind,
      model: form.model.trim() ? form.model.trim() : null,
      effort: form.effort.trim() ? form.effort.trim() : null,
      enabled: form.enabled,
      config,
    },
  };
}

export interface AgentPreset {
  id: string;
  label: string;
  description: string;
  form: AgentForm;
  /** Honest caveat rendered next to the preset. Never claims availability. */
  caveat: string;
}

/**
 * Presets only pre-fill the form. They are not evidence that a CLI is present,
 * authenticated or reachable: the UI states that explicitly and the agent list
 * shows configured state, not liveness.
 */
export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: "astra-codex",
    label: "GPT-6 Astra (Codex CLI)",
    description:
      "High-effort orchestrator/reviewer preset using the Codex CLI adapter.",
    form: {
      ...EMPTY_AGENT_FORM,
      name: "GPT-6 Astra",
      roleHint: "orchestrator",
      adapterKind: "codex",
      model: "gpt-6-astra",
      effort: "high",
      executable: "codex",
      argsJson: "[]",
    },
    caveat:
      "Verify the model ID and that the codex executable is on PATH before enabling.",
  },
  {
    id: "deepseek-hermes",
    label: "DeepSeek V4.1 Flash (Hermes / OpenCode Go)",
    description:
      "Implementation worker preset for the Hermes/OpenCode CLI with the opencode-go provider.",
    form: {
      ...EMPTY_AGENT_FORM,
      name: "DeepSeek V4.1 Flash",
      roleHint: "implementer",
      adapterKind: "hermes-opencode",
      model: "deepseek-v4.1-flash",
      effort: "",
      executable: "hermes",
      provider: "opencode-go",
      allowHermesOneshot: false,
    },
    caveat:
      "One-shot mode is off by default. Enabling it makes the CLI bypass its own approval prompts.",
  },
  {
    id: "claude-opus",
    label: "Claude Opus 5 (Claude Code CLI)",
    description: "Read-only review preset using the Claude Code CLI adapter.",
    form: {
      ...EMPTY_AGENT_FORM,
      name: "Claude Opus 5",
      roleHint: "reviewer",
      adapterKind: "claude-code",
      model: "claude-opus-5",
      effort: "high",
      executable: "claude",
      argsJson: "[]",
    },
    caveat:
      "Verify the model ID and that the claude executable is on PATH before enabling.",
  },
  {
    id: "mock-deterministic",
    label: "Mock (deterministic)",
    description:
      "Offline adapter for exercising the workflow without contacting any provider.",
    form: {
      ...EMPTY_AGENT_FORM,
      name: "Mock agent",
      roleHint: "implementer",
      adapterKind: "mock",
      scenario: "success",
    },
    caveat: "No external process runs; scenarios are deterministic and local.",
  },
];

export function agentToForm(agent: AgentRecord): AgentForm {
  const config = agent.config ?? {};
  const args = Array.isArray(config["args"])
    ? (config["args"] as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  return {
    name: agent.name,
    roleHint: agent.roleHint ?? "",
    adapterKind: (ADAPTER_KINDS.includes(agent.adapterKind as AdapterKind)
      ? agent.adapterKind
      : "generic-cli") as AdapterKind,
    model: agent.model ?? "",
    effort: agent.effort ?? "",
    enabled: agent.enabled,
    executable:
      typeof config["executable"] === "string" ? config["executable"] : "",
    argsJson: JSON.stringify(args),
    scenario:
      typeof config["scenario"] === "string" ? config["scenario"] : "success",
    manual: config["manual"] === true,
    provider: typeof config["provider"] === "string" ? config["provider"] : "",
    allowHermesOneshot: config["allowHermesOneshot"] === true,
  };
}

export function isManualAgent(agent: AgentRecord): boolean {
  return agent.config?.["manual"] === true;
}

/** Configured state only — configuration is never evidence that an agent is live. */
export function agentStateLabel(agent: AgentRecord): string {
  const available = (agent as AgentRecord & { availability?: string })
    .availability;
  if (available)
    return (
      (
        {
          INSTALLED: "CLI installed · access unchecked",
          UNAVAILABLE: "CLI unavailable",
          DISABLED: "disabled",
          MOCK: "deterministic mock",
          MANUAL: "manual handoff",
          UNCONFIGURED: "not configured",
        } as Record<string, string>
      )[available] ?? available
    );
  if (isManualAgent(agent)) return "manual handoff";
  return agent.enabled ? "configured, enabled" : "configured, disabled";
}

export function agentStateTone(agent: AgentRecord): Tone {
  const available = (agent as AgentRecord & { availability?: string })
    .availability;
  // Only a recorded problem is a problem. An installed CLI, an enabled record or
  // a deterministic mock are facts, not successful access validation — the UI
  // never paints them green, because nothing here verifies access.
  if (available === "UNAVAILABLE" || available === "UNCONFIGURED")
    return "danger";
  return "muted";
}

/* ------------------------------------------------------------------ */
/* Artifact registration form                                          */
/* ------------------------------------------------------------------ */

export interface ArtifactForm {
  path: string;
  kind: string;
}

export const EMPTY_ARTIFACT_FORM: ArtifactForm = { path: "", kind: "report" };

export function validateArtifactForm(
  form: ArtifactForm,
): ValidationResult<{ path: string; kind: string }> {
  const errors: Record<string, string> = {};
  const path = form.path.trim();
  if (!path) errors["path"] = "A repository-relative path is required";
  else if (path.startsWith("/"))
    errors["path"] = "Use a path relative to the project root";
  else if (path.split("/").includes(".."))
    errors["path"] = "The path must stay inside the project root";
  const kind = form.kind.trim();
  if (!kind) errors["kind"] = "A kind is required (e.g. report, patch, log)";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { path, kind } };
}

/* ------------------------------------------------------------------ */
/* New run flow                                                        */
/* ------------------------------------------------------------------ */

export interface NewRunForm {
  projectId: string;
  templateId: string;
  goal: string;
  constraintsText: string;
  roleMapping: Record<string, string>;
}

export function parseConstraints(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface RunCreatePayload {
  projectId: string;
  templateId: string;
  goal: string;
  constraints: string[];
  roleMapping: Record<string, string>;
}

export function validateNewRunForm(
  form: NewRunForm,
  requiredRoles: readonly string[],
  availableAgentIds: readonly string[],
  agentsById: Record<string, string> = {},
): ValidationResult<RunCreatePayload> {
  const errors: Record<string, string> = {};
  if (!form.projectId) errors["projectId"] = "Select a registered project";
  if (!form.templateId) errors["templateId"] = "Select a workflow template";
  if (!form.goal.trim()) errors["goal"] = "Describe the goal";
  const constraints = parseConstraints(form.constraintsText);
  const roleMapping: Record<string, string> = {};
  for (const role of requiredRoles) {
    const agentId = form.roleMapping[role];
    if (!agentId) {
      errors[`roleMapping.${role}`] = `Assign an agent to ${role}`;
      continue;
    }
    if (!availableAgentIds.includes(agentId)) {
      errors[`roleMapping.${role}`] =
        `Unknown agent for ${role}${agentsById[agentId] ? ` (${agentsById[agentId]})` : ""}`;
      continue;
    }
    roleMapping[role] = agentId;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      projectId: form.projectId,
      templateId: form.templateId,
      goal: form.goal.trim(),
      constraints,
      roleMapping,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Run actions                                                         */
/* ------------------------------------------------------------------ */

export interface RetryForm {
  reason: string;
  instruction: string;
}

export function validateRetryForm(
  form: RetryForm,
): ValidationResult<{ reason: string; instruction: string | null }> {
  const reason = form.reason.trim();
  if (!reason)
    return { ok: false, errors: { reason: "A retry reason is mandatory" } };
  return {
    ok: true,
    value: {
      reason,
      instruction: form.instruction.trim() ? form.instruction.trim() : null,
    },
  };
}

export function validateCancelReason(
  reason: string,
): ValidationResult<{ reason: string }> {
  const trimmed = reason.trim();
  if (!trimmed)
    return {
      ok: false,
      errors: { reason: "A cancellation reason is mandatory" },
    };
  return { ok: true, value: { reason: trimmed } };
}

export function validateDecision(
  decision: ApprovalDecision,
  instruction: string,
  options: readonly DecisionOption[],
): ValidationResult<{
  decision: ApprovalDecision;
  instruction: string | null;
}> {
  const option = options.find((candidate) => candidate.decision === decision);
  if (!option)
    return {
      ok: false,
      errors: { decision: "That decision is not allowed for this gate" },
    };
  const trimmed = instruction.trim();
  if (option.requiresInstruction && !trimmed) {
    return {
      ok: false,
      errors: {
        instruction: `${option.label} requires an explicit instruction`,
      },
    };
  }
  return {
    ok: true,
    value: { decision, instruction: trimmed ? trimmed : null },
  };
}

/* ------------------------------------------------------------------ */
/* Routing (hash based, no router dependency)                          */
/* ------------------------------------------------------------------ */

export type Route =
  | { view: "home" }
  | { view: "projects"; projectId: string | null }
  | { view: "agents" }
  | { view: "runs"; search: RunSearchForm }
  | { view: "run"; runId: string }
  | { view: "new-run"; projectId: string | null };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [pathPart = "", queryPart = ""] = clean.split("?");
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const query = new URLSearchParams(queryPart);
  const search: RunSearchForm = {
    q: query.get("q") ?? "",
    projectId: query.get("projectId") ?? "",
    agentId: query.get("agentId") ?? "",
    status: query.get("status") ?? "",
    branch: query.get("branch") ?? "",
    verdict: query.get("verdict") ?? "",
    from: query.get("from") ?? "",
    to: query.get("to") ?? "",
  };
  const [head, second] = segments;
  switch (head) {
    case "projects":
      return { view: "projects", projectId: second ?? null };
    case "agents":
      return { view: "agents" };
    case "runs":
      return { view: "runs", search };
    case "run":
      return second ? { view: "run", runId: second } : { view: "runs", search };
    case "new-run": {
      const projectId = second ?? (search.projectId || null);
      return { view: "new-run", projectId };
    }
    default:
      return { view: "home" };
  }
}

export function routeHref(route: Route): string {
  switch (route.view) {
    case "home":
      return "#/";
    case "projects":
      return route.projectId
        ? `#/projects/${encodeURIComponent(route.projectId)}`
        : "#/projects";
    case "agents":
      return "#/agents";
    case "runs":
      return `#/runs${serializeQuery(buildRunSearchParams(route.search))}`;
    case "run":
      return `#/run/${encodeURIComponent(route.runId)}`;
    case "new-run":
      return route.projectId
        ? `#/new-run/${encodeURIComponent(route.projectId)}`
        : "#/new-run";
    default:
      return "#/";
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap-derived lookups                                           */
/* ------------------------------------------------------------------ */

export function indexById<T extends { id: string }>(
  records: readonly T[],
): Record<string, T> {
  const map: Record<string, T> = {};
  for (const record of records) map[record.id] = record;
  return map;
}

export function projectLabel(
  projects: readonly ProjectRecord[],
  projectId: string,
): string {
  return (
    projects.find((project) => project.id === projectId)?.name ?? projectId
  );
}

/** `allowedAdapters` / `notes` live in the free-form `settings` JSON; read defensively. */
export function projectAllowedAdapters(project: ProjectRecord): string[] {
  const raw = project.settings?.["allowedAdapters"];
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

export function projectNotes(project: ProjectRecord): string | null {
  const raw = project.settings?.["notes"];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

export function agentLabel(
  agents: readonly AgentRecord[],
  agentId: string | null | undefined,
): string {
  if (!agentId) return UNKNOWN;
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}

export function projectPathHint(
  projects: readonly ProjectRecord[],
  path: string,
): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const duplicate = projects.find(
    (project) => project.canonicalRoot === trimmed,
  );
  if (duplicate)
    return `Already registered as “${duplicate.name}”. Registration uses the canonical real path.`;
  if (!trimmed.startsWith("/"))
    return "Relative paths are rejected: enter the absolute path to the repository root.";
  return "A git root or a plain directory is accepted. Symlink and traversal escapes are rejected by the server.";
}
