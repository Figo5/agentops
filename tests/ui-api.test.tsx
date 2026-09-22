/**
 * API client tests. A stub `fetch` is injected; no network call is made and no
 * browser is simulated. These assert the wire contract the UI depends on:
 * the action token header, JSON bodies, error extraction and query building.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  createClient,
  describeError,
  errorFromResponse,
  parseSseEventFrame,
} from "../src/ui/api.js";

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responder: (call: Call) => {
    status?: number;
    body?: string;
    contentType?: string;
  },
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const call = { url: String(input), init };
    calls.push(call);
    const result = responder(call);
    const status = result.status ?? 200;
    return new Response(result.body ?? "", {
      status,
      headers: { "Content-Type": result.contentType ?? "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const bootstrapBody = JSON.stringify({
  token: "token-abc",
  projects: [],
  agents: [],
  templates: [],
  runs: [],
  version: "0.1.0",
});

test("bootstrap stores the action token and later writes send it", async () => {
  const { calls, fetchImpl } = stubFetch((call) => {
    if (call.url === "/api/bootstrap") return { body: bootstrapBody };
    return { body: JSON.stringify({ id: "project-1" }) };
  });
  const client = createClient({ fetchImpl });

  assert.equal(client.getToken(), null);
  const bootstrap = await client.bootstrap();
  assert.equal(bootstrap.version, "0.1.0");
  assert.equal(client.getToken(), "token-abc");

  await client.createProject({
    name: "x",
    path: "/tmp/x",
    vcs: "git",
    verificationCommands: [{ name: "test", executable: "npm", args: ["test"] }],
    notes: "",
    allowedAdapters: ["mock"],
  });

  const write = calls[1]!;
  const headers = new Headers(write.init.headers);
  assert.equal(write.init.method, "POST");
  assert.equal(headers.get("X-AgentOps-Token"), "token-abc");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(write.init.body)), {
    name: "x",
    path: "/tmp/x",
    vcs: "git",
    verificationCommands: [{ name: "test", executable: "npm", args: ["test"] }],
    notes: "",
    allowedAdapters: ["mock"],
  });
});

test("a write without a token fails closed instead of sending an unauthenticated request", async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ body: "{}" }));
  const client = createClient({ fetchImpl });
  await assert.rejects(
    () =>
      client.createAgent({
        name: "x",
        roleHint: "",
        adapterKind: "mock",
        model: null,
        effort: null,
        enabled: true,
        config: {},
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 0 &&
      /bootstrap/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("runs() serializes only the provided filters", async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ body: "[]" }));
  const client = createClient({ fetchImpl });
  await client.runs({
    q: "parser",
    status: "FAILED",
    projectId: "",
    branch: "main",
  });
  assert.equal(calls[0]!.url, "/api/runs?q=parser&status=FAILED&branch=main");
  await client.runs({});
  assert.equal(calls[1]!.url, "/api/runs");
});

test("run actions hit the documented paths with JSON bodies", async () => {
  const { calls, fetchImpl } = stubFetch(() => ({
    body: JSON.stringify({ run: { id: "r1" } }),
  }));
  const client = createClient({ fetchImpl, token: "t" });

  await client.runDetail("r1");
  assert.equal(calls.at(-1)!.url, "/api/runs/r1");

  await client.startRun("r1");
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/start");
  assert.equal(calls.at(-1)!.init.method, "POST");

  await client.retryRun("r1", { reason: "flaky" });
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/retry");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
    reason: "flaky",
  });

  await client.cancelRun("r1", { reason: "stop" });
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/cancel");

  await client.decideApproval("r1", {
    decision: "override",
    instruction: "ship it",
  });
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/approval");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
    decision: "override",
    instruction: "ship it",
  });

  await client.sendInput("r1", { text: "continue" });
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/input");

  await client.registerArtifact("r1", { path: "reports/x.md", kind: "report" });
  assert.equal(calls.at(-1)!.url, "/api/runs/r1/artifacts");
});

test("project and agent writes use PATCH/POST with encoded ids", async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ body: "{}" }));
  const client = createClient({ fetchImpl, token: "t" });
  await client.updateProject("p 1", { name: "renamed" });
  assert.equal(calls.at(-1)!.url, "/api/projects/p%201");
  assert.equal(calls.at(-1)!.init.method, "PATCH");
  await client.createAgent({
    name: "a",
    roleHint: "",
    adapterKind: "mock",
    model: null,
    effort: null,
    enabled: true,
    config: { scenario: "success" },
  });
  assert.equal(calls.at(-1)!.url, "/api/agents");
  assert.equal(calls.at(-1)!.init.method, "POST");
  await client.projectDiff("p1", true);
  assert.equal(calls.at(-1)!.url, "/api/projects/p1/diff?staged=true");
  await client.projectDiff("p1");
  assert.equal(calls.at(-1)!.url, "/api/projects/p1/diff");
  await client.projectSnapshot("p1");
  assert.equal(calls.at(-1)!.url, "/api/projects/p1/snapshot");
});

test("server errors surface the {error} contract", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 409,
    body: JSON.stringify({ error: "Project root is not a repository" }),
  }));
  const client = createClient({ fetchImpl, token: "t" });
  await assert.rejects(
    () => client.projectSnapshot("p1"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === "Project root is not a repository",
  );
});

test("non-JSON and empty failures still produce a readable message", async () => {
  const plain = await errorFromResponse(
    new Response("gateway exploded", {
      status: 502,
      statusText: "Bad Gateway",
    }),
  );
  assert.equal(plain.status, 502);
  assert.equal(plain.message, "gateway exploded");

  const empty = await errorFromResponse(
    new Response("", { status: 500, statusText: "Internal Server Error" }),
  );
  assert.match(empty.message, /500/);

  const { fetchImpl } = stubFetch(() => ({
    status: 500,
    body: "not json at all",
    contentType: "text/plain",
  }));
  const client = createClient({ fetchImpl });
  await assert.rejects(() => client.bootstrap(), /not json at all/);
});

test("malformed success bodies are reported, never silently accepted", async () => {
  const { fetchImpl } = stubFetch(() => ({
    status: 200,
    body: "<html>oops</html>",
  }));
  const client = createClient({ fetchImpl });
  await assert.rejects(
    () => client.runs({}),
    (error: unknown) =>
      error instanceof ApiError &&
      /Malformed JSON response/.test(error.message),
  );
});

test("network failures are described without throwing raw TypeErrors", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const client = createClient({ fetchImpl });
  await assert.rejects(
    () => client.bootstrap(),
    (error: unknown) =>
      error instanceof ApiError &&
      /Cannot reach the AgentOps server/.test(error.message),
  );
  assert.equal(describeError(new ApiError(403, "nope")), "nope");
  assert.equal(describeError(new Error("plain")), "plain");
  assert.equal(describeError("weird"), "weird");
});

test("the SSE url carries the run id and the afterId cursor", () => {
  const client = createClient({});
  assert.equal(client.eventsUrl("r1", 0), "/api/events?runId=r1&afterId=0");
  assert.equal(client.eventsUrl("r 1", 42), "/api/events?runId=r+1&afterId=42");
  assert.equal(client.eventsUrl("r1", -5), "/api/events?runId=r1&afterId=0");
});

test("SSE frames parse into persisted event records or are ignored", () => {
  const frame = `event: event\ndata: {"id":7,"category":"agent","type":"AGENT_OUTPUT","payload":{"message":"hi"},"createdAt":"2026-09-22T10:00:00.000Z"}`;
  const parsed = parseSseEventFrame(frame);
  assert.equal(parsed?.id, 7);
  assert.equal(parsed?.type, "AGENT_OUTPUT");
  assert.equal(parseSseEventFrame(": keep-alive"), null);
  assert.equal(parseSseEventFrame("data: not json"), null);
  assert.equal(parseSseEventFrame('data: {"type":"no id"}'), null);
  assert.equal(parseSseEventFrame(""), null);
});
