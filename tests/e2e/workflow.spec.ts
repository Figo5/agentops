/// <reference lib="dom" />
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { execute } from "../../src/adapters/shell/process.js";

test("first-run registration, stage plan, live run, exact prompt, approval and restored history", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-browser-"));
  await execute({ executable: "git", args: ["init", "-b", "main"], cwd: root });
  await writeFile(
    path.join(root, "test.mjs"),
    `import {test} from 'node:test';test('real browser fixture verification',()=>{});`,
  );
  const app = createApp();
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base + "/#/projects");
    await page
      .getByLabel("Project name", { exact: true })
      .fill("Browser fixture");
    await page
      .getByLabel("Absolute repository path", { exact: true })
      .fill(root);
    if ((await page.getByLabel("Executable", { exact: true }).count()) === 0)
      await page
        .getByRole("button", { name: "Add command", exact: true })
        .click();
    await page
      .getByLabel("Executable", { exact: true })
      .first()
      .fill(process.execPath);
    await page
      .getByLabel("Arguments (JSON array)", { exact: true })
      .first()
      .fill('["--test","test.mjs"]');
    await page
      .getByRole("button", { name: "Register project", exact: true })
      .click();
    await expect.poll(() => app.store.listProjects().length).toBe(1);
    const project = app.store.listProjects()[0]!;
    await page.goto(base + `/#/new-run/${project.id}`);
    await page
      .getByLabel("Workflow template", { exact: true })
      .selectOption("implement-review");
    await page
      .getByLabel("Goal", { exact: true })
      .fill("Exercise the entire browser workflow");
    for (const role of ["planner", "implementer", "reviewer"]) {
      const control = page.locator(`#newrun-role-${role}`);
      if (await control.count())
        await control.selectOption(
          app.store.listAgents().find((a) => a.roleHint === role)!.id,
        );
    }
    await page
      .getByRole("button", { name: "Create draft run", exact: true })
      .click();
    await expect(
      page.getByText("Draft created", { exact: false }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Start.*run|Start workflow/i })
      .first()
      .click();
    await expect
      .poll(() => app.store.listRuns()[0]?.status, { timeout: 15000 })
      .toBe("WAITING_APPROVAL");
    await expect(
      page.getByText("WAITING FOR YOU", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => app.store.listRuns()[0]?.status).toBe("COMPLETED");
    await page.reload();
    await expect(
      page
        .getByRole("heading", { name: /Exercise the entire browser workflow/ })
        .first(),
    ).toBeVisible();
    const detail = app.store.getRunDetail(app.store.listRuns()[0]!.id)!;
    expect(
      detail.attempts.some((a) =>
        a.promptText?.includes("Exercise the entire browser workflow"),
      ),
    ).toBeTruthy();
    expect(
      app.store.listTestRuns(detail.run.id).some((t) => t.passed === 1),
    ).toBeTruthy();
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 2,
      ),
    ).toBeTruthy();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retry preserves the failed attempt and exposes the reviewer verdict", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-retry-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Retry fixture",
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
    const worker = app.store
      .listAgents()
      .find((a) => a.roleHint === "implementer")!;
    app.store.updateAgent(worker.id, {
      config: { scenario: "failure-then-success" },
    });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Recover from an explicit failure",
        agents: Object.fromEntries(
          app.store.listAgents().map((a) => [a.roleHint!, a.id]),
        ),
      })
    ).run;
    await app.engine.startRun(run.id);
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);
    await page
      .getByRole("button", { name: "Retry with reason", exact: true })
      .click();
    await page
      .getByLabel("Retry reason (mandatory)", { exact: true })
      .fill("Retry the deterministic fail-once scenario");
    await page
      .getByRole("button", {
        name: /Submit retry|Retry stage|Create retry|Retry now/,
      })
      .click();
    await expect
      .poll(() => app.store.requireRun(run.id).status, { timeout: 10000 })
      .toBe("WAITING_APPROVAL");
    await expect(
      page.getByText("Review verdicts", { exact: true }),
    ).toBeVisible();
    const attempts = app.store
      .listAttemptsForRun(run.id)
      .filter((a) => a.stageKey === "implement");
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "COMPLETED"]);
    await page.getByRole("button", { name: /Implementation task/ }).click();
    await expect(page.getByRole("button", { name: /#1 FAILED/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /#2 COMPLETED/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
