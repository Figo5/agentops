/**
 * Pure view-models for the management screens: projects, agents, run history,
 * the guided workflow and device settings.
 *
 * Same contract as `view-model.ts`: no React, no DOM, no network, and nothing
 * invented. Every field either comes from a persisted record or from a snapshot
 * the view actually fetched; where neither exists the value stays explicitly
 * absent (`null`, `UNKNOWN`, "not recorded") instead of becoming a plausible
 * default.
 */
import type {
  AgentRecord,
  ProjectRecord,
  ReviewVerdictKind,
  RunRecord,
  StagePlan,
} from "../core/types.js";
import type { ProjectSnapshotResponse } from "./api.js";
import {
  UNKNOWN,
  agentStateLabel,
  agentStateTone,
  formatDuration,
  formatTimestamp,
  relativeTime,
  statusLabel,
  text,
  truncate,
  verdictOutcomeLabel,
  type Tone,
} from "./view-model.js";

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/** Branch and working-tree state, only ever from a record or a real fetch. */
export interface ProjectBranchState {
  branch: string | null;
  /** `null` when no snapshot was fetched — never guessed from the record. */
  clean: boolean | null;
  label: string;
  detail: string | null;
}

/**
 * The project's branch line.
 *
 * The branch may come from the registered record (`defaultBranch`) or from a
 * fetched snapshot; the clean/dirty word may only come from a fetch, because
 * nothing else knows the working tree. With neither, the line says so.
 */
export function projectBranchState(
  project: Pick<ProjectRecord, "defaultBranch">,
  snapshot: ProjectSnapshotResponse | null | undefined,
): ProjectBranchState {
  const fetchedBranch = snapshot?.branch ?? null;
  const branch = fetchedBranch ?? project.defaultBranch ?? null;
  const clean =
    snapshot && typeof snapshot.dirty === "boolean" ? !snapshot.dirty : null;
  const parts: string[] = [];
  if (branch) parts.push(branch);
  if (clean !== null) parts.push(clean ? "clean" : "dirty");
  return {
    branch,
    clean,
    label: parts.length > 0 ? parts.join(" · ") : "Branch not recorded",
    detail:
      clean === null
        ? branch
          ? "Branch from the project record; the working tree has not been read yet."
          : "No branch is recorded for this project and no snapshot has been read."
        : `Read from the working tree${snapshot?.head ? ` at ${snapshot.head.slice(0, 12)}` : ""}.`,
  };
}

export interface ProjectRunSummary {
  /** The newest run that is not finished, i.e. what the project is doing now. */
  active: RunRecord | null;
  /** The newest run of any status. */
  latest: RunRecord | null;
  /** One honest sentence about `active ?? latest`. */
  outcome: string;
}

function byUpdatedDesc(a: RunRecord, b: RunRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** One sentence for a run's outcome, from the persisted status and reason. */
export function runOutcomeLabel(
  run: RunRecord,
  now: number = Date.now(),
): string {
  const when = relativeTime(run.updatedAt, now);
  switch (run.status) {
    case "RUNNING":
      return `Running now · updated ${when}`;
    case "WAITING_APPROVAL":
      return `Waiting for your decision · updated ${when}`;
    case "WAITING_INPUT":
      return `Waiting for your input · updated ${when}`;
    case "FAILED":
      return run.failureReason
        ? `Failed · ${truncate(run.failureReason, 120)}`
        : `Failed · ${when}`;
    case "INTERRUPTED":
      return run.interruptReason
        ? `Interrupted · ${truncate(run.interruptReason, 120)}`
        : `Interrupted · ${when}`;
    case "CANCELLED":
      return `Cancelled · ${when}`;
    case "COMPLETED":
      return `Completed · ${when}`;
    case "DRAFT":
      return `Draft, not started · created ${relativeTime(run.createdAt, now)}`;
    default:
      return `${statusLabel(run.status)} · ${when}`;
  }
}

export function projectRunSummary(
  runs: readonly RunRecord[],
  now: number = Date.now(),
): ProjectRunSummary {
  const sorted = [...runs].sort(byUpdatedDesc);
  const latest = sorted[0] ?? null;
  const active =
    sorted.find(
      (run) =>
        run.status === "RUNNING" ||
        run.status === "WAITING_APPROVAL" ||
        run.status === "WAITING_INPUT",
    ) ?? null;
  const subject = active ?? latest;
  return {
    active,
    latest,
    outcome: subject
      ? runOutcomeLabel(subject, now)
      : "No run has been started for this project yet.",
  };
}

/** How long a finished run took; `null` when the timestamps are not recorded. */
export function runDurationMs(run: RunRecord): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const start = new Date(run.startedAt).getTime();
  const end = new Date(run.endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return end - start;
}

/** The ID/storage facts, kept for the collapsed technical disclosure. */
export function projectTechnicalRows(
  project: ProjectRecord,
  snapshot: ProjectSnapshotResponse | null | undefined,
): [string, string][] {
  const rows: [string, string][] = [
    ["Project ID", project.id],
    ["Canonical root", project.canonicalRoot],
    ["VCS", project.vcs],
    ["Default branch", text(project.defaultBranch)],
    ["Storage", "one row in the local AgentOps database"],
    ["Created", formatTimestamp(project.createdAt)],
    [
      "Updated",
      `${formatTimestamp(project.updatedAt)} (${relativeTime(project.updatedAt)})`,
    ],
  ];
  if (snapshot) {
    rows.push(["Snapshot HEAD", snapshot.head ?? UNKNOWN]);
    if (snapshot.error) rows.push(["Snapshot error", snapshot.error]);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Agents                                                             */
/* ------------------------------------------------------------------ */

/**
 * Plain words for adapter kinds and plan roles.
 *
 * The roster is read by a person: `Hermes`, `Claude Code`, `Codex`, `Worker`,
 * `Reviewer`. The persisted identifiers (`hermes-opencode`, `implementer`) stay
 * in the record and are shown under the agent's technical details, so the
 * display copy never replaces the recorded value.
 */
export const ADAPTER_DISPLAY: Record<string, string> = {
  mock: "Mock",
  "generic-cli": "CLI",
  codex: "Codex",
  "claude-code": "Claude Code",
  "hermes-opencode": "Hermes",
};

export const ROLE_DISPLAY: Record<string, string> = {
  planner: "Planner",
  implementer: "Worker",
  reviewer: "Reviewer",
  researcher: "Researcher",
  documenter: "Documenter",
};

export function adapterDisplayName(kind: string | null | undefined): string {
  const value = (kind ?? "").trim();
  if (!value) return "adapter not set";
  return ADAPTER_DISPLAY[value] ?? value;
}

export function roleDisplayName(role: string | null | undefined): string {
  const value = (role ?? "").trim();
  if (!value) return "role not set";
  return ROLE_DISPLAY[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

export interface AgentRowView {
  id: string;
  /** First letter of the name, for the row glyph. */
  initial: string;
  name: string;
  role: string;
  readiness: string;
  readinessTone: Tone;
  /** One compact metadata line: adapter, model, effort, in plain words. */
  secondary: string;
  editLabel: string;
}

/**
 * One clean roster row.
 *
 * `readiness` is configured state, never liveness: an installed CLI reads
 * `CLI installed · access unchecked` and is painted neutral, because nothing
 * here has verified access. The tone only turns negative for a recorded
 * problem.
 */
export function agentRowView(agent: AgentRecord): AgentRowView {
  const name = agent.name.trim();
  const secondary = [
    adapterDisplayName(agent.adapterKind),
    agent.model ?? "model not set",
    agent.effort ? `${agent.effort} effort` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return {
    id: agent.id,
    initial: (name.charAt(0) || "?").toUpperCase(),
    name,
    role: roleDisplayName(agent.roleHint),
    readiness: agentStateLabel(agent),
    readinessTone: agentStateTone(agent),
    secondary,
    editLabel: `Edit ${name || agent.id}`,
  };
}

/** Adapter-specific configuration, for the collapsed advanced disclosure. */
export function agentTechnicalRows(agent: AgentRecord): [string, string][] {
  const config = agent.config ?? {};
  const args = Array.isArray(config["args"])
    ? JSON.stringify(config["args"])
    : "none configured";
  return [
    ["Agent ID", agent.id],
    ["Adapter kind", agent.adapterKind],
    ["Role hint", agent.roleHint?.trim() ? agent.roleHint : "not set"],
    [
      "Executable",
      typeof config["executable"] === "string"
        ? config["executable"]
        : "not configured",
    ],
    ["Arguments", args],
    [
      "Provider",
      typeof config["provider"] === "string"
        ? config["provider"]
        : "not configured",
    ],
    [
      "Hermes one-shot",
      config["allowHermesOneshot"] === true
        ? "enabled — the CLI bypasses its own approval prompts"
        : "not enabled",
    ],
    ["Manual handoff", config["manual"] === true ? "yes" : "no"],
    ["Created", formatTimestamp(agent.createdAt)],
    ["Updated", formatTimestamp(agent.updatedAt)],
  ];
}

/* ------------------------------------------------------------------ */
/* Run history                                                         */
/* ------------------------------------------------------------------ */

export type QuickFilterId =
  | "needs_me"
  | "failed"
  | "completed"
  | "today"
  | "this_week";

export interface QuickFilter {
  id: QuickFilterId;
  label: string;
  hint: string;
}

/**
 * The five quick filters an operator actually reaches for. They narrow the rows
 * the server returned; the advanced filters in "More filters" are what is sent
 * to the server.
 */
export const QUICK_FILTERS: readonly QuickFilter[] = [
  {
    id: "needs_me",
    label: "Needs me",
    hint: "Runs blocked on a human: waiting for a decision, for input, or failed.",
  },
  { id: "failed", label: "Failed", hint: "Runs that ended in failure." },
  {
    id: "completed",
    label: "Completed",
    hint: "Runs accepted at the final human gate.",
  },
  { id: "today", label: "Today", hint: "Runs created since local midnight." },
  {
    id: "this_week",
    label: "This week",
    hint: "Runs created in the last seven days.",
  },
];

/** Blocked on a human: the same rule the dashboard uses for "Needs you". */
export function runNeedsHuman(run: Pick<RunRecord, "status">): boolean {
  return (
    run.status === "WAITING_APPROVAL" ||
    run.status === "WAITING_INPUT" ||
    run.status === "FAILED" ||
    run.status === "INTERRUPTED"
  );
}

/**
 * The state word for a waiting run, read from the run's own frozen plan.
 *
 * `WAITING_APPROVAL` alone is the generic "Waiting for you". When the plan says
 * the cursor sits on the human acceptance stage, the operator is being asked to
 * finish the run and the row says so; on any other stage the ask is a review.
 * Nothing is guessed: when the plan does not resolve the cursor, the generic
 * word stays.
 */
export function waitingStateLabel(
  run: Pick<RunRecord, "status" | "nextStageKey" | "plan">,
): string {
  if (run.status === "WAITING_INPUT") return "Needs your input";
  if (run.status !== "WAITING_APPROVAL") return statusLabel(run.status);
  const next = run.plan.stages.find((stage) => stage.key === run.nextStageKey);
  if (!next) return statusLabel(run.status);
  return next.kind === "final_approval"
    ? "Ready for final approval"
    : "Ready for review";
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function matchesQuickFilter(
  run: Pick<RunRecord, "status" | "createdAt">,
  id: QuickFilterId,
  now: number = Date.now(),
): boolean {
  const created = new Date(run.createdAt).getTime();
  switch (id) {
    case "needs_me":
      return runNeedsHuman(run);
    case "failed":
      return run.status === "FAILED" || run.status === "INTERRUPTED";
    case "completed":
      return run.status === "COMPLETED";
    case "today":
      return Number.isFinite(created) && created >= startOfLocalDay(now);
    case "this_week":
      return (
        Number.isFinite(created) &&
        created >= startOfLocalDay(now) - 6 * 86_400_000
      );
    default:
      return true;
  }
}

/** Applies every selected quick filter (they compose as an intersection). */
export function filterByQuickFilters<
  T extends Pick<RunRecord, "status" | "createdAt">,
>(
  runs: readonly T[],
  ids: readonly QuickFilterId[],
  now: number = Date.now(),
): T[] {
  if (ids.length === 0) return [...runs];
  return runs.filter((run) =>
    ids.every((id) => matchesQuickFilter(run, id, now)),
  );
}

export interface HistoryRowView {
  id: string;
  project: string;
  goal: string;
  /** Status word plus the recorded reason/verdict where there is one. */
  outcome: string;
  /** The state word alone, for the row's status mark. */
  outcomeWord: string;
  /** Just the recorded reason/verdict, or `null` when nothing was recorded. */
  outcomeDetail: string | null;
  status: string;
  tone: Tone;
  when: string;
  /** Relative "updated" phrase, so the row needs no second lookup. */
  updated: string;
  duration: string;
  branch: string;
  agents: string;
  technical: [string, string][];
}

/**
 * One history row.
 *
 * Columns are the ones an operator scans: project, goal, outcome, when and how
 * long, branch, agents. The run id, template and raw timestamps are kept in the
 * row's technical disclosure instead of the main line.
 */
export function historyRowView(
  run: RunRecord & {
    branch?: string | null;
    lastReviewVerdict?: ReviewVerdictKind | null;
  },
  context: {
    projectNames: Record<string, string>;
    agentNames: Record<string, string>;
    now?: number;
  },
): HistoryRowView {
  const now = context.now ?? Date.now();
  const verdict = run.lastReviewVerdict ?? null;
  /** Past-tense outcome word: `Approved`, `Changes requested`, `Approved with fixes`. */
  const verdictWord = verdict ? verdictOutcomeLabel(verdict, true) : null;
  const outcomeWord = waitingStateLabel(run);
  /**
   * The second half of the outcome only when it adds information. A recorded
   * failure reason always does. A verdict does *not* when the state word already
   * says it: an accepted run is `Completed`, and a run waiting at the human
   * acceptance gate already got past its reviewer — repeating `Approved` there
   * would read as a second, contradictory state.
   */
  const showVerdict =
    verdictWord !== null &&
    !(verdict === "APPROVE" && run.status === "COMPLETED") &&
    outcomeWord !== "Ready for final approval";
  const detail =
    run.status === "FAILED" && run.failureReason
      ? truncate(run.failureReason, 100)
      : showVerdict
        ? verdictWord
        : null;
  const outcomeParts = [outcomeWord];
  if (detail) outcomeParts.push(detail);
  const durationMs = runDurationMs(run);
  const inProgress =
    run.status === "RUNNING" ||
    run.status === "WAITING_APPROVAL" ||
    run.status === "WAITING_INPUT" ||
    run.status === "DRAFT";
  const duration =
    durationMs !== null
      ? formatDuration(durationMs)
      : inProgress
        ? "In progress"
        : "—";
  const agents = Object.entries(run.roleMapping)
    .map(
      ([role, agentId]) =>
        `${roleDisplayName(role)}: ${context.agentNames[agentId] ?? agentId}`,
    )
    .join(" · ");
  return {
    id: run.id,
    project: context.projectNames[run.projectId] ?? run.projectId,
    goal: run.goal,
    outcome: outcomeParts.join(" · "),
    outcomeWord,
    outcomeDetail: detail,
    status: run.status,
    tone:
      run.status === "COMPLETED"
        ? "success"
        : run.status === "RUNNING"
          ? "active"
          : run.status === "FAILED" || run.status === "INTERRUPTED"
            ? "danger"
            : run.status === "WAITING_APPROVAL" ||
                run.status === "WAITING_INPUT"
              ? "warn"
              : "muted",
    when: formatTimestamp(run.createdAt),
    updated: relativeTime(run.updatedAt, now),
    duration,
    branch: run.branch ?? "not recorded",
    agents: agents || "no roles mapped",
    technical: [
      ["Run ID", run.id],
      ["Status", run.status],
      ["Template", `${run.templateId} v${run.templateVersion}`],
      ["Project root", run.projectRoot],
      ["Created", run.createdAt],
      ["Updated", run.updatedAt],
      ["Started", text(run.startedAt)],
      ["Ended", text(run.endedAt)],
      ["Duration", duration],
      ["Verdict", verdict ?? "not recorded"],
      [
        "Role mapping",
        Object.entries(run.roleMapping)
          .map(([role, agentId]) => `${role}: ${agentId}`)
          .join(" · ") || "none",
      ],
      ["Review cycle", `${run.reviewCycle} of ${run.policy.maxReviewCycles}`],
    ],
  };
}

/**
 * A human sentence for the advanced filters, so the query the server received is
 * described rather than printed as a raw query string.
 */
export function searchSummary(
  form: {
    q: string;
    projectId: string;
    agentId: string;
    status: string;
    branch: string;
    verdict: string;
    from: string;
    to: string;
  },
  projectNames: Record<string, string>,
  agentNames: Record<string, string>,
): string[] {
  const parts: string[] = [];
  if (form.q.trim()) parts.push(`goal contains “${form.q.trim()}”`);
  if (form.projectId)
    parts.push(`project ${projectNames[form.projectId] ?? form.projectId}`);
  if (form.agentId)
    parts.push(`agent ${agentNames[form.agentId] ?? form.agentId}`);
  if (form.status) parts.push(`status ${statusLabel(form.status)}`);
  if (form.branch.trim()) parts.push(`branch “${form.branch.trim()}”`);
  if (form.verdict)
    parts.push(`verdict ${form.verdict.toLowerCase().replace(/_/g, " ")}`);
  if (form.from) parts.push(`created on or after ${form.from}`);
  if (form.to) parts.push(`created on or before ${form.to}`);
  return parts;
}

export interface PlanSummary {
  /** Stage names in execution order, loop stages excluded. */
  names: string[];
  /** How many dormant loop stages (fix / re-verification) the plan carries. */
  branchCount: number;
  /** The human gate's own name, or `null` when the plan has none. */
  humanGate: string | null;
}

/**
 * The plan in plain words: what will run, in order, without keys, kinds, roles
 * or instructions. The exact frozen stages stay available in the technical
 * disclosure, which is where an auditor wants them.
 */
export function planSummary(plan: StagePlan): PlanSummary {
  const ordered = [...plan.stages].sort((a, b) => a.orderIndex - b.orderIndex);
  return {
    names: ordered
      .filter((stage) => stage.loop === null)
      .map((stage) => stage.name),
    branchCount: ordered.filter((stage) => stage.loop !== null).length,
    humanGate:
      ordered.find((stage) => stage.kind === "final_approval")?.name ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Guided workflow                                                     */
/* ------------------------------------------------------------------ */

export const WIZARD_STEPS = [
  { id: "project", label: "Project & goal", hint: "What the run works on." },
  { id: "team", label: "Team", hint: "Which agent owns each role." },
  { id: "plan", label: "Plan", hint: "The stages that will be frozen." },
  {
    id: "policy",
    label: "Policy & approvals",
    hint: "The rules the run cannot bypass.",
  },
  {
    id: "review",
    label: "Review and start",
    hint: "Create the draft, then start it.",
  },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

export const WIZARD_LAST_STEP = WIZARD_STEPS.length - 1;

export interface PolicyAcknowledgement {
  id: string;
  label: string;
  detail: string;
}

/**
 * The acknowledgements the operator must tick before a draft can be created.
 * They describe what the engine will actually do, and they are never
 * pre-checked: the run's own gates and the OS privileges of the launched CLIs
 * are not optional, so neither is reading them.
 */
export const POLICY_ACKNOWLEDGEMENTS: readonly PolicyAcknowledgement[] = [
  {
    id: "human-gates",
    label:
      "I understand every human gate stays mandatory, including final acceptance.",
    detail:
      "The run stops at each approval gate and at the final acceptance gate. No agent can close a run, and no override skips final verification or final acceptance.",
  },
  {
    id: "agent-privileges",
    label:
      "I understand configured agents run with my OS privileges and are not sandboxed.",
    detail:
      "AgentOps records what it launches and what came back. The CLIs you configure inherit your user account's access to this machine.",
  },
  {
    id: "verification",
    label:
      "I understand the verification commands this project defines are what the run will execute.",
    detail:
      "Verification runs the project's configured executable and argument array. A project with no commands records an unavailable outcome instead of a pass.",
  },
];

export interface WizardInput {
  projectId: string;
  goal: string;
  constraintsText: string;
  templateId: string;
  roleMapping: Record<string, string>;
  acknowledgements: string[];
}

/** Errors for one step only, so each step validates on its own terms. */
export function wizardStepErrors(
  step: WizardStepId,
  input: WizardInput,
  context: {
    requiredRoles: readonly string[];
    availableAgentIds: readonly string[];
  },
): Record<string, string> {
  const errors: Record<string, string> = {};
  switch (step) {
    case "project":
      if (!input.projectId) errors["projectId"] = "Choose a registered project";
      if (!input.goal.trim())
        errors["goal"] = "Describe what this run should accomplish";
      break;
    case "team":
      for (const role of context.requiredRoles) {
        const agentId = input.roleMapping[role];
        if (!agentId) {
          errors[`roleMapping.${role}`] = `Assign an agent to ${role}`;
          continue;
        }
        if (!context.availableAgentIds.includes(agentId))
          errors[`roleMapping.${role}`] =
            `That agent is no longer enabled for ${role}`;
      }
      if (context.requiredRoles.length === 0)
        errors["roleMapping"] = "Choose a workflow template first";
      break;
    case "plan":
      if (!input.templateId)
        errors["templateId"] = "Choose a workflow template";
      break;
    case "policy": {
      const missing = POLICY_ACKNOWLEDGEMENTS.filter(
        (entry) => !input.acknowledgements.includes(entry.id),
      );
      if (missing.length > 0)
        errors["acknowledgements"] =
          "Every policy and security acknowledgement must be confirmed";
      break;
    }
    case "review":
      if (!input.projectId) errors["projectId"] = "Choose a registered project";
      if (!input.goal.trim())
        errors["goal"] = "Describe what this run should accomplish";
      if (!input.templateId)
        errors["templateId"] = "Choose a workflow template";
      for (const role of context.requiredRoles) {
        if (!input.roleMapping[role])
          errors[`roleMapping.${role}`] = `Assign an agent to ${role}`;
      }
      if (
        POLICY_ACKNOWLEDGEMENTS.some(
          (entry) => !input.acknowledgements.includes(entry.id),
        )
      )
        errors["acknowledgements"] =
          "Every policy and security acknowledgement must be confirmed";
      break;
    default:
      break;
  }
  return errors;
}

/** The first step that still has errors, or `null` when the flow is complete. */
export function firstIncompleteStep(
  input: WizardInput,
  context: {
    requiredRoles: readonly string[];
    availableAgentIds: readonly string[];
  },
): WizardStepId | null {
  for (const step of WIZARD_STEPS) {
    if (Object.keys(wizardStepErrors(step.id, input, context)).length > 0)
      return step.id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Device settings                                                     */
/* ------------------------------------------------------------------ */

export interface LocalServiceView {
  /** Where this client is actually served from. */
  origin: string;
  host: string;
  port: string;
  /** Short state word, safe to render in a pill: `Connected` / `Not reachable`. */
  status: string;
  /** The sentence behind the state word. */
  statusDetail: string;
  statusTone: Tone;
  version: string;
  dataDirectory: {
    available: boolean;
    label: string;
    detail: string;
  };
}

export interface LocationLike {
  protocol: string;
  hostname: string;
  port: string;
  origin?: string;
}

/**
 * What this screen may say about the local service.
 *
 * The address and port are read from the page's own location — that is the
 * server that served this client, not a guess. The data directory is *not*
 * exposed by the local API, so it is reported as unavailable instead of being
 * invented or read from a build-time constant.
 */
export function localServiceView(input: {
  location: LocationLike;
  version: string | null;
  reachable: boolean;
  error: string | null;
}): LocalServiceView {
  const { location } = input;
  const host = location.hostname || "localhost";
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  const origin =
    location.origin ??
    `${location.protocol}//${location.hostname || "localhost"}${location.port ? `:${location.port}` : ""}`;
  return {
    origin,
    host,
    port,
    status: input.reachable ? "Connected" : "Not reachable",
    statusDetail: input.reachable
      ? "This page was served by the local AgentOps server, which is the only server it talks to."
      : `The local AgentOps server did not answer${input.error ? `: ${input.error}` : "."}`,
    statusTone: input.reachable ? "muted" : "danger",
    version: input.version ?? UNKNOWN,
    dataDirectory: {
      available: false,
      label: "Not exposed by the local API",
      detail:
        "The local AgentOps API has no endpoint that reports its database or log directory, so this screen cannot show it. Run the server yourself to see the path it was started with.",
    },
  };
}
