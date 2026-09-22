/**
 * Public surface of the AgentOps database layer.
 *
 * `src/db` owns versioned SQL migrations and repositories. Domain types are
 * re-exported here so consumers can import `Store` and the types it speaks in
 * from a single module.
 */
export { Store } from "./store.js";
export type {
  AppendEventInput,
  AttemptPatch,
  CreateAgentInput,
  CreateApprovalInput,
  CreateAttemptInput,
  CreateProjectInput,
  CreateRunRowInput,
  CreateTaskInput,
  InsertArtifactInput,
  InsertGitSnapshotInput,
  InsertReviewVerdictInput,
  InsertShellCommandInput,
  InsertTestRunInput,
  RunPatch,
  StagePatch,
  StoreOptions,
  TaskPatch,
} from "./store.js";
export {
  MIGRATIONS,
  LATEST_MIGRATION_VERSION,
  appliedMigrations,
  migrate,
  schemaVersion,
  tableNames,
} from "./migrations.js";
export type { Migration, MigrateOptions, MigrateResult } from "./migrations.js";

// Common domain types, re-exported for convenience.
export * from "../core/types.js";
