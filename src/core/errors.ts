export type AgentOpsErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "guard_failed"
  | "unavailable"
  | "internal";

export class AgentOpsError extends Error {
  readonly code: AgentOpsErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentOpsErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentOpsError";
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends AgentOpsError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("not_found", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AgentOpsError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, details);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AgentOpsError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("validation", message, details);
    this.name = "ValidationError";
  }
}

export class GuardError extends AgentOpsError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("guard_failed", message, details);
    this.name = "GuardError";
  }
}

export class UnavailableError extends AgentOpsError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("unavailable", message, details);
    this.name = "UnavailableError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
