/**
 * Versioned SQL migrations for the AgentOps database.
 *
 * Rules:
 *  - migrations are append-only; never edit an applied migration
 *  - each migration runs inside its own IMMEDIATE transaction
 *  - JSON is restricted to configurations, typed result metadata and details
 *  - no blobs: large payloads stay on disk outside SQLite
 */
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_CORE = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical_root TEXT NOT NULL UNIQUE,
  vcs TEXT NOT NULL DEFAULT 'git',
  default_branch TEXT,
  verification_commands TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role_hint TEXT,
  adapter_kind TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  default_max_review_cycles INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_stages (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  next_stage_key TEXT,
  loop TEXT,
  max_review_cycles INTEGER,
  conditional INTEGER NOT NULL DEFAULT 0,
  UNIQUE (template_id, key)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_root TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  constraints TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  role_mapping TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT '{}',
  stage_plan TEXT NOT NULL,
  next_stage_key TEXT,
  current_attempt_id TEXT,
  review_cycle INTEGER NOT NULL DEFAULT 1,
  epoch INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  cancel_reason TEXT,
  interrupt_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE run_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  order_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]',
  next_stage_key TEXT,
  loop TEXT,
  conditional INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  cycle INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  failure_reason TEXT,
  overridden INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, key)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, stage_key)
);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  reason TEXT,
  previous_attempt_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  adapter_kind TEXT,
  agent_session_id TEXT,
  prompt_packet TEXT,
  prompt_text TEXT,
  inputs TEXT NOT NULL DEFAULT '[]',
  result_status TEXT,
  result_summary TEXT,
  exit_code INTEGER,
  usage TEXT,
  usage_known INTEGER NOT NULL DEFAULT 0,
  artifacts TEXT NOT NULL DEFAULT '[]',
  review_verdict_id TEXT,
  verification TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT,
  stage_key TEXT,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'engine',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  handle TEXT NOT NULL DEFAULT '{}',
  cancel_reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  gate TEXT NOT NULL,
  status TEXT NOT NULL,
  allowed TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  requested_at TEXT NOT NULL,
  decision TEXT,
  instruction TEXT,
  actor TEXT,
  decided_at TEXT
);

CREATE TABLE review_verdicts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 1,
  valid INTEGER NOT NULL DEFAULT 0,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  verdict TEXT,
  summary TEXT,
  issues TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  reviewer TEXT,
  raw TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- One active (RUNNING/WAITING_*) run per project. DRAFT runs are not leased;
-- the DRAFT -> RUNNING transition re-checks this constraint transactionally.
CREATE UNIQUE INDEX idx_runs_single_active_per_project
  ON runs(project_id)
  WHERE status IN ('RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT');
CREATE INDEX idx_runs_project_status ON runs(project_id, status);
CREATE INDEX idx_events_run_id ON events(run_id, id);
CREATE INDEX idx_run_stages_run ON run_stages(run_id, order_index);
CREATE INDEX idx_tasks_run ON tasks(run_id);
CREATE INDEX idx_attempts_task ON task_attempts(task_id, attempt_number);
`;

const V2_PLANNED_RECORDS = `
CREATE TABLE shell_commands (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT,
  stage_key TEXT NOT NULL,
  test_run_id TEXT,
  name TEXT NOT NULL,
  executable TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT,
  stage_key TEXT NOT NULL,
  framework TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  total INTEGER,
  parsed_confidently INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE git_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  attempt_id TEXT,
  phase TEXT NOT NULL,
  head_sha TEXT,
  branch TEXT,
  detached INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0,
  staged_paths TEXT NOT NULL DEFAULT '[]',
  unstaged_paths TEXT NOT NULL DEFAULT '[]',
  untracked_paths TEXT NOT NULL DEFAULT '[]',
  diff_stat TEXT,
  local_commits TEXT NOT NULL DEFAULT '[]',
  ahead INTEGER,
  behind INTEGER,
  unavailable_reason TEXT,
  captured_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  attempt_id TEXT,
  stage_key TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  creator TEXT NOT NULL,
  exists_flag INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_runs_status_created ON runs(status, created_at);
CREATE INDEX idx_runs_created ON runs(created_at);
CREATE INDEX idx_attempts_run_stage ON task_attempts(run_id, stage_key);
CREATE INDEX idx_events_project ON events(project_id, id);
CREATE INDEX idx_events_run_category ON events(run_id, category, id);
CREATE INDEX idx_events_type ON events(run_id, type);
CREATE INDEX idx_agent_sessions_run ON agent_sessions(run_id, attempt_id);
CREATE INDEX idx_agent_sessions_live ON agent_sessions(status);
CREATE INDEX idx_approvals_run ON approvals(run_id, status);
CREATE INDEX idx_review_verdicts_run ON review_verdicts(run_id, cycle);
CREATE INDEX idx_git_snapshots_run ON git_snapshots(run_id, stage_key, phase);
CREATE INDEX idx_test_runs_run ON test_runs(run_id, stage_key);
CREATE INDEX idx_shell_commands_run ON shell_commands(run_id, stage_key);
CREATE INDEX idx_artifacts_run ON artifacts(run_id, stage_key);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "core", sql: V1_CORE },
  { version: 2, name: "planned_records", sql: V2_PLANNED_RECORDS },
];

export const LATEST_MIGRATION_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

export interface MigrateOptions {
  /** Apply only migrations with version <= upTo. Defaults to the latest known. */
  upTo?: number;
  now?: () => string;
}

export interface MigrateResult {
  applied: number[];
  version: number;
}

/**
 * Apply pending migrations. Safe to call on every startup; each migration is
 * applied at most once and inside its own transaction.
 */
export function migrate(
  db: DatabaseSync,
  options: MigrateOptions = {},
): MigrateResult {
  const target = options.upTo ?? LATEST_MIGRATION_VERSION;
  const now = options.now ?? (() => new Date().toISOString());

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  db.exec("PRAGMA foreign_keys = ON;");

  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const applied = new Set(appliedRows.map((row) => Number(row["version"])));
  const appliedNow: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version > target) break;
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, now());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure; the original error is what matters
      }
      throw error;
    }
    appliedNow.push(migration.version);
    applied.add(migration.version);
  }

  return { applied: appliedNow, version: schemaVersion(db) };
}

export function schemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const value = row?.["version"];
    return value === null || value === undefined ? 0 : Number(value);
  } catch {
    return 0;
  }
}

export function appliedMigrations(
  db: DatabaseSync,
): { version: number; name: string; appliedAt: string }[] {
  try {
    return db
      .prepare(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      )
      .all()
      .map((row) => ({
        version: Number(row["version"]),
        name: String(row["name"]),
        appliedAt: String(row["applied_at"]),
      }));
  } catch {
    return [];
  }
}

export function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row["name"]));
}
