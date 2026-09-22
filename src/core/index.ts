/**
 * Public surface of the AgentOps core.
 *
 * `src/core` owns domain types, pure transition rules, prompt construction and
 * the persisted engine. It has no dependency on the server or UI layers.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./redaction.js";
export * from "./review.js";
export * from "./transitions.js";
export * from "./templates.js";
export * from "./prompts.js";
export * from "./mutex.js";
export {
  Engine,
  FailClosedVerificationExecutor,
  PassThroughVerificationExecutor,
  NoopSnapshotProvider,
  validateArtifactRef,
} from "./engine.js";
export type {
  CreateRunInput,
  DecideApprovalOptions,
  DriverOutcome,
  EngineOptions,
  SnapshotInput,
  SnapshotProvider,
  VerificationCommandOutcome,
  VerificationExecutor,
  VerificationInput,
  VerificationOutcome,
} from "./engine.js";
