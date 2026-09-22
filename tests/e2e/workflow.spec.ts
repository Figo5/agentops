/// <reference lib="dom" />
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { execute } from "../../src/adapters/shell/process.js";

test("first-run registration, guided workflow, live run, exact prompt, approval and restored history", async ({
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
    await page.getByLabel("Repository path", { exact: true }).fill(root);
    // Verification commands are real configuration, so they live one
    // disclosure down on the registration form.
    await page
      .locator("summary", { hasText: /^Verification commands/ })
      .first()
      .click();
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
    // The project page leads with the project, not with a settings form.
    await expect(
      page.getByRole("heading", { name: "Browser fixture" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recent runs" }),
    ).toBeVisible();
    // One project owns the full width; switching only appears with a second one.
    await expect(page.getByText("Switch project")).toHaveCount(0);
    // The immutable root is secondary: one disclosure down, never under the
    // project's name.
    await expect(page.getByText(project.canonicalRoot).first()).toBeHidden();
    const projectTechnical = page
      .locator("details.disclosure")
      .filter({ hasText: "Technical details" })
      .first();
    await projectTechnical.locator("summary").click();
    await expect(
      projectTechnical.getByText(project.canonicalRoot, { exact: true }),
    ).toBeVisible();

    // The workflow is a guided five-step flow; each step validates before the
    // flow moves on, and Back keeps what was entered.
    await page.goto(base + `/#/new-run/${project.id}`);
    const steps = page.getByRole("list", { name: "Workflow steps" });
    for (const label of [
      "Project & goal",
      "Team",
      "Plan",
      "Policy & approvals",
      "Review and start",
    ])
      await expect(
        steps.getByRole("button", { name: new RegExp(label) }),
      ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "1 · Project & goal" }),
    ).toBeVisible();
    // Step 1 refuses to advance without a goal.
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByText("Describe what this run should accomplish"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "1 · Project & goal" }),
    ).toBeVisible();
    await page
      .getByLabel("Goal", { exact: true })
      .fill("Exercise the entire browser workflow");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 2: team. The roles come from the template's plan.
    await expect(page.getByRole("heading", { name: "2 · Team" })).toBeVisible();
    await expect(
      page.getByText("Choose who builds and who reviews"),
    ).toBeVisible();
    for (const role of ["planner", "implementer", "reviewer"]) {
      const control = page.locator(`#newrun-role-${role}`);
      if (await control.count())
        await control.selectOption(
          app.store.listAgents().find((a) => a.roleHint === role)!.id,
        );
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 3: the plan in plain words, with the frozen stage ids one
    // disclosure down.
    await expect(page.getByRole("heading", { name: "3 · Plan" })).toBeVisible();
    await page
      .getByLabel("Workflow template", { exact: true })
      .selectOption("implement-review");
    await expect(page.locator(".plan-flow")).toContainText(
      "Plan → Implementation → Verification",
    );
    await expect(page.getByText("Stage keys", { exact: true })).toHaveCount(0);
    await page.getByText("Technical details").first().click();
    // The exact frozen stages are one disclosure down.
    await expect(page.getByText("final_approval").first()).toBeVisible();
    await expect(page.locator(".plan-flow")).not.toContainText(
      "final_approval",
    );
    // A template change can add roles. The flow says so, and Team asks for the
    // missing one rather than creating a run with an unmapped role.
    await expect(
      page.getByText("This template also needs Planner"),
    ).toBeVisible();
    await page.getByRole("button", { name: /Team/ }).click();
    await expect(page.getByRole("heading", { name: "2 · Team" })).toBeVisible();
    for (const role of ["planner", "implementer", "reviewer"]) {
      const control = page.locator(`#newrun-role-${role}`);
      if ((await control.count()) && !(await control.inputValue()))
        await control.selectOption(
          app.store.listAgents().find((a) => a.roleHint === role)!.id,
        );
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "3 · Plan" })).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 4: the mandatory policy and security acknowledgements. Continue is
    // refused until every one of them is confirmed.
    await expect(
      page.getByRole("heading", { name: "4 · Policy & approvals" }),
    ).toBeVisible();
    await expect(page.getByText("Verification is required.")).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByText(
        "Every policy and security acknowledgement must be confirmed",
      ),
    ).toBeVisible();
    for (const label of [
      "I understand every human gate stays mandatory, including final acceptance.",
      "I understand configured agents run with my OS privileges and are not sandboxed.",
      "I understand the verification commands this project defines are what the run will execute.",
    ])
      await page.getByLabel(label, { exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 5: review, then the explicit create-draft → start contract.
    await expect(
      page.getByRole("heading", { name: "5 · Review and start" }),
    ).toBeVisible();
    await expect(
      page.getByText("Creating the draft writes the run record"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create draft run", exact: true })
      .click();
    await expect(
      page.getByText("Draft created", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText("Frozen plan")).toBeVisible();
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
    await expect(
      evidence.getByRole("button", { name: "Reject" }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toHaveCount(0);

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
    await expect(
      page.getByRole("button", { name: "Follow", exact: true }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toHaveCount(0);
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
    await expect(technical).toContainText(
      "counts from the normalized test run",
    );
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

/* ------------------------------------------------------------------ */
/* Pass 5: management surfaces, empty states, scenarios and layout      */
/* ------------------------------------------------------------------ */

/** Every seeded agent id by role, which is how the engine maps a plan. */
function agentsByRole(app: ReturnType<typeof createApp>) {
  return Object.fromEntries(
    app.store.listAgents().map((agent) => [agent.roleHint!, agent.id]),
  );
}

/** A verification command whose output parses confidently. */
const PASSING_COMMAND = {
  name: "test",
  executable: process.execPath,
  args: ["-e", 'console.log("# pass 7\\n# fail 0\\n# tests 7")'],
};

test("the dashboard renders only the sections that have runs", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-home-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const project = app.store.createProject({
      name: "Quiet project",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [PASSING_COMMAND],
    });
    await page.goto(base + "/#/");
    // With a project but no runs: one prompt, and no empty category sections.
    await expect(page.getByText("Start your first workflow")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("heading", { name: "Running" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
    await expect(page.getByText("Nothing needs you right now")).toBeVisible();
    await expect(page.locator(".nav__empty")).toHaveText("Nothing needs you");

    // A run that finished belongs to Recent and to nothing else.
    const finished = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Earlier accepted work",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(finished.id);
    await app.engine.waitForStatus(finished.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });
    await app.engine.decideApproval(finished.id, "approve");
    await app.engine.waitForSettled(finished.id, { timeoutMs: 20000 });
    expect(app.store.requireRun(finished.id).status).toBe("COMPLETED");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
    await expect(page.getByText("Earlier accepted work")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("heading", { name: "Running" })).toHaveCount(0);
    await expect(page.getByText("Nothing needs you right now")).toBeVisible();

    // A rejected run is what needs the operator, and the section says so.
    const reviewer = app.store
      .listAgents()
      .find((agent) => agent.roleHint === "reviewer")!;
    app.store.updateAgent(reviewer.id, { config: { scenario: "rejection" } });
    const blocked = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Work that needs a decision",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(blocked.id);
    await app.engine.waitForStatus(blocked.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });

    await page.reload();
    const needsYou = page
      .locator(".home-section")
      .filter({ hasText: "Needs you" });
    await expect(needsYou).toContainText("Work that needs a decision");
    await expect(needsYou).toContainText("Changes requested");
    await expect(page.getByText("1 run needs your attention")).toBeVisible();
    // The section is not repeated: the finished run stays in Recent only.
    await expect(needsYou.getByText("Earlier accepted work")).toHaveCount(0);
    expect(app.store.requireRun(finished.id).status).toBe("COMPLETED");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a long goal is clamped with an explicit full-text control", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-goal-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Long goal project",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [PASSING_COMMAND],
    });
    const goal = `Rework the ${"entire ".repeat(40)}navigation layer without changing any recorded behaviour`;
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal,
        agents: agentsByRole(app),
      })
    ).run;
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);
    const heading = page.getByRole("heading", {
      name: new RegExp("Rework the"),
    });
    await expect(heading).toBeVisible();
    // The full goal is reachable, and the clamp is explicit about its state.
    const toggle = page.getByRole("button", { name: "Show full goal" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".clamp__text")).toHaveAttribute("title", goal);
    await toggle.click();
    await expect(
      page.getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
    // The page never grows a second copy of the goal into the tab bar.
    await expect(heading).toHaveCount(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("technical and raw surfaces stay folded until the operator asks", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-fold-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const project = app.store.createProject({
      name: "Fold project",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [PASSING_COMMAND],
    });
    // A real CLI adapter record, so the editor has adapter plumbing to fold.
    // (The mock agents keep their deterministic scenarios: this one is only
    // edited, never run.)
    app.store.createAgent({
      name: "CLI worker",
      roleHint: "implementer",
      adapterKind: "hermes-opencode",
      model: "deepseek-v4.1-flash",
      effort: "high",
      config: { executable: "hermes", provider: "opencode-go" },
    });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Exercise the folded surfaces",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(run.id);
    await app.engine.waitForStatus(run.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });

    // Projects: the storage-shaped facts are folded, not on the main line.
    await page.goto(`http://127.0.0.1:${port}/#/projects/${project.id}`);
    const projectTechnical = page
      .locator("details.disclosure")
      .filter({ hasText: "Technical details" })
      .first();
    await expect(projectTechnical).not.toHaveAttribute("open", "");
    await expect(projectTechnical.getByText("Project ID")).toBeHidden();
    await projectTechnical.locator("summary").click();
    await expect(projectTechnical.getByText("Project ID")).toBeVisible();

    // Agents: the row is configuration, and adapter plumbing is one level down.
    await page.goto(`http://127.0.0.1:${port}/#/agents`);
    const roster = page.locator(".agent-list");
    await expect(
      roster.getByRole("button", { name: "Edit Mock implementer" }),
    ).toBeVisible();
    await expect(
      roster.getByRole("button", { name: "Edit CLI worker" }),
    ).toBeVisible();
    await expect(roster).toContainText(
      /CLI installed · access unchecked|configured, enabled/,
    );
    // Configured state is never painted as verified access.
    await expect(roster.locator(".status--success")).toHaveCount(0);
    await expect(page.getByText("Advanced adapter configuration")).toHaveCount(
      0,
    );
    await roster.getByRole("button", { name: "Edit CLI worker" }).click();
    await expect(
      page.getByText("Advanced adapter configuration"),
    ).toBeVisible();
    await expect(page.getByLabel("Executable", { exact: true })).toBeHidden();
    await page.getByText("Advanced adapter configuration").click();
    await expect(page.getByLabel("Executable", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue(
      "opencode-go",
    );
    // The raw record is read-only and the id is not editable.
    const raw = page.getByLabel("Agent configuration (read-only)");
    await expect(raw).toHaveJSProperty("readOnly", true);
    await expect(
      page.getByText("Agent ID", { exact: true }).first(),
    ).toBeHidden();

    // The run page keeps raw logs and advanced log filters folded.
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);
    await page.getByRole("tab", { name: /^Activity/ }).click();
    await expect(page.getByLabel("Filter by stream")).toBeHidden();
    await page.getByText(/^Raw logs \(/).click();
    await expect(page.getByLabel("Filter by stream")).toBeVisible();
    await expect(page.getByLabel("Filter by actor")).toBeHidden();
    await page.getByText("Advanced filters").click();
    await expect(page.getByLabel("Filter by actor")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the run tabs follow the keyboard and keep their aria wiring", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-tabs-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Tabs project",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [PASSING_COMMAND],
    });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Exercise the tab keyboard contract",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(run.id);
    await app.engine.waitForStatus(run.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);

    const tablist = page.getByRole("tablist", { name: "Run sections" });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole("tab");
    const count = await tabs.count();
    expect(count).toBeGreaterThan(2);
    // Every tab points at a real panel, and only the selected one is tabbable.
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      const controls = await tab.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      await expect(page.locator(`#${controls}`)).toHaveCount(1);
      const selected = (await tab.getAttribute("aria-selected")) === "true";
      await expect(tab).toHaveAttribute("tabindex", selected ? "0" : "-1");
    }
    // Keyboard: End selects the last tab and moves focus with it.
    await tabs.first().focus();
    await page.keyboard.press("End");
    await expect(tabs.nth(count - 1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(count - 1)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.nth(count - 2)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(count - 2)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    // The selected panel is the only one in the accessibility tree.
    const selectedPanelId = await tabs.first().getAttribute("aria-controls");
    await expect(page.locator(`#${selectedPanelId}`)).toBeVisible();
    for (let index = 1; index < count; index += 1) {
      const controls = await tabs.nth(index).getAttribute("aria-controls");
      await expect(page.locator(`#${controls}`)).toBeHidden();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the review tab keeps every finding and the changes tab renders a full-width diff", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-review-ui-"));
  await execute({ executable: "git", args: ["init", "-b", "main"], cwd: root });
  await execute({
    executable: "git",
    args: ["config", "user.email", "e@x.invalid"],
    cwd: root,
  });
  await execute({
    executable: "git",
    args: ["config", "user.name", "Fixture"],
    cwd: root,
  });
  await writeFile(path.join(root, "greeting.ts"), "export const greet = 1;\n");
  await execute({ executable: "git", args: ["add", "."], cwd: root });
  await execute({
    executable: "git",
    args: ["commit", "-m", "Initial"],
    cwd: root,
  });
  // A real working-tree change, so the Changes tab has a diff to render.
  await writeFile(
    path.join(root, "greeting.ts"),
    `export const greet = 2;\n${Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n")}\n`,
  );
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Review project",
      canonicalRoot: root,
      vcs: "git",
      verificationCommands: [PASSING_COMMAND],
    });
    const reviewer = app.store
      .listAgents()
      .find((agent) => agent.roleHint === "reviewer")!;
    app.store.updateAgent(reviewer.id, { config: { scenario: "rejection" } });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Exercise the review surfaces",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(run.id);
    await app.engine.waitForStatus(run.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });
    await page.goto(`http://127.0.0.1:${port}/#/run/${run.id}`);

    // Review: the findings are the page, the prose is one disclosure down.
    await page.getByRole("tab", { name: "Review" }).click();
    const review = page.getByRole("tabpanel", { name: /Review/ });
    await expect(review.getByText("Review verdicts")).toBeVisible();
    await expect(review.getByText("Blockers")).toBeVisible();
    await expect(review).toContainText("1 blocker");
    await expect(review.getByText(reviewer.name)).toBeVisible();
    await expect(review.getByText("Read full review")).toBeVisible();
    await expect(review.getByText("reviewed severity: blocking")).toBeHidden();
    // The reviewer's prose is one disclosure down, not on the main line.
    await expect(
      review.locator("details").filter({ hasText: "Read full review" }).first(),
    ).not.toHaveAttribute("open", "");

    // Changes: the unified diff is rendered, line-numbered and full width.
    await page.getByRole("tab", { name: /^Changes/ }).click();
    const diff = page.locator(".diff").first();
    await expect(diff).toBeVisible();
    await expect(diff.locator(".diff__line--add").first()).toBeVisible();
    const box = await diff.boundingBox();
    expect(box!.width).toBeGreaterThan(900);
    // Nothing is clipped: the diff keeps the real lines, not a summary.
    await expect(diff).toContainText("export const line39 = 39;");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the management screens fit a narrow viewport without sideways scroll", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentops-responsive-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  try {
    const project = app.store.createProject({
      name: "Responsive project",
      canonicalRoot: root,
      vcs: "none",
      verificationCommands: [PASSING_COMMAND],
    });
    const run = (
      await app.engine.createRun({
        projectId: project.id,
        templateId: "implement-review",
        goal: "Check the narrow layout",
        agents: agentsByRole(app),
      })
    ).run;
    await app.engine.startRun(run.id);
    await app.engine.waitForStatus(run.id, ["WAITING_APPROVAL"], {
      timeoutMs: 20000,
    });

    const routes = [
      "#/",
      "#/projects",
      `#/projects/${project.id}`,
      "#/agents",
      "#/runs",
      "#/new-run",
      "#/settings",
      `#/run/${run.id}`,
    ];
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(`http://127.0.0.1:${port}/${route}`);
        await expect(page.locator("main#main-content")).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(
          overflow,
          `${route} at ${width}px must not scroll sideways`,
        ).toBeLessThanOrEqual(2);
      }
    }
    // The guided flow keeps its controls reachable at the narrowest width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/#/new-run`);
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Workflow steps" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("all eight scenarios reach their own honest outcome in the UI", async ({
  page,
}) => {
  // Eight runs, each started, waited on and inspected in a real browser.
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(tmpdir(), "agentops-scenarios-ui-"));
  const app = createApp();
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  /**
   * The eight outcomes the workflow can produce, each driven by the
   * deterministic mock adapter, and the copy the dashboard owes the operator
   * for it. The ninth scenario (long-running) is asserted separately because it
   * never settles.
   */
  const scenarios: {
    key: string;
    goal: string;
    worker: string;
    reviewer?: string;
    settle: string[];
    dashboard: RegExp;
    retry?: boolean;
  }[] = [
    {
      key: "success",
      goal: "Scenario success",
      worker: "success",
      settle: ["WAITING_APPROVAL"],
      dashboard: /Ready for final approval|Waiting for you/,
    },
    {
      key: "failure",
      goal: "Scenario failure",
      worker: "failure",
      settle: ["FAILED"],
      dashboard: /Failed/,
    },
    {
      key: "retry",
      goal: "Scenario retry",
      worker: "failure-then-success",
      settle: ["FAILED"],
      dashboard: /Failed/,
      retry: true,
    },
    {
      key: "rejection",
      goal: "Scenario rejection",
      worker: "success",
      reviewer: "rejection",
      settle: ["WAITING_APPROVAL"],
      dashboard: /Changes requested/,
    },
    {
      key: "fixes",
      goal: "Scenario fixes",
      worker: "success",
      reviewer: "fixes",
      settle: ["WAITING_APPROVAL"],
      dashboard: /Ready for final approval|Ready for review|Waiting for you/,
    },
    {
      key: "input",
      goal: "Scenario input",
      worker: "input-required",
      settle: ["WAITING_INPUT"],
      dashboard: /Needs your input/,
    },
    {
      key: "malformed",
      goal: "Scenario malformed review",
      worker: "success",
      reviewer: "malformed-review",
      settle: ["WAITING_APPROVAL", "FAILED"],
      dashboard:
        /Ready for final approval|Ready for review|Waiting for you|Changes requested|Failed/,
    },
    {
      key: "active",
      goal: "Scenario active",
      worker: "long-running",
      settle: ["RUNNING"],
      dashboard: /Running/,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const scenarioRoot = await mkdtemp(
        path.join(tmpdir(), `agentops-${scenario.key}-`),
      );
      const project = app.store.createProject({
        name: `${scenario.key} project`,
        canonicalRoot: scenarioRoot,
        vcs: "none",
        verificationCommands: [PASSING_COMMAND],
      });
      const worker = app.store
        .listAgents()
        .find((agent) => agent.roleHint === "implementer")!;
      app.store.updateAgent(worker.id, {
        config: { scenario: scenario.worker },
      });
      const reviewer = app.store
        .listAgents()
        .find((agent) => agent.roleHint === "reviewer")!;
      app.store.updateAgent(reviewer.id, {
        config: { scenario: scenario.reviewer ?? "success" },
      });
      const run = (
        await app.engine.createRun({
          projectId: project.id,
          templateId: "implement-review",
          goal: scenario.goal,
          agents: agentsByRole(app),
        })
      ).run;
      await app.engine.startRun(run.id);
      await app.engine.waitForStatus(run.id, scenario.settle as never, {
        timeoutMs: 25000,
      });

      // The dashboard states this run's own outcome word.
      await page.goto(base + "/#/");
      const row = page.locator(".run-row").filter({ hasText: scenario.goal });
      await expect(row).toBeVisible();
      await expect(row).toContainText(scenario.dashboard);

      // A retry is an operator decision on a failed run: the failure is what
      // the dashboard owed the operator, and the retry then moves the run on.
      if (scenario.retry) {
        await app.engine.retry(run.id, "Retry the deterministic scenario");
        await app.engine.waitForStatus(run.id, ["WAITING_APPROVAL"], {
          timeoutMs: 25000,
        });
        await page.reload();
        await expect(
          page.locator(".run-row").filter({ hasText: scenario.goal }),
        ).toContainText(/Ready for final approval|Waiting for you/);
      }

      // The run page renders, with the goal as its heading and no page error.
      await page.goto(`${base}/#/run/${run.id}`);
      await expect(
        page.getByRole("heading", { name: new RegExp(scenario.goal) }),
      ).toBeVisible();
      await expect(
        page.getByRole("tablist", { name: "Run sections" }),
      ).toBeVisible();
      // The decision surface for this outcome is stated, never a blank page.
      await expect(page.locator(".run-head")).toContainText(/./);
    }
    // Retry keeps both attempts as durable history.
    const retried = app.store
      .listRuns()
      .find((entry) => entry.goal === "Scenario retry")!;
    const attempts = app.store
      .listAttemptsForRun(retried.id)
      .filter((attempt) => attempt.stageKey === "implement");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.some((attempt) => attempt.status === "FAILED")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
