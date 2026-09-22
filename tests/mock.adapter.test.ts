/**
 * Mock adapter tests: deterministic scenarios, cancellation, input waits,
 * retry-fail-once, review payload shapes and the guarantee that the mock never
 * talks to an AI provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  MOCK_SCENARIOS,
  MockAgentAdapter,
  createMockAdapter,
} from "../src/adapters/agents/mock.js";
import { createAdapterRegistry } from "../src/adapters/agents/types.js";
import type {
  MockAgentOptions,
  MockScenario,
} from "../src/adapters/agents/mock.js";
import type {
  AgentEvent,
  AgentRecord,
  AgentResult,
  AgentSession,
  AgentTaskPacket,
  StageKind,
} from "../src/core/index.js";

const NOW = "2026-01-01T00:00:00.000Z";

function mockAgent(config: Record<string, unknown> = {}): AgentRecord {
  return {
    id: "agt_mock",
    name: "mock-agent",
    roleHint: "implementer",
    adapterKind: "mock",
    model: "mock-model",
    effort: null,
    enabled: true,
    config,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function packet(
  overrides: {
    stageKind?: StageKind;
    stageKey?: string;
    attemptNumber?: number;
    role?: string;
  } = {},
): AgentTaskPacket {
  const stageKind = overrides.stageKind ?? "task";
  return {
    packetVersion: 1,
    runId: "run_test",
    projectId: "prj_test",
    projectName: "demo",
    projectRoot: "/tmp/demo",
    goal: "do the thing",
    constraints: [],
    stageKey: overrides.stageKey ?? "implement",
    stageName: "Implementation",
    stageKind,
    stageInstructions: "implement",
    role:
      overrides.role ?? (stageKind === "review" ? "reviewer" : "implementer"),
    agentId: "agt_mock",
    adapterKind: "mock",
    attemptNumber: overrides.attemptNumber ?? 1,
    attemptReason: null,
    templateId: "implement-review",
    stoppingRule: "stop when done",
    priorAttempts: [],
    priorStageResults: [],
    latestCheckpoint: null,
    verification: [],
    artifacts: [],
    review:
      stageKind === "review"
        ? {
            cycle: overrides.attemptNumber ?? 1,
            maxCycles: 2,
            priorVerdicts: [],
          }
        : null,
    humanInstruction: null,
    operatorInputs: [],
    promptText: "# prompt",
  };
}

const TASK_CONFIG = {
  agentId: "agt_mock",
  adapterKind: "mock",
  model: "mock-model",
  effort: null,
  config: {},
  timeoutMs: null,
};

async function start(
  config: Record<string, unknown>,
  overrides: {
    stageKind?: StageKind;
    stageKey?: string;
    attemptNumber?: number;
    role?: string;
  } = {},
): Promise<AgentSession> {
  const adapter = new MockAgentAdapter(mockAgent(config), { now: () => NOW });
  return adapter.startTask(packet(overrides), TASK_CONFIG);
}

async function drain(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.streamEvents()) events.push(event);
  return events;
}

async function drainConcurrently(
  session: AgentSession,
  promise: Promise<unknown>,
): Promise<AgentEvent[]> {
  const [events] = await Promise.all([
    drain(session),
    promise.catch(() => undefined),
  ]);
  return events;
}

describe("mock adapter scenarios", () => {
  it("lists the deterministic scenarios including the documented ones", () => {
    for (const scenario of [
      "success",
      "failure",
      "fixes",
      "rejection",
      "failure-then-success",
      "long-running",
      "input-required",
      "malformed-review",
    ] as MockScenario[]) {
      assert.ok(
        MOCK_SCENARIOS.includes(scenario),
        `${scenario} is a supported scenario`,
      );
    }
  });

  it("completes successfully with normalized events and known usage", async () => {
    const session = await start({ scenario: "success" }, {});
    const resultPromise = session.collectResult();
    const events = await drainConcurrently(session, resultPromise);
    const result = await resultPromise;

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.usage?.totalTokens, 1540);
    assert.match(result.summary, /mock task completed/);
    assert.equal(session.getStatus(), "completed");
    assert.deepEqual(
      events.map((event) => event.type),
      ["AGENT_STARTED", "AGENT_OUTPUT", "AGENT_OUTPUT", "AGENT_COMPLETED"],
    );
    assert.equal(events[1]?.stream, "stdout");
    assert.ok(events.every((event) => event.at === NOW));
    assert.equal(
      await session.collectResult(),
      result,
      "collectResult is idempotent",
    );
  });

  it("fails with exit code 1 and unknown usage", async () => {
    const session = await start({ scenario: "failure" });
    const result = await session.collectResult();
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.usage, null, "a failed run reports unknown usage");
    assert.equal(session.getStatus(), "failed");
    assert.equal(
      (await drain(session)).some((event) => event.type === "AGENT_FAILED"),
      true,
    );
  });

  it("honours the configured step and tool-call counts", async () => {
    const session = await start({
      scenario: "success",
      steps: 4,
      toolCalls: 2,
    });
    const resultPromise = session.collectResult();
    const events = await drainConcurrently(session, resultPromise);
    await resultPromise;
    assert.equal(
      events.filter((event) => event.type === "AGENT_OUTPUT").length,
      4,
    );
    assert.equal(
      events.filter((event) => event.type === "AGENT_TOOL_CALL").length,
      2,
    );
  });

  it("waits for operator input and then completes", async () => {
    const session = await start({
      scenario: "input-required",
      inputPrompt: "which environment?",
    });
    const first = await session.collectResult();
    assert.equal(first.status, "waiting_input");
    assert.equal(first.exitCode, null);
    assert.match(first.summary, /which environment\?/);
    assert.equal(session.getStatus(), "waiting_input");

    await session.sendInput("staging");
    const second = await session.collectResult();
    assert.equal(second.status, "completed");
    assert.match(second.summary, /1 operator input/);
    assert.equal(session.getStatus(), "completed");
    const events = await drain(session);
    assert.ok(events.some((event) => event.type === "AGENT_WAITING"));
  });

  it("runs until cancelled and resolves exactly once", async () => {
    const session = await start({ scenario: "long-running" });
    const resultPromise = session.collectResult();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(session.getStatus(), "running");

    await session.cancel("operator stopped it");
    const result = await resultPromise;
    assert.equal(result.status, "cancelled");
    assert.equal(result.exitCode, null);
    assert.equal(result.usage, null);
    assert.equal(session.getStatus(), "cancelled");
    await session.cancel("again");
    assert.equal(
      await session.collectResult(),
      result,
      "cancellation is idempotent",
    );
    const events = await drain(session);
    assert.equal(
      events.filter((event) => event.type === "AGENT_CANCELLED").length,
      1,
    );
  });

  it("cancels a session that is waiting for input", async () => {
    const session = await start({ scenario: "input-required" });
    const first = await session.collectResult();
    assert.equal(first.status, "waiting_input");
    await session.cancel("never mind");
    const result = await session.collectResult();
    assert.equal(result.status, "cancelled");
    assert.equal(session.getStatus(), "cancelled");
  });

  it("fails once and succeeds afterwards (retry-fail-once)", async () => {
    const first = await start(
      { scenario: "failure-then-success" },
      { attemptNumber: 1 },
    );
    assert.equal((await first.collectResult()).status, "failed");
    const second = await start(
      { scenario: "failure-then-success" },
      { attemptNumber: 2 },
    );
    const secondResult = await second.collectResult();
    assert.equal(secondResult.status, "completed");
    assert.match(secondResult.summary, /completed on attempt 2/);
    const third = await start(
      { scenario: "failure-then-success" },
      { attemptNumber: 3 },
    );
    assert.equal((await third.collectResult()).status, "completed");
  });

  it("requests fixes once on a review stage and then approves", async () => {
    const first = await start(
      { scenario: "fixes", fixAttempts: 1 },
      { stageKind: "review", attemptNumber: 1 },
    );
    const firstResult = await first.collectResult();
    assert.equal(firstResult.status, "completed");
    const firstVerdict = firstResult.review as {
      verdict: string;
      issues: unknown[];
    };
    assert.equal(firstVerdict.verdict, "APPROVE_WITH_FIXES");
    assert.equal(firstVerdict.issues.length, 2);

    const second = await start(
      { scenario: "fixes", fixAttempts: 1 },
      { stageKind: "review", attemptNumber: 2 },
    );
    const secondVerdict = (await second.collectResult()).review as {
      verdict: string;
      issues: unknown[];
    };
    assert.equal(secondVerdict.verdict, "APPROVE");
    assert.equal(secondVerdict.issues.length, 0);
  });

  it("produces a REJECT verdict, a malformed payload and a missing verdict on demand", async () => {
    const rejected = (
      await (
        await start({ scenario: "rejection" }, { stageKind: "review" })
      ).collectResult()
    ).review as {
      verdict: string;
    };
    assert.equal(rejected.verdict, "REJECT");

    const malformed = await (
      await start({ scenario: "malformed-review" }, { stageKind: "review" })
    ).collectResult();
    assert.equal(malformed.status, "completed");
    assert.equal(malformed.exitCode, 0);
    assert.deepEqual(malformed.review, {
      verdict: "MAYBE",
      summary: "",
      issues: "not-an-array",
    });

    const missing = await (
      await start({ scenario: "no-verdict" }, { stageKind: "review" })
    ).collectResult();
    assert.equal(missing.status, "completed");
    assert.equal(missing.exitCode, 0);
    assert.equal(
      missing.review,
      undefined,
      "a zero exit code carries no verdict",
    );
  });

  it("treats the planner and experiment stages as plain tasks that never carry a verdict", async () => {
    const planner = await start(
      { scenario: "success" },
      { stageKey: "plan", role: "planner" },
    );
    const plannerResult = await planner.collectResult();
    assert.equal(plannerResult.status, "completed");
    assert.equal(plannerResult.exitCode, 0);
    assert.equal(
      plannerResult.review,
      undefined,
      "a planning stage produces no review verdict",
    );

    const experiment = await start(
      { scenario: "success" },
      { stageKey: "experiment", role: "implementer" },
    );
    const experimentResult = await experiment.collectResult();
    assert.equal(experimentResult.status, "completed");
    assert.equal(experimentResult.review, undefined);
    assert.equal(experimentResult.metadata?.["stageKey"], "experiment");

    // The 'fixes' scenario only changes review-stage behaviour: the research
    // experiment behaves like any other task stage.
    const fixing = await start(
      { scenario: "fixes", fixAttempts: 1 },
      { stageKey: "experiment", role: "implementer" },
    );
    assert.equal((await fixing.collectResult()).status, "completed");
  });

  it("reports unavailability by throwing or by result status", async () => {
    await assert.rejects(
      () => start({ scenario: "unavailable" }),
      /is unavailable/,
    );
    const session = await start({ scenario: "unavailable-result" });
    const result = await session.collectResult();
    assert.equal(result.status, "unavailable");
    assert.equal(result.exitCode, null);
    assert.equal(session.getStatus(), "failed");
  });

  it("injects failures for specific stages only", async () => {
    const failing = await start(
      { scenario: "success", failStageKeys: ["review.fix"] },
      { stageKey: "review.fix" },
    );
    const failed = await failing.collectResult();
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /injected failure for stage review.fix/);

    const other = await start(
      { scenario: "success", failStageKeys: ["review.fix"] },
      { stageKey: "implement" },
    );
    assert.equal((await other.collectResult()).status, "completed");
  });

  it("passes artifacts through and honours explicit unknown usage", async () => {
    const session = await start({
      scenario: "success",
      artifacts: [{ path: "docs/a.md", kind: "doc" }],
      usage: null,
    });
    const result = await session.collectResult();
    assert.deepEqual(result.artifacts, [{ path: "docs/a.md", kind: "doc" }]);
    assert.equal(result.usage, null);
  });

  it("rejects unknown scenarios instead of guessing", async () => {
    await assert.rejects(
      () => start({ scenario: "not-a-scenario" }),
      /unknown scenario/,
    );
  });

  it("is deterministic for identical inputs", async () => {
    const options: MockAgentOptions = {
      scenario: "fixes",
      steps: 3,
      toolCalls: 1,
      fixAttempts: 1,
    };
    const runOnce = async (): Promise<{
      types: string[];
      messages: (string | undefined)[];
      result: AgentResult;
    }> => {
      const session = await start(options as Record<string, unknown>, {
        stageKind: "review",
        attemptNumber: 1,
      });
      const resultPromise = session.collectResult();
      const events = await drainConcurrently(session, resultPromise);
      return {
        types: events.map((event) => event.type),
        messages: events.map((event) => event.message),
        result: await resultPromise,
      };
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.deepEqual(a.types, b.types);
    assert.deepEqual(a.messages, b.messages);
    assert.deepEqual(a.result, b.result);
  });
});

describe("mock adapter wiring", () => {
  it("creates sessions through the factory and the registry", async () => {
    const adapter = createMockAdapter(mockAgent({ scenario: "success" }));
    assert.equal(adapter.kind, "mock");
    const session = await adapter.startTask(packet(), TASK_CONFIG);
    assert.equal((await session.collectResult()).status, "completed");
    assert.equal(adapter.sessions.length, 1);

    const registry = createAdapterRegistry({
      mock: (agent) => createMockAdapter(agent),
    });
    assert.equal(registry.has("mock"), true);
    assert.deepEqual(registry.kinds(), ["mock"]);
    assert.ok(registry.resolve(mockAgent({ scenario: "failure" })));
    assert.equal(
      registry.resolve({ ...mockAgent(), adapterKind: "cli" }),
      undefined,
    );
  });

  it("merges adapter-level config over the agent record", async () => {
    const adapter = new MockAgentAdapter(
      mockAgent({ scenario: "success", steps: 1 }),
      {
        overrides: { scenario: "failure" },
      },
    );
    const session = await adapter.startTask(packet(), TASK_CONFIG);
    assert.equal((await session.collectResult()).status, "failed");
  });

  it("never talks to an AI provider or a network", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.join(here, "..", "src", "adapters", "agents", "mock.ts"),
      "utf8",
    );
    const forbidden = [
      "node:http",
      "node:https",
      "node:net",
      "node:dgram",
      "node:tls",
      "node:child_process",
      "undici",
      "axios",
      "node-fetch",
      "api.anthropic.com",
      "api.openai.com",
      "openai",
      "anthropic",
      "fetch(",
    ];
    for (const needle of forbidden) {
      assert.equal(
        source.includes(needle),
        false,
        `mock adapter must not reference ${needle}`,
      );
    }
    // It only imports from the core domain and node builtins used for ids/time.
    const imports = [...source.matchAll(/from ["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports.sort(), [
      "../../core/ids.js",
      "../../core/mutex.js",
      "../../core/types.js",
    ]);
  });
});
