/**
 * The application: one screen.
 *
 * The field fills the window, the activity column reads out what agents
 * reported, and a session strip filters both. There is no router, because there
 * is nowhere else to go.
 *
 * There is no alert()/confirm()/prompt() anywhere in this UI, and every failure
 * renders in place.
 */
import { useCallback, useMemo, useState } from "react";
import { createClient } from "./api.js";
import { foldConstellation, type Card } from "./constellation.js";
import { useAction, useBootstrap, useEventStream } from "./hooks.js";
import { Field } from "./components/Field.js";
import {
  Button,
  Disclosure,
  ErrorBox,
  Notice,
  Pill,
  TextArea,
} from "./components/Bits.js";

function relative(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

function CardView({
  card,
  now,
  onReply,
}: {
  card: Card;
  now: number;
  onReply: (card: Card, text: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const sent = await onReply(card, text);
    setBusy(false);
    if (sent) {
      setText("");
      setOpen(false);
    } else setError("The reply was not accepted. Nothing was sent.");
  };

  return (
    <li
      className={`card-row card-row--${card.tone}${
        card.awaitingYou ? " card-row--blocking" : ""
      }`}
    >
      <div className="card-row__head">
        <span className="card-row__actor">{card.actor}</span>
        {card.verdict ? (
          <Pill
            tone={
              card.tone === "neutral"
                ? "info"
                : card.tone === "success"
                  ? "success"
                  : card.tone
            }
          >
            {card.verdict}
          </Pill>
        ) : null}
        {card.awaitingYou ? <Pill tone="warn">Waiting</Pill> : null}
        <span className="faint small card-row__time">
          {relative(card.createdAt, now)}
        </span>
      </div>

      {card.summary ? (
        <p className="card-row__summary">{card.summary}</p>
      ) : (
        <p className="card-row__summary faint">
          {card.action} — no summary reported
        </p>
      )}

      <p className="faint small wrap-anywhere">
        {card.action}
        {card.provider ? ` · ${card.provider}` : ""}
        {card.session ? ` · ${card.session}` : ""}
        {card.issues.length > 0
          ? ` · ${card.issues.length} finding${card.issues.length === 1 ? "" : "s"}`
          : ""}
      </p>

      {card.issues.length > 0 ? (
        <Disclosure summary={`Findings (${card.issues.length})`}>
          <ul className="findings">
            {card.issues.map((issue, index) => (
              <li key={`${card.id}-${index}`} className="small wrap-anywhere">
                {issue.severity ? <b>{issue.severity}</b> : null}
                {issue.path
                  ? ` · ${issue.path}${issue.line ? `:${issue.line}` : ""}`
                  : ""}
                {issue.severity || issue.path ? " — " : ""}
                {issue.description}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {Object.keys(card.detail).length > 0 ? (
        <Disclosure summary="Detail">
          <pre className="detail">{JSON.stringify(card.detail, null, 2)}</pre>
        </Disclosure>
      ) : null}

      {card.session ? (
        open ? (
          <div className="stack--tight">
            <TextArea
              value={text}
              onChange={setText}
              rows={3}
              ariaLabel={`Reply to ${card.actor}`}
              placeholder="Your agent sees this on the session stream."
            />
            <div className="row">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || text.trim().length === 0}
                onClick={() => void submit()}
              >
                Send reply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            {error ? <ErrorBox error={error} /> : null}
          </div>
        ) : (
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Reply
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

export function App() {
  const client = useMemo(() => createClient({ baseUrl: "" }), []);
  const bootstrap = useBootstrap(client);
  const [session, setSession] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const reply = useAction(client);

  // One subscription for the whole app. The bootstrap window seeds it, so the
  // field is populated before the first live event arrives.
  const stream = useEventStream({
    client,
    session: null,
    enabled: Boolean(bootstrap.data),
    seed: bootstrap.data?.events,
  });

  const now = Date.now();
  const state = useMemo(
    () =>
      foldConstellation({ events: stream.events, session, now: Date.now() }),
    [stream.events, session],
  );

  const onReply = useCallback(
    async (card: Card, text: string) => {
      const result = await reply.run((api) =>
        api.send({
          actor: "operator",
          action: "reply",
          session: card.session,
          target: card.actor,
          summary: text,
          status: "ok",
        }),
      );
      return Boolean(result && result.accepted === 1);
    },
    [reply],
  );

  const visibleCards = actor
    ? state.cards.filter((card) => card.actor === actor)
    : state.cards;
  const waiting = state.cards.filter((card) => card.awaitingYou).length;

  // Render the shell immediately, from whatever has arrived: a slow or stalled
  // bootstrap must never wall the whole page behind a spinner. Only a bootstrap
  // that has finished *without* data is a failure worth its own screen.
  if (!bootstrap.data && !bootstrap.loading)
    return (
      <div className="app app--empty">
        <div className="stack" style={{ maxWidth: 560 }}>
          <h1>Cannot reach the server</h1>
          <ErrorBox
            error={bootstrap.error}
            onRetry={() => void bootstrap.reload()}
          />
          <p className="faint small">
            This page talks only to the server that served it. Start it with{" "}
            <code>npm start</code>, then retry.
          </p>
        </div>
      </div>
    );

  const empty = state.stars.length === 0;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          AGENT<span>OPS</span>
        </span>
        <span className="bar__stat">
          {state.stars.length} agent{state.stars.length === 1 ? "" : "s"}
          {state.liveActors > 0 ? ` · ${state.liveActors} working` : ""}
          {waiting > 0 ? ` · ${waiting} waiting on you` : ""}
        </span>
        <span className="bar__spacer" />
        <span className={`bar__stream bar__stream--${stream.status}`}>
          {bootstrap.loading
            ? "connecting"
            : stream.status === "live"
              ? "live"
              : stream.status === "unsupported"
                ? "no EventSource in this browser"
                : stream.status}
        </span>
      </header>

      {state.sessions.length > 0 ? (
        <div className="sessions" role="group" aria-label="Sessions">
          <button
            type="button"
            className={`chip${session === null ? " chip--on" : ""}`}
            onClick={() => setSession(null)}
          >
            All sessions
          </button>
          {state.sessions.map((item) => (
            <button
              type="button"
              key={item.session}
              className={`chip${session === item.session ? " chip--on" : ""}${
                item.live ? " chip--live" : ""
              }`}
              onClick={() =>
                setSession(session === item.session ? null : item.session)
              }
              title={`${item.actors} agents · ${item.events} events${
                item.providers.length > 0
                  ? ` · ${item.providers.join(", ")}`
                  : ""
              }`}
            >
              {item.session}
              <span className="chip__count">{item.actors}</span>
            </button>
          ))}
        </div>
      ) : null}

      <main className="stage">
        <div className="field">
          <Field
            events={stream.events}
            session={session}
            onSelectActor={setActor}
          />
          {empty ? (
            <div className="field__empty">
              <h2>Nothing is reporting yet</h2>
              <p className="faint">
                Point an agent at this server and it appears here. One event is
                enough:
              </p>
              <pre className="detail">{`curl -s localhost:4317/ingest \\
  -H 'content-type: application/json' \\
  -d '{"actor":"my-agent","action":"hello","status":"running"}'`}</pre>
              <p className="faint small">
                The README is written for an agent: tell yours to read it and
                wire itself up.
              </p>
            </div>
          ) : null}
        </div>

        <aside className="column" aria-label="Activity">
          <div className="column__head">
            <h2>{actor ? actor : "Activity"}</h2>
            {actor ? (
              <Button size="sm" variant="ghost" onClick={() => setActor(null)}>
                Clear
              </Button>
            ) : null}
          </div>
          {reply.notice ? <Notice tone="success">{reply.notice}</Notice> : null}
          {visibleCards.length === 0 ? (
            <p className="faint small">
              Verdicts, blockers and errors land here. Anything an agent sends
              with a <code>verdict</code>, or a <code>status</code> of{" "}
              <code>blocked</code> or <code>error</code>, shows up with its
              summary line.
            </p>
          ) : (
            <ul className="card-list">
              {visibleCards.map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  now={now}
                  onReply={onReply}
                />
              ))}
            </ul>
          )}
        </aside>
      </main>
    </div>
  );
}
