/**
 * Application shell: hash routing, the bootstrap resource, the single SSE
 * subscription and the top-level error surfaces.
 *
 * There is no alert()/confirm()/prompt() anywhere in this UI: destructive or
 * mandatory-reason actions are inline forms, and every failure renders in place.
 *
 * The client is same-origin only: the server serves the built client, and the
 * Vite dev server proxies /api (see vite.config.ts). No configurable remote base
 * URL is accepted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "./api.js";
import { useBootstrap, useDebouncedCallback, useRunEvents } from "./hooks.js";
import { parseRoute, routeHref, type Route } from "./view-model.js";
import { AgentsView } from "./components/AgentsView.js";
import { Button, Card, ErrorBox, Loading, Notice } from "./components/Bits.js";
import { Home } from "./components/Home.js";
import { Nav } from "./components/Nav.js";
import { NewRunFlow } from "./components/NewRunFlow.js";
import { ProjectsView } from "./components/ProjectsView.js";
import { RunsView } from "./components/RunsView.js";
import { RunView } from "./components/RunView.js";

export function App() {
  const client = useMemo(() => createClient({ baseUrl: "" }), []);
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const bootstrap = useBootstrap(client);
  const [streamVersion, setStreamVersion] = useState(0);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const runId = route.view === "run" ? route.runId : null;

  // One subscription for the whole app; `afterId: 0` replays persisted history and
  // mergeEvents() deduplicates by event id, so reconnects cannot double-count.
  const stream = useRunEvents({
    client,
    runId,
    afterId: 0,
    enabled: Boolean(runId) && Boolean(bootstrap.data),
  });

  const onStreamEvent = useDebouncedCallback(() => {
    setStreamVersion((current) => current + 1);
    void bootstrap.reload();
  }, 500);

  useEffect(() => {
    if (stream.events.length === 0) return;
    onStreamEvent();
  }, [stream.events.at(-1)?.id, onStreamEvent]);

  const refreshBootstrap = useCallback(async () => {
    await bootstrap.reload();
  }, [bootstrap]);

  if (bootstrap.loading && !bootstrap.data) {
    return (
      <div className="app">
        <Nav bootstrap={null} route={route} connection="connecting" />
        <main className="content">
          <div className="view">
            <Loading label="Loading bootstrap from the local AgentOps server…" />
          </div>
        </main>
      </div>
    );
  }

  if (!bootstrap.data) {
    return (
      <div className="app">
        <Nav bootstrap={null} route={route} connection="offline" />
        <main className="content">
          <div className="view">
            <Card title="Cannot reach the AgentOps server">
              <div className="stack">
                <ErrorBox
                  error={bootstrap.error}
                  onRetry={() => void bootstrap.reload()}
                />
                <p className="faint small">
                  The client talks only to the local server that served it (
                  {"same-origin"}). Start the AgentOps server, then retry. No
                  data is displayed until the bootstrap request succeeds.
                </p>
                <div>
                  <Button onClick={() => void bootstrap.reload()}>
                    Retry bootstrap
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  const data = bootstrap.data;

  return (
    <div className="app">
      <Nav
        bootstrap={data}
        route={route}
        connection={runId ? stream.status : "idle"}
      />
      <main className="content">
        <header className="topbar">
          <div className="topbar__title">
            <h1>{titleFor(route)}</h1>
            <span className="topbar__goal">
              {subtitleFor(route, data.runs.length)}
            </span>
          </div>
          <div className="topbar__spacer" />
          {runId ? (
            <span className="faint small">
              stream {stream.status}
              {stream.status === "unsupported"
                ? " (EventSource unavailable in this browser)"
                : ""}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (window.location.hash = "#/runs")}
          >
            History
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              (window.location.hash = routeHref({
                view: "new-run",
                projectId: null,
              }))
            }
          >
            New workflow
          </Button>
        </header>

        {bootstrap.error ? (
          <div className="view" style={{ paddingBottom: 0 }}>
            <Notice
              tone="warn"
              title="The last bootstrap refresh failed; showing the last successful payload."
            >
              {bootstrap.error}
            </Notice>
          </div>
        ) : null}

        {route.view === "home" ? <Home bootstrap={data} /> : null}
        {route.view === "projects" ? (
          <ProjectsView
            client={client}
            bootstrap={data}
            selectedId={route.projectId}
            refreshBootstrap={refreshBootstrap}
          />
        ) : null}
        {route.view === "agents" ? (
          <AgentsView
            client={client}
            bootstrap={data}
            refreshBootstrap={refreshBootstrap}
          />
        ) : null}
        {route.view === "runs" ? (
          <RunsView client={client} bootstrap={data} />
        ) : null}
        {route.view === "new-run" ? (
          <NewRunFlow
            client={client}
            bootstrap={data}
            initialProjectId={route.projectId}
            refreshBootstrap={refreshBootstrap}
          />
        ) : null}
        {route.view === "run" ? (
          <RunView
            client={client}
            bootstrap={data}
            runId={route.runId}
            refreshBootstrap={refreshBootstrap}
            streamEvents={stream.events}
            streamStatus={stream.status}
            streamVersion={streamVersion}
          />
        ) : null}

        <footer className="view faint small" style={{ paddingTop: 0 }}>
          AgentOps {data.version} · {data.projects.length} project(s) ·{" "}
          {data.agents.length} agent(s) · {data.templates.length} template(s) ·{" "}
          {data.runs.length} run(s) · local-only server, same-origin client.
        </footer>
      </main>
    </div>
  );
}

function titleFor(route: Route): string {
  switch (route.view) {
    case "home":
      return "Mission control";
    case "projects":
      return "Projects";
    case "agents":
      return "Agents";
    case "runs":
      return "Run history";
    case "run":
      return "Run";
    case "new-run":
      return "New workflow";
    default:
      return "AgentOps";
  }
}

function subtitleFor(route: Route, runCount: number): string {
  if (route.view === "runs")
    return "persisted search across projects, agents, status, dates, branch and verdict";
  if (route.view === "run") return route.runId;
  if (route.view === "home") return `${runCount} run(s) on record`;
  return "";
}
