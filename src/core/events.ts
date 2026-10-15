/**
 * The event model, and the validation every ingested event passes through.
 *
 * This is the whole domain. An agent — Claude Code, Codex, OpenCode, a Google
 * or OpenRouter client, a shell script — describes what it is doing as a stream
 * of these, and the constellation draws them. Two fields are required:
 *
 *     { "actor": "claude-code", "action": "tool_call" }
 *
 * Everything else is optional and makes the picture richer. Nothing is ever
 * inferred that the sender did not say: an absent field renders as an absence,
 * never as a guess.
 *
 * This module is dependency-free apart from redaction and is pure, so the whole
 * contract is asserted in `tests/events.test.ts`.
 */
import { redactSecrets } from "./redaction.js";

/** Lifecycle of the work an event describes. */
export const EVENT_STATUSES = ["running", "ok", "error", "blocked"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** A finding an agent wants shown with its verdict. */
export interface EventIssue {
  description: string;
  severity: string | null;
  path: string | null;
  line: number | null;
}

/** An accepted event, after validation and redaction. */
export interface IngestedEvent {
  /** Who acted. One star in the field. Required. */
  actor: string;
  /** What they did. Free-form: "tool_call", "review", "spawn", "reply". Required. */
  action: string;
  /** The conversation this belongs to, when the sender tracks one. */
  session: string | null;
  /** Where the actor runs: "claude", "openai", "opencode", "google", … */
  provider: string | null;
  /** Another actor this one handed work to. Draws a handoff edge. */
  target: string | null;
  /** The actor that spawned this one. Draws a spawn edge. */
  parent: string | null;
  /** The one line a human should read. */
  summary: string | null;
  status: EventStatus | null;
  /** Free-form: "approve", "reject", "needs-fixes", "pass", "fail", … */
  verdict: string | null;
  issues: EventIssue[];
  /** Anything else the sender wanted to keep, shown on demand. */
  detail: Record<string, unknown>;
}

/** A stored event: what was ingested, plus the stream's own cursor. */
export interface EventRecord extends IngestedEvent {
  id: number;
  createdAt: string;
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const LIMITS = {
  actor: 200,
  action: 200,
  session: 200,
  provider: 80,
  target: 200,
  parent: 200,
  summary: 2000,
  verdict: 100,
  description: 2000,
  path: 1000,
  issues: 50,
  detailBytes: 16_384,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a string field. Secrets are stripped before anything is stored: an
 * agent pasting a prompt or a command line into `summary` must not turn this
 * viewer into a place credentials accumulate.
 */
function readString(
  raw: unknown,
  key: string,
  max: number,
  errors: string[],
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    errors.push(`${key} must be a string when present`);
    return null;
  }
  const clean = redactSecrets(raw).trim();
  if (clean.length === 0) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function readIssues(raw: unknown, errors: string[]): EventIssue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push("issues must be an array when present");
    return [];
  }
  const issues: EventIssue[] = [];
  for (const [index, item] of raw.slice(0, LIMITS.issues).entries()) {
    if (!isPlainObject(item)) {
      errors.push(`issues[${index}] must be an object`);
      continue;
    }
    const description = readString(
      item["description"],
      `issues[${index}].description`,
      LIMITS.description,
      errors,
    );
    if (!description) {
      errors.push(`issues[${index}].description is required`);
      continue;
    }
    const line = item["line"];
    issues.push({
      description,
      severity: readString(
        item["severity"],
        `issues[${index}].severity`,
        40,
        errors,
      ),
      path: readString(
        item["path"],
        `issues[${index}].path`,
        LIMITS.path,
        errors,
      ),
      line:
        typeof line === "number" && Number.isFinite(line)
          ? Math.trunc(line)
          : null,
    });
  }
  return issues;
}

/**
 * Validates one posted event.
 *
 * Unknown top-level keys are not an error: they are folded into `detail`, so a
 * sender can be richer than this schema without being rejected. That keeps the
 * quickstart honest — an agent can throw its own fields in and see them again.
 */
export function validateEvent(raw: unknown): Validation<IngestedEvent> {
  if (!isPlainObject(raw))
    return { ok: false, errors: ["an event must be a JSON object"] };

  const errors: string[] = [];
  const actor = readString(raw["actor"], "actor", LIMITS.actor, errors);
  if (!actor) errors.push("actor is required: name the agent that acted");
  const action = readString(raw["action"], "action", LIMITS.action, errors);
  if (!action) errors.push("action is required: name what it did");

  let status: EventStatus | null = null;
  const statusRaw = raw["status"];
  if (statusRaw !== undefined && statusRaw !== null) {
    const candidate = String(statusRaw).trim().toLowerCase();
    if ((EVENT_STATUSES as readonly string[]).includes(candidate))
      status = candidate as EventStatus;
    else errors.push(`status must be one of ${EVENT_STATUSES.join(", ")}`);
  }

  const known = new Set([
    "actor",
    "action",
    "session",
    "provider",
    "target",
    "parent",
    "summary",
    "status",
    "verdict",
    "issues",
    "detail",
  ]);
  const detailRaw = raw["detail"];
  if (
    detailRaw !== undefined &&
    detailRaw !== null &&
    !isPlainObject(detailRaw)
  )
    errors.push("detail must be an object when present");
  const detail: Record<string, unknown> = {
    ...(isPlainObject(detailRaw) ? detailRaw : {}),
  };
  for (const [key, value] of Object.entries(raw))
    if (!known.has(key)) detail[key] = value;

  const issues = readIssues(raw["issues"], errors);

  let safeDetail: Record<string, unknown> = {};
  try {
    const serialized = redactSecrets(JSON.stringify(detail) ?? "{}");
    if (Buffer.byteLength(serialized) > LIMITS.detailBytes)
      errors.push(
        `detail is larger than ${LIMITS.detailBytes} bytes: send a reference, not a payload`,
      );
    else safeDetail = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    errors.push("detail must be JSON-serializable");
  }

  if (errors.length > 0 || !actor || !action) return { ok: false, errors };

  return {
    ok: true,
    value: {
      actor,
      action,
      session: readString(raw["session"], "session", LIMITS.session, errors),
      provider: readString(
        raw["provider"],
        "provider",
        LIMITS.provider,
        errors,
      ),
      target: readString(raw["target"], "target", LIMITS.target, errors),
      parent: readString(raw["parent"], "parent", LIMITS.parent, errors),
      summary: readString(raw["summary"], "summary", LIMITS.summary, errors),
      status,
      verdict: readString(raw["verdict"], "verdict", LIMITS.verdict, errors),
      issues,
      detail: safeDetail,
    },
  };
}

/**
 * The tone a free-form verdict reads as.
 *
 * Senders are not made to learn an enum, so the common vocabularies are
 * recognised and anything unrecognised stays neutral rather than being
 * reported as a failure the sender never claimed.
 */
export function verdictTone(
  verdict: string | null,
  status: EventStatus | null = null,
): "success" | "warn" | "danger" | "neutral" {
  const value = (verdict ?? "").toLowerCase();
  if (/\b(approve|approved|accept|pass|passed|ok|success|lgtm)\b/.test(value))
    return "success";
  if (/\b(fix|fixes|changes|warn|warning|minor|partial|nit)\b/.test(value))
    return "warn";
  if (/\b(reject|rejected|fail|failed|block|blocked|error|deny)\b/.test(value))
    return "danger";
  if (status === "error") return "danger";
  if (status === "blocked") return "warn";
  return "neutral";
}
