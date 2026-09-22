/**
 * Shared test fixtures for the core/db/mock suites.
 *
 * Every harness uses `node:sqlite` in-memory databases (or an explicit temp file
 * when restart behaviour is under test) and the deterministic mock adapter.
 * No test in this repository contacts an AI provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/core/index.js";
import type {
  AgentRecord,
  CommandSpec,
  GitCheckpointSummary,
  RunDetail,
  RunStatus,
  StageRecord,
  StageStatus,
  AttemptRecord,
  VerificationOutcome,
  VerificationExecutor,
  VerificationInput,
  SnapshotInput,
  SnapshotProvider,
} from "../src/core/index.js";
import type { MockScenario } from "../src/adapters/agents/mock.js";
import { Store } from "../src/db/index.js";

/**
 * Roles the built-in templates map to agents. `planner` opens the
 * implement-review plan stage; `implementer` also runs the research experiment.
 */
export const ALL_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "researcher",
  "documenter",
] as const;
export type TestRole = (typeof ALL_ROLES)[number];

export const DEFAULT_VERIFICATION_COMMANDS: CommandSpec[] = [
  {
    name: "test",
    executable: "npm",
    args: ["test"],
    cwd: null,
    timeoutMs: 60_000,
  },
];

export interface HarnessOptions {
  /** Scenario per role; unspecified roles default to 'success'. */
  scenarios?: Partial<Record<TestRole, MockScenario>>;
  /** Extra mock configuration per role (merged over the scenario). */
  agentConfig?: Partial<Record<TestRole, Record<string, unknown>>>;
  verification?: VerificationExecutor;
  snapshots?: SnapshotProvider;
  /** File-backed database when restart behaviour is under test. */
  dbPath?: string;
  recoverOnStart?: boolean;
  verificationCommands?: CommandSpec[];
  now?: () => string;
  /** Reuse an existing store (restart simulation). */
  store?: Store;
}

export interface Harness {
  store: Store;
  engine: Engine;
  projectId: string;
  projectRoot: string;
  agents: Record<TestRole, AgentRecord>;
  agentIds: Record<string, string>;
  makeRun(
    templateId: string,
    goal: string,
    options?: {
      constraints?: string[];
      roles?: Partial<Record<TestRole, string>>;
    },
  ): Promise<RunDetail>;
  close(): Promise<void>;
}

const tempRoots: string[] = [];

export function tempDir(prefix = "agentops-test"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const projectRoot = tempDir("agentops-repo");
  const store =
    options.store ??
    (options.dbPath
      ? new Store({ path: options.dbPath, now: options.now })
      : Store.memory(options.now ? { now: options.now } : {}));

  const agents = {} as Record<TestRole, AgentRecord>;
  const agentIds: Record<string, string> = {};
  for (const role of ALL_ROLES) {
    const agent = store.createAgent({
      name: `mock-${role}`,
      adapterKind: "mock",
      roleHint: role,
      model: "mock-model",
      config: {
        scenario: options.scenarios?.[role] ?? "success",
        ...(options.agentConfig?.[role] ?? {}),
      },
    });
    agents[role] = agent;
    agentIds[role] = agent.id;
  }

  const project = store.createProject({
    name: "fixture-project",
    canonicalRoot: projectRoot,
    verificationCommands:
      options.verificationCommands ?? DEFAULT_VERIFICATION_COMMANDS,
  });

  const engine = new Engine({
    store,
    recoverOnStart: options.recoverOnStart ?? true,
    seedTemplates: true,
    ...(options.verification ? { verification: options.verification } : {}),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    store,
    engine,
    projectId: project.id,
    projectRoot,
    agents,
    agentIds,
    async makeRun(templateId, goal, runOptions = {}) {
      return engine.createRun({
        projectId: project.id,
        templateId,
        goal,
        agents: { ...agentIds, ...(runOptions.roles ?? {}) },
        constraints: runOptions.constraints ?? [],
      });
    },
    async close() {
      await engine.shutdown();
    },
  };
}

/** Programmable verification executor. The last result repeats once exhausted. */
export class FakeVerificationExecutor implements VerificationExecutor {
  readonly kind = "fake";
  readonly calls: VerificationInput[] = [];
  private readonly results: VerificationOutcome[];

  constructor(
    results: VerificationOutcome | VerificationOutcome[] = [
      passedVerification(),
    ],
  ) {
    this.results = Array.isArray(results) ? [...results] : [results];
    if (this.results.length === 0) this.results.push(passedVerification());
  }

  async run(input: VerificationInput): Promise<VerificationOutcome> {
    this.calls.push(input);
    const next =
      this.results.length > 1
        ? (this.results.shift() as VerificationOutcome)
        : (this.results[0] as VerificationOutcome);
    if (next.status === "unavailable" && next.reason === "throw") {
      throw new Error("fake verification executor exploded");
    }
    return next;
  }
}

export function passedVerification(
  summary = "fake verification passed",
): VerificationOutcome {
  return {
    status: "passed",
    summary,
    mode: "fake",
    counts: { passed: 3, failed: 0, skipped: 1, total: 4 },
    commands: [
      {
        spec: DEFAULT_VERIFICATION_COMMANDS[0] as CommandSpec,
        status: "passed",
        exitCode: 0,
        durationMs: 12,
        stdoutExcerpt: "ok 3 tests",
        stderrExcerpt: "",
        framework: "node:test",
        counts: { passed: 3, failed: 0, skipped: 1, total: 4 },
        parsedConfidently: true,
        summary: "3 passed",
      },
    ],
  };
}

export function failedVerification(
  summary = "fake verification failed",
): VerificationOutcome {
  return {
    status: "failed",
    summary,
    mode: "fake",
    counts: { passed: 1, failed: 2, skipped: 0, total: 3 },
    commands: [
      {
        spec: DEFAULT_VERIFICATION_COMMANDS[0] as CommandSpec,
        status: "failed",
        exitCode: 1,
        durationMs: 15,
        stdoutExcerpt: "not ok 1 failing test",
        stderrExcerpt: "AssertionError: expected 1 to equal 2",
        framework: "node:test",
        counts: { passed: 1, failed: 2, skipped: 0, total: 3 },
        parsedConfidently: true,
        summary: "1 passed, 2 failed",
      },
    ],
  };
}

export class FakeSnapshotProvider implements SnapshotProvider {
  readonly kind = "fake";
  readonly calls: SnapshotInput[] = [];
  private counter = 0;
  private readonly result: "checkpoint" | "null";

  constructor(result: "checkpoint" | "null" = "checkpoint") {
    this.result = result;
  }

  async capture(input: SnapshotInput): Promise<GitCheckpointSummary | null> {
    this.calls.push(input);
    if (this.result === "null") return null;
    this.counter += 1;
    return {
      headSha: `sha-${String(this.counter).padStart(4, "0")}`,
      branch: "main",
      detached: false,
      dirty: input.phase === "after",
      staged: [],
      unstaged: input.phase === "after" ? ["src/index.ts"] : [],
      untracked: [],
      diffStat:
        input.phase === "after" ? "1 file changed, 3 insertions(+)" : null,
      localCommits: [],
      ahead: 0,
      behind: 0,
      capturedAt: `2026-01-01T00:00:0${Math.min(this.counter, 9)}.000Z`,
    };
  }
}

/* ------------------------------ assertions ------------------------------ */

export function stageOf(detail: RunDetail, key: string): StageRecord {
  const stage = detail.stages.find((candidate) => candidate.key === key);
  if (!stage)
    throw new Error(
      `stage ${key} not found (have: ${detail.stages.map((s) => s.key).join(", ")})`,
    );
  return stage;
}

export function attemptsOf(
  detail: RunDetail,
  stageKey: string,
): AttemptRecord[] {
  return detail.attempts.filter((attempt) => attempt.stageKey === stageKey);
}

export function attemptOf(
  detail: RunDetail,
  stageKey: string,
  attemptNumber: number,
): AttemptRecord {
  const attempt = attemptsOf(detail, stageKey).find(
    (candidate) => candidate.attemptNumber === attemptNumber,
  );
  if (!attempt)
    throw new Error(`attempt ${attemptNumber} of stage ${stageKey} not found`);
  return attempt;
}

export function eventTypes(detail: RunDetail): string[] {
  return detail.events.map((event) => event.type);
}

export function eventsOf(detail: RunDetail, type: string) {
  return detail.events.filter((event) => event.type === type);
}

export function statusesOf(detail: RunDetail): Record<string, string> {
  return Object.fromEntries(
    detail.stages.map((stage) => [stage.key, stage.status]),
  );
}

export async function startAndWait(
  engine: Engine,
  runId: string,
  statuses: readonly RunStatus[] = [
    "WAITING_APPROVAL",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
    "CANCELLED",
    "WAITING_INPUT",
  ],
): Promise<RunDetail> {
  const started = engine.startRun(runId);
  await engine.waitForStatus(runId, statuses);
  await started.catch(() => undefined);
  const detail = engine.getRun(runId);
  if (!detail) throw new Error(`run ${runId} disappeared`);
  return detail;
}

export function reload(engine: Engine, runId: string): RunDetail {
  const detail = engine.getRun(runId);
  if (!detail) throw new Error(`run ${runId} disappeared`);
  return detail;
}

/**
 * Poll until a specific stage reaches one of `statuses` (or time out).
 *
 * Needed because a run reports RUNNING from its very first stage: tests that used
 * to wait for the run status now have to wait for the stage they actually assert on.
 */
export async function waitForStageStatus(
  engine: Engine,
  runId: string,
  stageKey: string,
  statuses: readonly StageStatus[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<RunDetail> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 2;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = engine.getRun(runId);
    if (!detail) throw new Error(`run ${runId} disappeared`);
    const stage = detail.stages.find((candidate) => candidate.key === stageKey);
    if (stage && statuses.includes(stage.status)) return detail;
    if (Date.now() > deadline) {
      throw new Error(
        `stage ${stageKey} of run ${runId} did not reach ${statuses.join("|")} within ${timeoutMs}ms (status ${stage?.status ?? "missing"})`,
      );
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  }
}
