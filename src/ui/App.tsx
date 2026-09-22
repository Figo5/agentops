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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** Fragment the skip link points at; never a route. */
const SKIP_TARGET_HASH = "#main-content";

/**
 * The element that actually scrolls this document. `document.scrollingElement`
 * is the standards-mode scroller (the window scroll position is its scrollTop),
 * so read/write go through it instead of assuming `window.scrollY`.
 */
function scroller(): HTMLElement | null {
  return (
    (document.scrollingElement as HTMLElement | null) ??
    document.documentElement ??
    null
  );
}

function readScrollTop(): number {
  const element = scroller();
  if (element) return element.scrollTop;
  return typeof window.scrollY === "number" ? window.scrollY : 0;
}

function writeScrollTop(top: number): void {
  const element = scroller();
  if (element) {
    element.scrollTop = top;
    return;
  }
  if (typeof window.scrollTo === "function")
    window.scrollTo({ top, behavior: "auto" });
}

export function App() {
  const client = useMemo(() => createClient({ baseUrl: "" }), []);
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const bootstrap = useBootstrap(client);
  const [streamVersion, setStreamVersion] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);
  /** Scroll position per route, so going back restores where the operator was. */
  const scrollMemory = useRef(new Map<string, number>());
  /** Scroll target for the navigation currently being applied. */
  const pendingScroll = useRef<number | undefined>(undefined);
  const routeKeyRef = useRef(routeHref(route));
  const firstRender = useRef(true);

  useEffect(() => {
    // The app owns scroll behaviour: browser-side restoration would fight the
    // per-route positions kept below.
    if ("scrollRestoration" in window.history)
      window.history.scrollRestoration = "manual";
    // Every entry this app creates is stamped with a monotonic index. A hash
    // change whose entry already carries an older index came from the browser's
    // history (back/forward); a fresh entry (no index) is a new navigation.
    // `popstate` is not used as the signal: Chromium also fires it for a plain
    // hash assignment, which would misclassify forward navigations as traversal.
    const stamp = (index: number) => {
      window.history.replaceState(
        { ...(window.history.state ?? {}), agentopsIndex: index },
        "",
      );
    };
    const stateIndex = (): number | null => {
      const raw = (window.history.state as { agentopsIndex?: unknown } | null)
        ?.agentopsIndex;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    };
    const currentIndex = stateIndex();
    if (currentIndex === null) stamp(0);
    const indexRef = { current: currentIndex ?? 0 };
    const onHashChange = () => {
      // The skip link's fragment is not a route: never let it navigate away.
      if (window.location.hash === SKIP_TARGET_HASH) return;
      const next = parseRoute(window.location.hash);
      const previousKey = routeKeyRef.current;
      const nextKey = routeHref(next);
      if (previousKey === nextKey) return;
      const index = stateIndex();
      const traversal = index !== null && index !== indexRef.current;
      if (index === null) {
        indexRef.current += 1;
        stamp(indexRef.current);
      } else {
        indexRef.current = index;
      }
      const restore = traversal ? scrollMemory.current.get(nextKey) : undefined;
      scrollMemory.current.set(previousKey, readScrollTop());
      pendingScroll.current = restore;
      setRoute(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  /**
   * Skip link: move focus to the main landmark instead of letting the browser
   * follow the fragment, which the hash router would otherwise read as a route
   * change (and render the dashboard over the current view).
   */
  const focusMainContent = useCallback(() => {
    mainRef.current?.focus({ preventScroll: true });
    writeScrollTop(0);
  }, []);

  // Route focus and scroll: a new view starts at the top with focus on <main>;
  // a history traversal restores the position the operator left. The target is
  // re-applied a few times because a view that fetches on mount is shorter than
  // its final height, which would otherwise clamp the restore to the top.
  useEffect(() => {
    const key = routeHref(route);
    routeKeyRef.current = key;
    if (firstRender.current) {
      firstRender.current = false;
      pendingScroll.current = undefined;
      return;
    }
    const target = pendingScroll.current;
    pendingScroll.current = undefined;
    mainRef.current?.focus({ preventScroll: true });
    if (typeof window.scrollTo !== "function") return;
    // The browser also restores the session-history entry's own offset shortly
    // after a hash navigation, which lands *after* the first write here. Keep
    // correcting until the position is stable, bounded to ~700 ms so the
    // operator's own scrolling is never fought for long.
    const desired = target ?? 0;
    let cancelled = false;
    let attempts = 0;
    let stable = 0;
    const timers: number[] = [];
    const apply = () => {
      if (cancelled) return;
      if (Math.abs(readScrollTop() - desired) <= 2) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
        writeScrollTop(desired);
      }
      attempts += 1;
      if (attempts < 6) timers.push(window.setTimeout(apply, 120));
    };
    apply();
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [route]);

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
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            // Keep the fragment for the accessible name, but never let it
            // become a hash route.
            event.preventDefault();
            focusMainContent();
          }}
        >
          Skip to main content
        </a>
        <Nav bootstrap={null} route={route} connection="connecting" />
        <main className="content" id="main-content" tabIndex={-1} ref={mainRef}>
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
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            // Keep the fragment for the accessible name, but never let it
            // become a hash route.
            event.preventDefault();
            focusMainContent();
          }}
        >
          Skip to main content
        </a>
        <Nav bootstrap={null} route={route} connection="offline" />
        <main className="content" id="main-content" tabIndex={-1} ref={mainRef}>
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
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          // Keep the fragment for the accessible name, but never let it become
          // a hash route.
          event.preventDefault();
          focusMainContent();
        }}
      >
        Skip to main content
      </a>
      <Nav
        bootstrap={data}
        route={route}
        connection={runId ? stream.status : "idle"}
      />
      <main className="content" id="main-content" tabIndex={-1} ref={mainRef}>
        <header className="topbar">
          <div className="topbar__title">
            {route.view === "run" ? (
              /* The run view owns the page heading: the goal is the 30px h1. */
              <span className="topbar__crumb">{titleFor(route)}</span>
            ) : (
              <h1>{titleFor(route)}</h1>
            )}
            <span className="topbar__goal">
              {subtitleFor(route, data.runs.length)}
            </span>
          </div>
          <div className="topbar__spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (window.location.hash = "#/runs")}
          >
            History
          </Button>
          <Button
            size="sm"
            /* On a run page the task at hand is that run: starting a new
               workflow is quiet navigation, not the primary action. */
            variant={route.view === "run" ? "ghost" : "primary"}
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
  /* A run's own screen shows its project, goal and state: never a raw id here. */
  if (route.view === "run") return "";
  if (route.view === "home") return `${runCount} run(s) on record`;
  return "";
}
