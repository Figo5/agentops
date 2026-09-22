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
      page.getByRole("button", { name: /Final · (Current|Waiting)/ }),
    ).toBeVisible();
    // The sheet is the summary, the facts and its actions; the recorded
    // provenance lives in the page's technical details, collapsed.
    const evidence = page.locator(".approval-evidence");
    await expect(
      evidence.getByRole("button", { name: "Accept run" }),
    ).toBeVisible();
    await expect(
      evidence.getByRole("button", { name: "Review changes" }),
    ).toBeVisible();
    await expect(evidence.getByRole("button", { name: "Reject" })).toBeVisible();
    await expect(evidence).not.toContainText("review cycle");
    await expect(evidence).not.toContainText("Verification:");
    // A run with nothing pending never shows an empty decision area.
    await expect(page.getByText("Nothing needs you")).toHaveCount(0);
    await expect(
      page.getByText("Ready for your review", { exact: true }),
    ).toBeVisible();

    // Explicit evidence navigation: opening a tab brings the run's tab list —
    // and the panel under it — to the top of the viewport, just below the
    // sticky top bar, instead of leaving the evidence below the whole summary.
    // The fixture's run page is compact and its diff loads asynchronously, so
    // this asserts the harder case: the reveal must land while the evidence
    // panel is still short and loading, not only once the diff has arrived.
    const panelTop = async (id: string) =>
      (await page.locator(`#run-sections-${id}-panel`).boundingBox())?.y ??
      Number.POSITIVE_INFINITY;
    const tabListTop = async () =>
      (await page.getByRole("tablist", { name: "Run sections" }).boundingBox())
        ?.y ?? Number.POSITIVE_INFINITY;
    const topBarBottom = async () => {
      const box = await page.locator(".topbar").boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    };
    await page.route("**/api/projects/*/diff*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    // Reduced motion makes the reveal instant, so it can be measured once while
    // the diff is still in flight — the reveal cannot be relying on the panel's
    // final height.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await evidence.getByRole("button", { name: "Review changes" }).click();
    await expect(page.getByRole("tab", { name: /^Changes/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByText("Loading the working-tree diff…"),
    ).toBeVisible();
    expect(await panelTop("changes")).toBeLessThan(200);
    // Tight, not merely "visible": the tab list sits just below the sticky bar,
    // so the evidence panel — not the summary — owns the viewport.
    expect(await tabListTop()).toBeGreaterThanOrEqual(await topBarBottom());
    expect((await tabListTop()) - (await topBarBottom())).toBeLessThan(40);
    // …and it stays there once the asynchronous diff arrives and grows the page.
    await page.unroute("**/api/projects/*/diff*");
    await expect.poll(() => panelTop("changes")).toBeLessThan(200);
    expect(await panelTop("changes")).toBeGreaterThan(0);
    // The header stays above the evidence, still visible and reachable.
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: /Exercise the entire browser workflow/,
      }),
    ).toHaveCount(1);

    // The default (smooth) motion path, and a keyboard tab selection: the same
    // reveal, with the newly selected tab keeping focus.
    await page.emulateMedia({ reducedMotion: null });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(200);
    await page.getByRole("tab", { name: /^Changes/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: /^Verification/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => panelTop("verification")).toBeLessThan(200);
    expect(
      await page.evaluate(() => document.activeElement?.textContent ?? ""),
    ).toContain("Verification");

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
    // The review verdict is its own tab now.
    await page.getByRole("tab", { name: "Review" }).click();
    await expect(
      page.getByText("Review verdicts", { exact: true }),
    ).toBeVisible();
    const attempts = app.store
      .listAttemptsForRun(run.id)
      .filter((a) => a.stageKey === "implement");
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "COMPLETED"]);
    // A stage click opens the evidence view that holds the attempt audit.
    await page.getByRole("tab", { name: "Overview" }).click();
    await page.getByText("Stage evidence").click();
    await page
      .getByRole("button", { name: "Open evidence for Implementation" })
      .click();
    await expect(page.getByRole("button", { name: /#1 Failed/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /#2 Completed/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the run screen keeps one state, honest progress and its own event surfaces", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-ia-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // A project with no git: the Changes tab does not apply and must be hidden.
    const project = app.store.createProject({
      name: "IA fixture",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [
        {
          name: "test",
          executable: process.execPath,
          args: ["-e", 'console.log("# pass 3\\n# fail 0\\n# tests 3")'],
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
        goal: "Exercise the run screen information architecture",
        agents: Object.fromEntries(
          app.store.listAgents().map((a) => [a.roleHint!, a.id]),
        ),
      })
    ).run;
    await app.engine.startRun(run.id);
    await expect
      .poll(() => app.store.requireRun(run.id).status, { timeout: 20000 })
      .toBe("WAITING_APPROVAL");

    // Loading → loaded regression: delay the first detail request, assert the
    // loading state renders and then the loaded screen. A hook ordered after an
    // early return used to blank every run route (React error 310), which this
    // assertion and the pageerror check at the end catch.
    let delayed = false;
    await page.route("**/api/runs/*", async (route) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);
    await expect(page.getByText(/Loading run /)).toBeVisible();

    // Pass 3 run-screen behaviour (the hook-order regression guards the blank
    // run route: the loaded render is asserted after the loading state).
    await expect(
      page.getByRole("heading", { name: "Changes requested", exact: true }),
    ).toBeVisible();

    // Horizontal progress: plain milestone names, one compact button each, no
    // expanded records and no persisted enum.
    const progress = page.getByRole("navigation", { name: "Stage progress" });
    for (const name of ["Plan", "Build", "Verify", "Review", "Final"]) {
      await expect(
        progress.getByRole("button", { name: new RegExp(`^${name} · `) }),
      ).toBeVisible();
    }
    await expect(progress.locator("details[open]")).toHaveCount(0);
    await expect(progress).not.toContainText("WAITING_APPROVAL");
    // The chronology — including the review → fix → re-verification branch — is
    // one collapsed disclosure away.
    await expect(progress).toContainText("Workflow details");
    await progress.getByText("Workflow details").click();
    await expect(progress).toContainText("Structured review: fixes");

    // Tabs: only the panels that apply to this run are rendered.
    const checkpoints = app.store.listGitSnapshots(run.id).length;
    const expectChanges = checkpoints > 0 || project.vcs === "git";
    await expect(page.getByRole("tab", { name: /^Changes/ })).toHaveCount(
      expectChanges ? 1 : 0,
    );
    for (const label of ["Overview", "Verification", "Review", "Activity"]) {
      await expect(
        page.getByRole("tab", { name: new RegExp(`^${label}`) }),
      ).toHaveCount(1);
    }

    // Activity is lifecycle sentences, and raw logs are their own surface.
    await page.getByRole("tab", { name: /^Activity/ }).click();
    const activity = page.getByRole("list", { name: "Run activity" });
    await expect(activity).toContainText("Run started");
    await expect(activity).toContainText("rejected");
    await expect(activity).not.toContainText("agent.output");

    // Raw logs stay folded until asked for.
    await expect(page.getByLabel("Filter by stream")).toBeHidden();
    await page.getByText(/^Raw logs \(/).click();
    await expect(page.getByLabel("Filter by stream")).toBeVisible();
    await expect(page.getByLabel("Filter by severity")).toBeVisible();
    // The full audit filter set is preserved behind advanced filters.
    await expect(page.getByLabel("Filter by actor")).toHaveCount(1);
    await page.getByText("Advanced filters").click();
    await expect(page.getByLabel("Filter by actor")).toBeVisible();
    await expect(page.getByLabel("Filter by stage")).toBeVisible();
    await expect(page.getByLabel("Filter by attempt")).toBeVisible();
    await expect(page.getByLabel("Filter log text")).toBeVisible();
    await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);

    // Following auto-pauses on an upward scroll: scroll the log to the bottom,
    // scroll it up, and the follow control yields to the jump control.
    const log = page.getByRole("log", { name: "Raw run log" });
    const scrolled = await log.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      const before = node.scrollTop;
      node.scrollTop = Math.max(0, before - 120);
      return node.scrollTop < before;
    });
    expect(scrolled).toBeTruthy();
    await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toBeVisible();

    // An event that arrives while paused is counted, and does not steal the
    // scroll position back.
    app.store.appendEvent({
      category: "stage",
      type: "stage.reopened",
      runId: run.id,
      projectId: project.id,
      stageKey: "review",
      actor: "operator",
      payload: { reason: "paused follow probe" },
    });
    await expect(page.getByText(/1 new line while paused/)).toBeVisible();
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
    await expect(activity).toContainText("Structured review reopened");
    // No React error, no blank route: every assertion above ran on real markup.
    expect(errors).toEqual([]);
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
    await expect(evidence).toContainText(reviewer.name);
    // The default view is the compact decision sheet: the reviewer's own words,
    // summary-level facts and its actions. The normalized counts, the provenance
    // and the full prose are one disclosure or one tab away.
    await expect(evidence).toContainText("1 blocker");
    await expect(evidence).toContainText("7 tests passed");
    await expect(
      evidence.getByRole("button", { name: "Read full review" }),
    ).toBeVisible();
    await expect(
      page.locator("details.disclosure").first(),
    ).not.toHaveAttribute("open", "");
    // The page's own technical details hold the recorded provenance (the sheet
    // no longer repeats it).
    const technical = page
      .locator("details.disclosure")
      .filter({ hasText: "Technical details" })
      .last();
    await technical.evaluate((el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await expect(technical).toContainText("counts from the normalized test run");
    await expect(technical).toContainText("7/7 passed");
    await technical.evaluate((el) => {
      (el as HTMLDetailsElement).open = false;
    });
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
