/**
 * Left navigation: AGENTOPS wordmark, workspace routes, registered projects and
 * the runs that need attention. Counts come from the bootstrap payload only.
 */
import type { Bootstrap } from "../api.js";
import type { Route } from "../view-model.js";
import { classNames, routeHref, type Tone } from "../view-model.js";

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

export function Nav({
  bootstrap,
  route,
  connection,
}: {
  bootstrap: Bootstrap | null;
  route: Route;
  connection: string;
}) {
  const projects = bootstrap?.projects ?? [];
  const runs = bootstrap?.runs ?? [];
  const open = runs.filter(
    (run) => run.status !== "COMPLETED" && run.status !== "CANCELLED",
  );
  const waiting = runs.filter(
    (run) =>
      run.status === "WAITING_APPROVAL" || run.status === "WAITING_INPUT",
  );
  const active = route.view === "run" ? route.runId : null;
  const projectId =
    route.view === "projects" || route.view === "new-run"
      ? route.projectId
      : null;

  return (
    <nav className="nav" aria-label="Primary">
      <a className="brand" href="#/">
        <span className="brand__mark">
          AGENT<span>OPS</span>
        </span>
        <span className="brand__sub">Local run control</span>
      </a>

      <div className="nav__section">
        <p className="nav__label">Workspace</p>
        <a
          className="nav__item"
          href="#/"
          aria-current={route.view === "home" ? "page" : undefined}
        >
          Dashboard
        </a>
        <a
          className="nav__item"
          href="#/projects"
          aria-current={route.view === "projects" ? "page" : undefined}
        >
          Projects
          <span className="nav__count">{projects.length}</span>
        </a>
        <a
          className="nav__item"
          href="#/agents"
          aria-current={route.view === "agents" ? "page" : undefined}
        >
          Agents
          <span className="nav__count">{bootstrap?.agents.length ?? 0}</span>
        </a>
        <a
          className="nav__item"
          href="#/runs"
          aria-current={route.view === "runs" ? "page" : undefined}
        >
          Run history
          <span className="nav__count">{runs.length}</span>
        </a>
        <a
          className="nav__item"
          href="#/new-run"
          aria-current={route.view === "new-run" ? "page" : undefined}
        >
          New workflow
          <span className="nav__dot" aria-hidden="true" />
        </a>
      </div>

      <div className="nav__section">
        <p className="nav__label">
          Open runs{" "}
          {waiting.length > 0 ? (
            <span style={{ color: "var(--amber)" }}>
              · {waiting.length} need you
            </span>
          ) : null}
        </p>
        {open.length === 0 ? (
          <p className="nav__project faint small">No open runs</p>
        ) : (
          open.slice(0, 8).map((run) => (
            <a
              key={run.id}
              className="nav__item"
              href={routeHref({ view: "run", runId: run.id })}
              aria-current={active === run.id ? "page" : undefined}
              title={run.goal}
            >
              <span
                className={dotClass(toneForStatus(run.status))}
                aria-hidden="true"
              />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "15ch",
                }}
              >
                {run.goal}
              </span>
            </a>
          ))
        )}
      </div>

      <div className="nav__section">
        <p className="nav__label">Projects</p>
        {projects.length === 0 ? (
          <p className="nav__project faint small">None registered yet</p>
        ) : (
          projects.map((project) => (
            <a
              key={project.id}
              className="nav__project"
              href={routeHref({ view: "projects", projectId: project.id })}
              aria-current={projectId === project.id ? "page" : undefined}
              title={project.canonicalRoot}
            >
              {project.name}
            </a>
          ))
        )}
      </div>

      <div className="nav__footer">
        <div className={classNames("row", "row--tight")}>
          <span
            className="nav__dot"
            style={{
              background:
                connection === "live"
                  ? "var(--mint)"
                  : connection === "reconnecting"
                    ? "var(--amber)"
                    : "var(--text-faint)",
            }}
            aria-hidden="true"
          />
          <span>event stream: {connection}</span>
        </div>
        <div>v{bootstrap?.version ?? "unavailable"}</div>
      </div>
    </nav>
  );
}
