import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CliAdapter,
  ManualSession,
  buildInvocation,
  parseStructuredResult,
} from "../src/adapters/agents/cli.js";
import type { AgentTaskPacket, AgentTaskConfig } from "../src/core/types.js";
const packet = {
  promptText: "Explicit persisted prompt",
  projectRoot: process.cwd(),
  role: "reviewer",
  stageKind: "review",
} as AgentTaskPacket;
const config: AgentTaskConfig = {
  agentId: "test",
  adapterKind: "generic-cli",
  model: null,
  effort: null,
  config: {},
};
test("generic CLI requires structured reviewer output despite exit zero", async () => {
  const session = await new CliAdapter().startTask(packet, {
    ...config,
    config: {
      executable: process.execPath,
      args: ["-e", 'console.log("looks good")'],
    },
  });
  const result = await session.collectResult();
  assert.equal(result.status, "completed");
  assert.equal(result.review, null);
});
test("generic adapter captures structured review and raw output", async () => {
  const review = {
    verdict: "APPROVE",
    summary: "Checked implementation",
    issues: [],
  };
  const session = await new CliAdapter().startTask(packet, {
    ...config,
    config: {
      executable: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(review))})`],
    },
  });
  const events = [];
  for await (const e of session.streamEvents()) events.push(e);
  const r = await session.collectResult();
  assert.deepEqual(r.review, review);
  assert.ok(events.some((e) => e.type === "AGENT_STARTED"));
  assert.ok(events.some((e) => e.type === "AGENT_OUTPUT"));
  assert.equal(r.usage, null);
});
test("CLI commands keep prompt literal and preserve configured model", () => {
  const p = { ...packet, promptText: "do not execute $(echo malicious)" };
  const c = buildInvocation("codex", p, {
    ...config,
    model: "gpt-6-astra",
    effort: "high",
  });
  assert.equal(c.input, p.promptText);
  assert.ok(c.args.includes("gpt-6-astra"));
  assert.ok(c.args.includes("read-only"));
  assert.throws(
    () => buildInvocation("hermes-opencode", p, config),
    /explicitly/,
  );
});
test("Claude reviewer argv restricts tools with flags verified in Claude Code 2.1.221 help", () => {
  const invocation = buildInvocation("claude-code", packet, {
    ...config,
    effort: "high",
    model: "claude-opus-5",
  });
  assert.ok(invocation.args.includes("--tools"));
  assert.ok(invocation.args.includes("Read,Glob,Grep"));
  assert.ok(invocation.args.includes("dontAsk"));
  assert.ok(invocation.args.includes("--effort"));
});
test("manual review requires JSON and does not invent usage or an exit status", async () => {
  const s = new ManualSession(packet);
  assert.equal(s.getStatus(), "waiting_input");
  await assert.rejects(s.sendInput("yes"), /JSON/);
  await s.sendInput('{"verdict":"APPROVE","summary":"Reviewed","issues":[]}');
  const r = await s.collectResult();
  assert.equal(r.exitCode, null);
  assert.equal(r.usage, null);
  assert.equal(s.getStatus(), "completed");
  assert.equal(parseStructuredResult('```json\n{"a":1}\n```')?.["a"], 1);
});

test("manual failure remains a failure and planning tools stay read-only", async () => {
  const session = new ManualSession({
    ...packet,
    role: "implementer",
    stageKind: "task",
  });
  assert.equal((await session.collectResult()).status, "waiting_input");
  await assert.rejects(
    session.sendInput('{"status":"maybe"}'),
    /status must be/,
  );
  assert.equal(session.getStatus(), "waiting_input");
  await session.sendInput(
    '{"status":"failed","summary":"Could not implement","error":"Missing dependency"}',
  );
  const result = await session.collectResult();
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Missing dependency");
  const invocation = buildInvocation(
    "claude-code",
    { ...packet, role: "planner", stageKind: "task" },
    config,
  );
  assert.ok(invocation.args.includes("Read,Glob,Grep"));
  assert.ok(invocation.args.includes("dontAsk"));
});
