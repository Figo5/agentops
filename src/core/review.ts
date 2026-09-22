import type {
  ReviewIssue,
  ReviewSeverity,
  ReviewVerdict,
  ReviewVerdictKind,
} from "./types.js";
import { REVIEW_SEVERITIES, REVIEW_VERDICTS } from "./types.js";

export interface ReviewValidationOk {
  ok: true;
  verdict: ReviewVerdict;
  /** What the adapter actually returned, JSON-serialized for the audit log. */
  raw: string;
}

export interface ReviewValidationFailure {
  ok: false;
  errors: string[];
  /** What the adapter actually returned, JSON-serialized for the audit log. */
  raw: string;
}

export type ReviewValidation = ReviewValidationOk | ReviewValidationFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIssue(
  value: unknown,
  index: number,
  errors: string[],
): ReviewIssue | null {
  if (!isPlainObject(value)) {
    errors.push(`issues[${index}] must be an object`);
    return null;
  }
  const description = value["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push(`issues[${index}].description must be a non-empty string`);
    return null;
  }
  const severityRaw = value["severity"];
  let severity: ReviewSeverity = "major";
  if (typeof severityRaw === "string") {
    const candidate = severityRaw.trim().toLowerCase();
    if ((REVIEW_SEVERITIES as readonly string[]).includes(candidate)) {
      severity = candidate as ReviewSeverity;
    } else {
      errors.push(
        `issues[${index}].severity must be one of ${REVIEW_SEVERITIES.join(", ")}`,
      );
      return null;
    }
  } else if (severityRaw !== undefined && severityRaw !== null) {
    errors.push(`issues[${index}].severity must be a string`);
    return null;
  }

  const issue: ReviewIssue = { severity, description: description.trim() };

  const path = value["path"];
  if (typeof path === "string") {
    issue.path = path;
  } else if (path !== undefined && path !== null) {
    errors.push(`issues[${index}].path must be a string when present`);
    return null;
  }

  const line = value["line"];
  if (typeof line === "number" && Number.isFinite(line)) {
    issue.line = line;
  } else if (line !== undefined && line !== null) {
    errors.push(`issues[${index}].line must be a number when present`);
    return null;
  }

  return issue;
}

/**
 * Validate a raw review payload returned by an agent adapter.
 *
 * Exit code zero is never treated as approval: a review stage only progresses
 * on a verdict that passes this validation.
 */
export function validateReviewVerdict(raw: unknown): ReviewValidation {
  const serialize = (value: unknown): string => {
    try {
      return JSON.stringify(value ?? null) ?? "null";
    } catch {
      return '"[unserializable]"';
    }
  };

  if (raw === undefined || raw === null) {
    return {
      ok: false,
      errors: ["review payload is missing: exit code alone is not a verdict"],
      raw: serialize(raw),
    };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: ["review payload must be an object"],
      raw: serialize(raw),
    };
  }

  const errors: string[] = [];

  const verdictRaw = raw["verdict"];
  let verdict: ReviewVerdictKind | null = null;
  if (typeof verdictRaw !== "string") {
    errors.push("verdict must be a string");
  } else {
    const candidate = verdictRaw
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    if ((REVIEW_VERDICTS as readonly string[]).includes(candidate)) {
      verdict = candidate as ReviewVerdictKind;
    } else if (candidate === "APPROVED") {
      verdict = "APPROVE";
    } else if (
      candidate === "REQUEST_CHANGES" ||
      candidate === "CHANGES_REQUESTED"
    ) {
      verdict = "APPROVE_WITH_FIXES";
    } else {
      errors.push(
        `verdict must be one of ${REVIEW_VERDICTS.join(", ")} (received ${serialize(verdictRaw)})`,
      );
    }
  }

  const summaryRaw = raw["summary"];
  const summary = typeof summaryRaw === "string" ? summaryRaw.trim() : "";
  if (summary.length === 0) {
    errors.push("summary must be a non-empty string");
  }

  const issues: ReviewIssue[] = [];
  const issuesRaw = raw["issues"];
  if (issuesRaw !== undefined && issuesRaw !== null) {
    if (!Array.isArray(issuesRaw)) {
      errors.push("issues must be an array when present");
    } else {
      issuesRaw.forEach((item, index) => {
        const issue = normalizeIssue(item, index, errors);
        if (issue) issues.push(issue);
      });
    }
  }

  // A "fixes" verdict without any stated issue is not actionable.
  if (verdict === "APPROVE_WITH_FIXES" && issues.length === 0) {
    errors.push("APPROVE_WITH_FIXES requires at least one valid issue");
  }

  let confidence: number | null = null;
  const confidenceRaw = raw["confidence"];
  if (typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)) {
    if (confidenceRaw < 0 || confidenceRaw > 1) {
      errors.push("confidence must be between 0 and 1");
    } else {
      confidence = confidenceRaw;
    }
  } else if (confidenceRaw !== undefined && confidenceRaw !== null) {
    errors.push("confidence must be a number between 0 and 1 when present");
  }

  const reviewerRaw = raw["reviewer"];
  let reviewer: string | null = null;
  if (typeof reviewerRaw === "string" && reviewerRaw.trim().length > 0) {
    reviewer = reviewerRaw.trim();
  } else if (reviewerRaw !== undefined && reviewerRaw !== null) {
    errors.push("reviewer must be a non-empty string when present");
  }

  if (errors.length > 0 || verdict === null) {
    return { ok: false, errors, raw: serialize(raw) };
  }

  const validated: ReviewVerdict = { verdict, summary, issues };
  if (confidence !== null) validated.confidence = confidence;
  if (reviewer !== null) validated.reviewer = reviewer;
  return { ok: true, verdict: validated, raw: serialize(raw) };
}

/** Render a validated verdict as a compact, prompt-safe line. */
export function formatReviewVerdict(verdict: ReviewVerdict): string {
  const issues =
    verdict.issues.length === 0 ? "" : ` issues=${verdict.issues.length}`;
  return `${verdict.verdict}: ${verdict.summary}${issues}`;
}
