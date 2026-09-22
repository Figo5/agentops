/**
 * Operational home: what needs you, what is running, what finished recently.
 *
 * This is a working screen, not an inventory: templates, agents and workspace
 * counts have their own screens and are not repeated here. Empty categories are
 * not rendered at all, so a quiet day is a short page instead of a wall of
 * placeholder cards. Every number comes from the bootstrap payload.
 */
import type { Bootstrap } from "../api.js";
import { greetingFor, homeSummary } from "../view-model.js";
import { Button } from "./Bits.js";
import { RunSection } from "./RunRow.js";

export function Home({
  bootstrap,
  now = new Date(),
}: {
  bootstrap: Bootstrap;
  /** Injectable clock so the greeting is deterministic in tests. */
  now?: Date;
}) {
  const projectNames = Object.fromEntries(
    bootstrap.projects.map((project) => [project.id, project.name]),
  );
  const summary = homeSummary(bootstrap.runs);
  const hasProjects = bootstrap.projects.length > 0;
  const hasRuns = bootstrap.runs.length > 0;

  return (
    <div className="view home-view">
      <header className="home-head">
        <h1 className="page-title">{greetingFor(now)}</h1>
        <p className="home-head__meta">
          {summary.attentionLabel}
          {hasProjects
            ? ` · ${bootstrap.projects.length} project${bootstrap.projects.length === 1 ? "" : "s"}`
            : ""}
        </p>
      </header>

      {!hasProjects ? (
        <section className="home-first-run">
          <h2>Add your first project</h2>
          <p>
            Register a local repository, then choose the agents and a workflow
            template for it. Everything an agent does stays on this machine.
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
            result are recorded here as the run progresses.
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
        hint="Gates and failures wait for a deliberate decision; the run never advances on its own."
      />
      <RunSection
        title="Running"
        runs={summary.running}
        projectNames={projectNames}
        hint="One active workflow per repository."
      />
      <RunSection
        title="Recent"
        runs={summary.recent}
        projectNames={projectNames}
        hint="Terminal runs are read-only history."
      />

      <footer className="home-foot">
        <a href="#/projects">
          {bootstrap.projects.length} project
          {bootstrap.projects.length === 1 ? "" : "s"}
        </a>
        <span aria-hidden="true">·</span>
        <a href="#/runs">Run history</a>
      </footer>
    </div>
  );
}
