/**
 * Operational home: what needs you, what is running, what finished recently.
 *
 * This is a working screen, not an inventory: templates, agents and workspace
 * counts have their own screens and are not repeated here. Empty categories are
 * not rendered at all, so a quiet day is a short page instead of a wall of
 * placeholder cards. Every number comes from the bootstrap payload.
 *
 * The rows that need the operator may carry one concise evidence line, read
 * from that run's own records through the existing API (bounded to the first few
 * rows). While the request is in flight the row says so, and a failed request
 * says `Evidence unavailable` — a missing line never reads as a clean run.
 */
import type { Bootstrap } from "../api.js";
import type { RunEvidenceState } from "../hooks.js";
import { activeRowDetail, greetingFor, homeSummary } from "../view-model.js";
import { Button } from "./Bits.js";
import { RunSection } from "./RunRow.js";

export function Home({
  bootstrap,
  now = new Date(),
  evidence,
}: {
  bootstrap: Bootstrap;
  /** Injectable clock so the greeting is deterministic in tests. */
  now?: Date;
  /** Bounded evidence per run id, fetched by the shell; absent outside it. */
  evidence?: Record<string, RunEvidenceState>;
}) {
  const projectNames = Object.fromEntries(
    bootstrap.projects.map((project) => [project.id, project.name]),
  );
  const agentNames = Object.fromEntries(
    bootstrap.agents.map((agent) => [agent.id, agent.name]),
  );
  const summary = homeSummary(bootstrap.runs);
  /**
   * What each running run is working on, from the run's own frozen plan and role
   * mapping — no extra request, and nothing shown when the plan does not resolve.
   */
  const runningDetails = Object.fromEntries(
    summary.running.map((run) => [
      run.id,
      activeRowDetail({
        nextStageKey: run.nextStageKey,
        plan: run.plan,
        roleMapping: run.roleMapping,
        agentNames,
      }),
    ]),
  );
  const hasProjects = bootstrap.projects.length > 0;
  const hasRuns = bootstrap.runs.length > 0;

  return (
    <div className="view home-view">
      <header className="home-head">
        <h1 className="page-title">{greetingFor(now)}</h1>
        <p className="home-head__meta">{summary.attentionLabel}</p>
      </header>

      {!hasProjects ? (
        <section className="home-first-run">
          <h2>Add your first project</h2>
          <p>
            Register a local repository, then choose the agents and a workflow
            template for it. Run history stays on this machine.
          </p>
          <div>
            <Button
              variant="primary"
              onClick={() => (window.location.hash = "#/projects")}
            >
              Add project
            </Button>
          </div>
        </section>
      ) : null}

      {hasProjects && !hasRuns ? (
        <section className="home-first-run">
          <h2>Start your first workflow</h2>
          <p>
            Give a registered project a goal. The plan, every handoff and every
            result are recorded here as the run progresses. Run history stays on
            this machine.
          </p>
          <div className="row">
            <Button
              variant="primary"
              onClick={() => (window.location.hash = "#/new-run")}
            >
              Start a workflow
            </Button>
          </div>
        </section>
      ) : null}

      <RunSection
        title="Needs you"
        runs={summary.needsYou}
        projectNames={projectNames}
        evidence={evidence}
      />
      <RunSection
        title="Running"
        runs={summary.running}
        projectNames={projectNames}
        details={runningDetails}
      />
      <RunSection
        title="Recent"
        runs={summary.recent}
        projectNames={projectNames}
      />

      <footer className="home-foot">
        <a className="home-foot__projects" href="#/projects">
          {bootstrap.projects.length} project
          {bootstrap.projects.length === 1 ? "" : "s"}
        </a>
      </footer>
    </div>
  );
}
