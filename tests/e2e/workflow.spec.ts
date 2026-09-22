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
      page.getByText("Waiting for you", { exact: true }).first(),
    ).toBeVisible();
    // The final human gate accepts the run explicitly; the decision buttons
    // appear after the persisted evidence for that gate.
    await expect(
      page.getByText("Ready for your review", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Accept run", exact: true }).click();
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
    await expect(page.getByRole("button", { name: /#1 Failed/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /#2 Completed/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejection gate shows evidence first, collects a reason only after the decision, and the skip link keeps the route", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-gate-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Gate fixture",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          // node:test-shaped output: the normalized test run is parsed
          // confidently while the attempt's own verification record carries
          // counts: null, which is what the real runs persist.
          args: ["-e", 'console.log("# pass 7\\n# fail 0\\n# tests 7")'],
        },
      ],
    });
    const reviewer = app.store
      .listAgents()
      .find((a) => a.roleHint === "reviewer")!;
    app.store.updateAgent(reviewer.id, { config: { scenario: "rejection" } });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Exercise the rejection gate",
        agents: Object.fromEntries(
          app.store.listAgents().map((a) => [a.roleHint!, a.id]),
        ),
      })
    ).run;
    await app.engine.startRun(run.id);
    await expect
      .poll(() => app.store.requireRun(run.id).status, { timeout: 20000 })
      .toBe("WAITING_APPROVAL");

    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);
    await expect(
      page.getByText("Review rejected — your call").first(),
    ).toBeVisible();

    // Evidence is rendered before the decision buttons and carries the persisted
    // verdict, the reviewer resolved from the recorded attempt, and the counts
    // correlated from the normalized test run.
    const evidence = page.locator(".approval-evidence");
    await expect(evidence).toContainText("Reject");
    await expect(evidence).toContainText("7/7 passed");
    await expect(evidence).toContainText("counts from the normalized test run");
    await expect(evidence).toContainText(reviewer.name);
    // The default view is the concise summary; the full prose and provenance
    // live behind disclosures that are present but collapsed.
    await expect(evidence).toContainText("1 blocker");
    await expect(evidence).toContainText("7 tests passed");
    await expect(
      evidence.getByText("Read full review (1 blocker)", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("details.disclosure").first(),
    ).not.toHaveAttribute("open", "");
    await expect(
      page.getByRole("button", { name: "Reject with override" }),
    ).toHaveCount(0);
    const evidenceBox = await evidence.boundingBox();
    const rejectBox = await page
      .getByRole("button", { name: "Reject", exact: true })
      .boundingBox();
    expect(evidenceBox!.y).toBeLessThan(rejectBox!.y);

    // The mandatory reason field appears only once a decision needs one.
    await expect(page.locator("#approval-reason")).toHaveCount(0);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.locator("#approval-reason")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Confirm Reject" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#approval-reason")).toHaveCount(0);
    expect(app.store.requireRun(run.id).status).toBe("WAITING_APPROVAL");

    // The skip link focuses the main landmark without becoming a route.
    const hash = await page.evaluate(() => window.location.hash);
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(hash);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("main-content");
    await expect(
      page.getByRole("heading", { name: /Exercise the rejection gate/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Mission control" }),
    ).toHaveCount(0);

    // Overriding with a reason is the recorded, audited path forward.
    await page
      .getByRole("button", { name: "Override rejection and continue" })
      .click();
    await page
      .getByLabel("Reason for overriding the rejection")
      .fill("independent verification passed");
    await page
      .getByRole("button", { name: "Confirm Override rejection and continue" })
      .click();
    await expect
      .poll(() => app.store.requireRun(run.id).status, { timeout: 20000 })
      .not.toBe("WAITING_APPROVAL");
    const approval = app.store
      .listApprovals(run.id)
      .find((entry) => entry.gate === "review_reject")!;
    expect(approval.decision).toBe("override");
    expect(approval.instruction).toContain("independent verification passed");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
