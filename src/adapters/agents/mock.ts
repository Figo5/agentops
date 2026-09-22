/**
 * Deterministic mock agent adapter.
 *
 * Purpose: exercise the engine's state machine — happy path, failures, review
 * fix loops, rejections, input waits, cancellation and malformed review payloads —
 * without contacting any AI provider. This module performs no network I/O and
 * imports nothing that does.
 *
 * Scenarios:
 *   success               complete successfully (review stages approve)
 *   failure               fail immediately with exit code 1
 *   fixes                 review: APPROVE_WITH_FIXES on attempt 1, APPROVE afterwards
 *   rejection             review: REJECT
 *   failure-then-success  attempt 1 fails, attempt 2+ succeeds (retry path)
 *   long-running          never completes until cancelled
 *   input-required        emits AGENT_WAITING, resumes after sendInput
 *   malformed-review      review: payload that fails structured validation
 *   no-verdict            review: exit code 0 but no verdict at all
 *   unavailable           startTask throws (adapter/agent unavailable)
 *   unavailable-result    session starts but returns status 'unavailable'
 */
import { newId } from "../../core/ids.js";
import { sleep } from "../../core/mutex.js";
import type {
  AgentAdapter,
  AgentArtifactRef,
  AgentEvent,
  AgentRecord,
  AgentResult,
  AgentSession,
  AgentSessionStatus,
  AgentTaskConfig,
  AgentTaskPacket,
  Usage,
} from "../../core/types.js";

export type MockScenario =
  | "success"
  | "failure"
  | "fixes"
  | "rejection"
  | "failure-then-success"
  | "long-running"
  | "input-required"
  | "malformed-review"
  | "no-verdict"
  | "unavailable"
  | "unavailable-result";

export const MOCK_SCENARIOS: readonly MockScenario[] = [
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
];

export interface MockAgentOptions {
  scenario?: MockScenario;
  /** Artificial latency before the outcome is produced (0 keeps tests fast). */
  latencyMs?: number;
  /** Number of AGENT_OUTPUT events emitted before the outcome. */
  steps?: number;
  /** Number of AGENT_TOOL_CALL events emitted. */
  toolCalls?: number;
  /** Explicit usage; `null` means UNKNOWN. Defaults to a deterministic sample. */
  usage?: Usage | null;
  artifacts?: AgentArtifactRef[];
  /** Summary override. */
  summary?: string;
  exitCode?: number | null;
  /** For 'fixes': how many review attempts request fixes before approving. */
  fixAttempts?: number;
  /** For 'failure-then-success': first attempt number that succeeds. */
  succeedFromAttempt?: number;
  /** Prompt shown when the session waits for operator input. */
  inputPrompt?: string;
  /** Inject a failure for specific stage keys (e.g. ['review.fix']). */
  failStageKeys?: string[];
}

const DEFAULT_USAGE: Usage = {
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  costUsd: null,
  model: "mock-model",
};

function readOptions(
  config: Record<string, unknown> | undefined,
  overrides: MockAgentOptions = {},
): MockAgentOptions {
  const raw = (config ?? {}) as MockAgentOptions;
  const merged: MockAgentOptions = { ...raw, ...overrides };
  return merged;
}

function event(
  type: AgentEvent["type"],
  at: string,
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  return { type, at, ...extra };
}

class MockAgentSession implements AgentSession {
  readonly id: string;
  private readonly packet: AgentTaskPacket;
  private readonly options: MockAgentOptions;
  private readonly at: () => string;

  private status: AgentSessionStatus = "idle";
  private phase: "new" | "running" | "awaiting_input" | "done" = "new";
  private finalResult: AgentResult | null = null;
  private cancelled = false;
  private cancelReason: string | null = null;
  private readonly inputs: string[] = [];

  private readonly queue: AgentEvent[] = [];
  private readonly eventWaiters: ((value: AgentEvent | null) => void)[] = [];
  private readonly inputWaiters: (() => void)[] = [];
  private readonly cancelWaiters: (() => void)[] = [];
  private closed = false;

  constructor(
    packet: AgentTaskPacket,
    options: MockAgentOptions,
    now: () => string,
  ) {
    this.id = newId("session");
    this.packet = packet;
    this.options = options;
    this.at = now;
  }

  private emit(
    type: AgentEvent["type"],
    extra: Partial<AgentEvent> = {},
  ): void {
    const ev = event(type, this.at(), extra);
    const waiter = this.eventWaiters.shift();
    if (waiter) waiter(ev);
    else this.queue.push(ev);
  }

  private closeStream(): void {
    this.closed = true;
    while (this.eventWaiters.length > 0) {
      const waiter = this.eventWaiters.shift();
      waiter?.(null);
    }
  }

  private async nextEvent(): Promise<AgentEvent | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return null;
    return new Promise<AgentEvent | null>((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  async *streamEvents(): AsyncIterable<AgentEvent> {
    for (;;) {
      const next = await this.nextEvent();
      if (next === null) return;
      yield next;
    }
  }

  getStatus(): AgentSessionStatus {
    return this.status;
  }

  async sendInput(text: string): Promise<void> {
    this.inputs.push(text);
    while (this.inputWaiters.length > 0) {
      const waiter = this.inputWaiters.shift();
      waiter?.();
    }
  }

  async cancel(reason: string): Promise<void> {
    if (this.finalResult) return;
    this.cancelled = true;
    this.cancelReason = reason;
    this.status = "cancelled";
    this.emit("AGENT_CANCELLED", { stream: "system", message: reason });
    this.finish({
      status: "cancelled",
      summary: `mock agent cancelled: ${reason}`,
      exitCode: null,
      usage: null,
      error: null,
    });
    while (this.cancelWaiters.length > 0) {
      const waiter = this.cancelWaiters.shift();
      waiter?.();
    }
    while (this.inputWaiters.length > 0) {
      const waiter = this.inputWaiters.shift();
      waiter?.();
    }
  }

  private finish(result: AgentResult): AgentResult {
    if (!this.finalResult) {
      this.finalResult = result;
      if (result.status === "completed") this.status = "completed";
      else if (result.status === "failed") this.status = "failed";
      else if (result.status === "cancelled") this.status = "cancelled";
      else if (result.status === "unavailable") this.status = "failed";
      this.phase = "done";
      this.closeStream();
    }
    return this.finalResult;
  }

  private waitForCancel(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.cancelWaiters.push(resolve);
    });
  }

  private waitForInput(): Promise<void> {
    if (this.inputs.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.inputWaiters.push(resolve);
    });
  }

  private isReviewStage(): boolean {
    return this.packet.stageKind === "review";
  }

  private attemptNumber(): number {
    return this.packet.attemptNumber;
  }

  private reviewOutcome(): {
    review?: unknown;
    status: AgentResult["status"];
    summary: string;
    exitCode: number | null;
  } {
    const scenario = this.options.scenario ?? "success";
    const attempt = this.attemptNumber();
    const fixAttempts = this.options.fixAttempts ?? 1;

    switch (scenario) {
      case "rejection":
        return {
          review: {
            verdict: "REJECT",
            summary: `mock review rejected attempt ${attempt}`,
            issues: [
              {
                severity: "blocking",
                description: "The change does not meet the stated goal.",
                path: "src/index.ts",
              },
            ],
            confidence: 0.4,
          },
          status: "completed",
          summary: `review rejected (attempt ${attempt})`,
          exitCode: 0,
        };
      case "malformed-review":
        return {
          // Deliberately invalid: unknown verdict value and empty summary.
          review: { verdict: "MAYBE", summary: "", issues: "not-an-array" },
          status: "completed",
          summary: `review produced an unparseable verdict (attempt ${attempt})`,
          exitCode: 0,
        };
      case "no-verdict":
        return {
          review: undefined,
          status: "completed",
          summary: `review finished with exit code 0 but no verdict (attempt ${attempt})`,
          exitCode: 0,
        };
      case "fixes":
        if (attempt <= fixAttempts) {
          return {
            review: {
              verdict: "APPROVE_WITH_FIXES",
              summary: `mock review requests fixes (attempt ${attempt} of ${fixAttempts})`,
              issues: [
                {
                  severity: "major",
                  description: "Handle the empty-input case explicitly.",
                  path: "src/core/engine.ts",
                  line: 42,
                },
                {
                  severity: "minor",
                  description: "Add a regression test for the fix.",
                },
              ],
              confidence: 0.7,
            },
            status: "completed",
            summary: `review requested fixes (attempt ${attempt})`,
            exitCode: 0,
          };
        }
        return {
          review: {
            verdict: "APPROVE",
            summary: `mock review approves after fixes (attempt ${attempt})`,
            issues: [],
            confidence: 0.9,
          },
          status: "completed",
          summary: `review approved (attempt ${attempt})`,
          exitCode: 0,
        };
      default:
        return {
          review: {
            verdict: "APPROVE",
            summary: `mock review approved (attempt ${attempt})`,
            issues: [],
            confidence: 0.9,
          },
          status: "completed",
          summary: `review approved (attempt ${attempt})`,
          exitCode: 0,
        };
    }
  }

  private taskOutcome(): {
    status: AgentResult["status"];
    summary: string;
    exitCode: number | null;
    error?: string | null;
  } {
    const scenario = this.options.scenario ?? "success";
    const attempt = this.attemptNumber();
    switch (scenario) {
      case "failure":
        return {
          status: "failed",
          summary: `mock task failed (attempt ${attempt})`,
          exitCode: 1,
          error: "mock scenario failure",
        };
      case "failure-then-success": {
        const succeedFrom = this.options.succeedFromAttempt ?? 2;
        if (attempt < succeedFrom) {
          return {
            status: "failed",
            summary: `mock task failed on attempt ${attempt}`,
            exitCode: 1,
            error: `mock transient failure (attempt ${attempt})`,
          };
        }
        return {
          status: "completed",
          summary:
            this.options.summary ?? `mock task completed on attempt ${attempt}`,
          exitCode: 0,
        };
      }
      case "unavailable-result":
        return {
          status: "unavailable",
          summary: "mock agent reports it is unavailable",
          exitCode: null,
          error: "mock scenario unavailable-result",
        };
      case "long-running":
        return {
          status: "completed",
          summary: "mock long-running task finished",
          exitCode: 0,
        };
      case "input-required":
        return {
          status: "completed",
          summary: `mock task completed after ${this.inputs.length} operator input(s)`,
          exitCode: 0,
        };
      case "rejection":
      case "malformed-review":
      case "no-verdict":
      case "fixes":
        // These scenarios only differ on review stages; a non-review stage completes.
        return {
          status: "completed",
          summary: `mock task completed (attempt ${attempt})`,
          exitCode: 0,
        };
      default:
        return {
          status: "completed",
          summary:
            this.options.summary ?? `mock task completed (attempt ${attempt})`,
          exitCode: 0,
        };
    }
  }

  async collectResult(): Promise<AgentResult> {
    if (this.finalResult) return this.finalResult;

    if (this.phase === "awaiting_input") {
      if (this.inputs.length === 0) await this.waitForInput();
      if (this.cancelled) {
        return this.finish({
          status: "cancelled",
          summary: `mock agent cancelled: ${this.cancelReason ?? "cancelled"}`,
          exitCode: null,
          usage: null,
        });
      }
      this.status = "running";
      const outcome = this.isReviewStage()
        ? this.reviewOutcome()
        : this.taskOutcome();
      this.emit("AGENT_COMPLETED", {
        stream: "system",
        message: outcome.summary,
      });
      return this.finish(this.buildResult(outcome));
    }

    this.phase = "running";
    this.status = "running";
    this.emit("AGENT_STARTED", {
      stream: "system",
      message: `mock agent started for stage ${this.packet.stageKey}`,
    });

    const scenario = this.options.scenario ?? "success";

    if (scenario === "long-running") {
      this.emit("AGENT_OUTPUT", {
        stream: "stdout",
        message: "mock long-running task: working",
      });
      await this.waitForCancel();
      return this.finish({
        status: "cancelled",
        summary: `mock agent cancelled: ${this.cancelReason ?? "cancelled"}`,
        exitCode: null,
        usage: null,
        error: null,
      });
    }

    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await sleep(latency);
    if (this.cancelled) {
      return this.finish({
        status: "cancelled",
        summary: `mock agent cancelled: ${this.cancelReason ?? "cancelled"}`,
        exitCode: null,
        usage: null,
      });
    }

    if (this.options.failStageKeys?.includes(this.packet.stageKey)) {
      const summary = `mock injected failure for stage ${this.packet.stageKey} (attempt ${this.attemptNumber()})`;
      this.emit("AGENT_FAILED", { stream: "stderr", message: summary });
      return this.finish(
        this.buildResult({
          status: "failed",
          summary,
          exitCode: 1,
          error: `injected failure for ${this.packet.stageKey}`,
        }),
      );
    }

    const steps = this.options.steps ?? 2;
    for (let index = 1; index <= steps; index += 1) {
      this.emit("AGENT_OUTPUT", {
        stream: "stdout",
        message: `mock output ${index}/${steps} for ${this.packet.stageKey}`,
      });
    }
    const toolCalls = this.options.toolCalls ?? 0;
    for (let index = 1; index <= toolCalls; index += 1) {
      this.emit("AGENT_TOOL_CALL", {
        stream: "system",
        message: `mock tool call ${index}`,
        data: { tool: `mock.tool${index}` },
      });
    }

    if (scenario === "input-required" && this.inputs.length === 0) {
      const prompt =
        this.options.inputPrompt ?? "Which environment should I target?";
      this.emit("AGENT_WAITING", { stream: "system", message: prompt });
      this.status = "waiting_input";
      this.phase = "awaiting_input";
      return {
        status: "waiting_input",
        summary: `mock agent is waiting for operator input: ${prompt}`,
        exitCode: null,
        usage: null,
      };
    }

    if (scenario === "failure") {
      const outcome = this.taskOutcome();
      this.emit("AGENT_FAILED", {
        stream: "stderr",
        message: outcome.error ?? outcome.summary,
      });
      return this.finish(this.buildResult(outcome));
    }

    const outcome = this.isReviewStage()
      ? this.reviewOutcome()
      : this.taskOutcome();
    if (outcome.status === "completed") {
      this.emit("AGENT_COMPLETED", {
        stream: "system",
        message: outcome.summary,
      });
    } else if (outcome.status === "failed") {
      this.emit("AGENT_FAILED", { stream: "stderr", message: outcome.summary });
    }
    return this.finish(this.buildResult(outcome));
  }

  private buildResult(outcome: {
    status: AgentResult["status"];
    summary: string;
    exitCode: number | null;
    review?: unknown;
    error?: string | null;
  }): AgentResult {
    const usageProvided = Object.prototype.hasOwnProperty.call(
      this.options,
      "usage",
    );
    const usage: Usage | null = usageProvided
      ? (this.options.usage ?? null)
      : outcome.status === "completed"
        ? DEFAULT_USAGE
        : null;

    const result: AgentResult = {
      status: outcome.status,
      summary: outcome.summary,
      exitCode:
        this.options.exitCode !== undefined
          ? this.options.exitCode
          : outcome.exitCode,
      usage,
      error: outcome.error ?? null,
      metadata: {
        mock: true,
        scenario: this.options.scenario ?? "success",
        attemptNumber: this.attemptNumber(),
        stageKey: this.packet.stageKey,
        operatorInputs: [...this.inputs],
      },
    };
    if (outcome.review !== undefined) result.review = outcome.review;
    if (this.options.artifacts) result.artifacts = this.options.artifacts;
    return result;
  }
}

export class MockAgentAdapter implements AgentAdapter {
  readonly kind = "mock";
  private readonly agent: AgentRecord;
  private readonly now: () => string;
  private readonly overrides: MockAgentOptions;

  constructor(
    agent: AgentRecord,
    options: { now?: () => string; overrides?: MockAgentOptions } = {},
  ) {
    this.agent = agent;
    this.now = options.now ?? (() => new Date().toISOString());
    this.overrides = options.overrides ?? {};
  }

  /** Sessions created by this adapter, for test inspection. */
  readonly sessions: MockAgentSession[] = [];

  async startTask(
    packet: AgentTaskPacket,
    config: AgentTaskConfig,
  ): Promise<AgentSession> {
    const options = readOptions(
      { ...this.agent.config, ...config.config },
      this.overrides,
    );
    const scenario = options.scenario ?? "success";
    if (!MOCK_SCENARIOS.includes(scenario)) {
      throw new Error(`mock adapter: unknown scenario "${scenario}"`);
    }
    if (scenario === "unavailable") {
      throw new Error(`mock adapter: agent ${this.agent.name} is unavailable`);
    }
    const session = new MockAgentSession(packet, options, this.now);
    this.sessions.push(session);
    return session;
  }
}

/** Factory suitable for `createAdapterRegistry({ mock: createMockAdapter })`. */
export function createMockAdapter(
  agent: AgentRecord,
  options: { now?: () => string; overrides?: MockAgentOptions } = {},
): MockAgentAdapter {
  return new MockAgentAdapter(agent, options);
}
