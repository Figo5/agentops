/**
 * Left navigation: the AGENTOPS wordmark, the four places an operator goes, and
 * a compact list of the runs that need them.
 *
 * The sidebar is navigation, not an inventory: no project list, no open-run
 * list, no counters that repeat what a screen already says. The `Needs you`
 * block names the project of each run that is blocked on a human (at most a few,
 * with the goal as the link's title) so the operator can see what is stuck
 * without opening the dashboard. `+ New workflow` sits at the bottom, where the
 * settings entry point will join it.
 */
import type { Bootstrap } from "../api.js";
import {
  routeHref,
  homeSummary,
  type Route,
  type Tone,
} from "../view-model.js";

function dotClass(tone: Tone): string {
  if (tone === "active") return "nav__dot nav__dot--active";
  if (tone === "warn") return "nav__dot nav__dot--warn";
  if (tone === "danger") return "nav__dot nav__dot--danger";
  return "nav__dot";
}

function toneForStatus(status: string): Tone {
  if (status === "RUNNING") return "active";
  if (status === "WAITING_APPROVAL" || status === "WAITING_INPUT")
    return "warn";
  if (status === "FAILED" || status === "INTERRUPTED") return "danger";
  return "neutral";
}

/** How many blocked runs the sidebar names before deferring to the dashboard. */
export const NAV_NEEDS_YOU_LIMIT = 3;

export function Nav({
  bootstrap,
  route,
}: {
  bootstrap: Bootstrap | null;
  route: Route;
}) {
  const projects = bootstrap?.projects ?? [];
  const runs = bootstrap?.runs ?? [];
  // Same model as the dashboard, so the two can never disagree about what needs
  // the operator or in which order.
  const needsYou = homeSummary(runs).needsYou;
  const projectNames = Object.fromEntries(
    projects.map((project) => [project.id, project.name]),
  );
  const active = route.view === "run" ? route.runId : null;

  return (
    <nav className="nav" aria-label="Primary">
      <a className="brand" href="#/">
        <span className="brand__mark">
          AGENT<span>OPS</span>
        </span>
        <span className="brand__sub">Local run control</span>
      </a>

      <div className="nav__section">
        <a
          className="nav__item"
          href="#/"
          aria-current={route.view === "home" ? "page" : undefined}
        >
          Today
        </a>
        <a
          className="nav__item"
          href="#/projects"
          aria-current={route.view === "projects" ? "page" : undefined}
        >
          Projects
        </a>
        <a
          className="nav__item"
          href="#/agents"
          aria-current={route.view === "agents" ? "page" : undefined}
        >
          Agents
        </a>
        <a
          className="nav__item"
          href="#/runs"
          aria-current={route.view === "runs" ? "page" : undefined}
        >
          History
        </a>
      </div>

      <div className="nav__section nav__section--ruled">
        <p className="nav__label">Needs you</p>
        {needsYou.length === 0 ? (
          <p className="nav__empty">Nothing needs you</p>
        ) : (
          needsYou.slice(0, NAV_NEEDS_YOU_LIMIT).map((run) => {
            const project = projectNames[run.projectId] ?? run.projectId;
            return (
              <a
                key={run.id}
                className="nav__item nav__item--needs"
                href={routeHref({ view: "run", runId: run.id })}
                aria-current={active === run.id ? "page" : undefined}
                title={`${project} — ${run.goal}`}
              >
                <span
                  className={dotClass(toneForStatus(run.status))}
                  aria-hidden="true"
                />
                <span className="nav__needs-label">{project}</span>
              </a>
            );
          })
        )}
        {needsYou.length > NAV_NEEDS_YOU_LIMIT ? (
          <a className="nav__more" href="#/">
            {needsYou.length - NAV_NEEDS_YOU_LIMIT} more on Today
          </a>
        ) : null}
      </div>

      <div className="nav__bottom">
        <a
          className="nav__item nav__item--new"
          href="#/new-run"
          aria-current={route.view === "new-run" ? "page" : undefined}
        >
          <span aria-hidden="true">+</span> New workflow
        </a>
      </div>
    </nav>
  );
}
