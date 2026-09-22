import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";
import { Engine } from "../src/core/engine.js";
import { createApp } from "../src/server/app.js";
import { validateReviewVerdict } from "../src/core/review.js";

test("structured summaries, verdicts, errors, event payloads and prompt packets redact credentials at rest", async () => {
  const secret = "sk-ant-" + "a".repeat(40);
  const store = new Store();
  const project = store.createProject({
    name: "Audit",
    canonicalRoot: process.cwd(),
    vcs: "none",
  });
  const agent = store.createAgent({
    name: "Test adapter",
    adapterKind: "test",
  });
  const engine = new Engine({
    store,
    verification: {
      kind: "fixture",
      async run() {
        return { status: "passed", summary: "Verified " + secret };
      },
    },
    resolveAdapter: () => ({
      kind: "test",
      async startTask() {
        return {
          id: crypto.randomUUID(),
          async sendInput() {},
          async cancel() {},
          getStatus() {
            return "completed";
          },
          async *streamEvents() {
            yield {
              type: "AGENT_COMPLETED",
              at: new Date().toISOString(),
              message: "Completed " + secret,
            };
          },
          async collectResult() {
            return {
              status: "completed",
              summary: "Result " + secret,
              exitCode: 0,
              review: {
                verdict: "APPROVE",
                summary: "Reviewed " + secret,
                issues: [],
              },
              usage: null,
            };
          },
        };
      },
    }),
  });
  try {
    const d = await engine.createRun({
      projectId: project.id,
      templateId: "implement-review",
      goal: "Check audit redaction",
      agents: { planner: agent.id, implementer: agent.id, reviewer: agent.id },
    });
    await engine.startRun(d.run.id);
    assert.equal(store.requireRun(d.run.id).status, "WAITING_APPROVAL");
    for (const table of [
      "task_attempts",
      "run_stages",
      "events",
      "review_verdicts",
    ]) {
      const rows = store.db.prepare(`SELECT * FROM ${table}`).all();
      assert.equal(
        JSON.stringify(rows).includes(secret),
        false,
        `${table} leaked a credential`,
      );
    }
    assert.match(JSON.stringify(store.getRunDetail(d.run.id)), /REDACTED/);
  } finally {
    await engine.shutdown();
    store.close();
  }
});

test("fixes verdict without actionable issues is rejected", () => {
  assert.equal(
    validateReviewVerdict({
      verdict: "APPROVE_WITH_FIXES",
      summary: "Needs fixes",
    }).ok,
    false,
  );
  assert.equal(
    validateReviewVerdict({
      verdict: "APPROVE_WITH_FIXES",
      summary: "Needs fixes",
      issues: null,
    }).ok,
    false,
  );
});

test("rejected manual input remains waiting and can be corrected without losing the session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-input-"));
  const app = createApp();
  try {
    const project = app.store.createProject({
      name: "Manual review",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          args: ["-e", 'console.log("# pass 1\\n# fail 0")'],
        },
      ],
    });
    const reviewer = app.store.createAgent({
      name: "Manual reviewer",
      roleHint: "reviewer",
      adapterKind: "generic-cli",
      config: { manual: true },
    });
    const agents = {
      ...Object.fromEntries(
        app.store.listAgents().map((a) => [a.roleHint!, a.id]),
      ),
      reviewer: reviewer.id,
    };
    const d = await app.engine.createRun({
      projectId: project.id,
      templateId: "implement-review",
      goal: "Inspect delivery failure",
      agents,
    });
    await app.engine.startRun(d.run.id);
    assert.equal(app.store.requireRun(d.run.id).status, "WAITING_INPUT");
    await assert.rejects(
      app.engine.sendInput(d.run.id, "not a JSON verdict"),
      /JSON/,
    );
    assert.equal(app.store.requireRun(d.run.id).status, "WAITING_INPUT");
    await app.engine.sendInput(
      d.run.id,
      '{"verdict":"APPROVE","summary":"Reviewed the fixture","issues":[]}',
    );
    await app.engine.waitForSettled(d.run.id);
    assert.equal(app.store.requireRun(d.run.id).status, "WAITING_APPROVAL");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
