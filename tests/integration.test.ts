import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { execute } from "../src/adapters/shell/process.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-integration-"));
  await execute({ executable: "git", args: ["init", "-b", "main"], cwd: root });
  await writeFile(
    path.join(root, "check.test.mjs"),
    `import {test} from 'node:test';import assert from 'node:assert/strict';test('real verification',()=>assert.equal(2+2,4));`,
  );
  return root;
}
test("HTTP workflow persists prompts, runs real tests, loops review fixes and gates final acceptance", async () => {
  const root = await fixture();
  const app = createApp({ dbPath: path.join(root, "audit.sqlite") });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const boot = (await (await fetch(base + "/api/bootstrap")).json()) as any;
    const post = async (url: string, body: unknown) => {
      const r = await fetch(base + url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentOps-Token": boot.token,
        },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as any;
      assert.ok(r.ok, JSON.stringify(data));
      return data;
    };
    const project = await post("/api/projects", {
      name: "Fixture",
      path: root,
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          args: ["--test", "check.test.mjs"],
        },
      ],
    });
    const reviewer = boot.agents.find((a: any) => a.roleHint === "reviewer");
    app.store.updateAgent(reviewer.id, { config: { scenario: "fixes" } });
    const roles = Object.fromEntries(
      boot.agents.map((a: any) => [a.roleHint, a.id]),
    );
    const run = await post("/api/runs", {
      projectId: project.id,
      templateId: "implement-review",
      goal: "Validate the workflow",
      roleMapping: roles,
    });
    assert.equal(run.status, "DRAFT");
    await post(`/api/runs/${run.id}/start`, {});
    await app.engine.waitForSettled(run.id, { timeoutMs: 10000 });
    const d = (await (await fetch(base + `/api/runs/${run.id}`)).json()) as any;
    assert.equal(d.run.status, "WAITING_APPROVAL", JSON.stringify(d.run));
    assert.ok(
      d.attempts.some((a: any) =>
        a.promptText?.includes("Validate the workflow"),
      ),
    );
    assert.ok(d.tests.some((t: any) => t.passed === 1));
    assert.ok(
      d.reviewVerdicts.some((v: any) => v.verdict === "APPROVE_WITH_FIXES"),
    );
    assert.ok(d.reviewVerdicts.some((v: any) => v.verdict === "APPROVE"));
    assert.ok(d.snapshots.length >= 2);
    assert.ok(
      d.attempts
        .filter((a: any) => a.kind === "agent")
        .every((a: any) => a.usage === null),
    );
    await post(`/api/runs/${run.id}/approval`, {
      decision: "approve",
      instruction: "Accepted observed fixture result",
    });
    assert.equal(app.store.requireRun(run.id).status, "COMPLETED");
    const history = (await (
      await fetch(base + "/api/runs?q=Validate&verdict=APPROVE")
    ).json()) as any[];
    assert.equal(history.length, 1);
    const sse = await fetch(base + `/api/events?runId=${run.id}&afterId=0`);
    const reader = sse.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /connected|event:/);
    await reader.cancel();
    const denied = await fetch(base + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 403);
    const cross = await fetch(base + "/api/bootstrap", {
      headers: { Origin: "https://evil.invalid" },
    });
    assert.equal(cross.status, 403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("runtime does not claim verification without a configured command", async () => {
  const root = await fixture();
  const app = createApp();
  try {
    const project = app.store.createProject({
      name: "No tests",
      canonicalRoot: root,
      vcs: "git",
    });
    const agents = Object.fromEntries(
      app.store.listAgents().map((a) => [a.roleHint!, a.id]),
    );
    const d = await app.engine.createRun({
      projectId: project.id,
      templateId: "bug-fix",
      goal: "Check missing verification",
      agents,
    });
    await app.engine.startRun(d.run.id);
    const r = await app.engine.waitForSettled(d.run.id);
    assert.equal(r.status, "FAILED");
    assert.match(r.failureReason ?? "", /verification|command/i);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual handoff enters WAITING_INPUT through the real engine and accepts a result", async () => {
  const root = await fixture();
  const app = createApp();
  try {
    const project = app.store.createProject({
      name: "Manual fixture",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          args: ["--test", "check.test.mjs"],
        },
      ],
    });
    const agent = app.store.createAgent({
      name: "Manual worker",
      roleHint: "implementer",
      adapterKind: "generic-cli",
      config: { manual: true },
    });
    const agents = {
      ...Object.fromEntries(
        app.store.listAgents().map((a) => [a.roleHint!, a.id]),
      ),
      implementer: agent.id,
    };
    const d = await app.engine.createRun({
      projectId: project.id,
      templateId: "implement-review",
      goal: "Inspect manual flow",
      agents,
    });
    await app.engine.startRun(d.run.id);
    assert.equal(app.store.requireRun(d.run.id).status, "WAITING_INPUT");
    await app.engine.sendInput(
      d.run.id,
      "Manually checked the local fixture. No edits were needed.",
    );
    await app.engine.waitForSettled(d.run.id);
    assert.equal(app.store.requireRun(d.run.id).status, "WAITING_APPROVAL");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-declared symlink artifacts fail before entering subsequent prompts", async () => {
  const root = await fixture();
  const app = createApp();
  try {
    await symlink("/etc", path.join(root, "escape"));
    const project = app.store.createProject({
      name: "Artifact fixture",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          args: ["--test", "check.test.mjs"],
        },
      ],
    });
    const output = JSON.stringify({
      summary: "Report",
      artifacts: [{ path: "escape/hosts", kind: "text" }],
    });
    const agent = app.store.createAgent({
      name: "Artifact worker",
      adapterKind: "generic-cli",
      roleHint: "implementer",
      config: {
        executable: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(output)})`],
      },
    });
    const agents = {
      ...Object.fromEntries(
        app.store.listAgents().map((a) => [a.roleHint!, a.id]),
      ),
      implementer: agent.id,
    };
    const d = await app.engine.createRun({
      projectId: project.id,
      templateId: "implement-review",
      goal: "Validate artifacts",
      agents,
    });
    await app.engine.startRun(d.run.id);
    assert.equal(app.store.requireRun(d.run.id).status, "FAILED");
    assert.equal(app.store.listArtifacts(d.run.id).length, 0);
    assert.match(
      app.store.requireRun(d.run.id).failureReason ?? "",
      /artifact|escapes/i,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
