/**
 * Logs drawer: the persisted event timeline for the selected run, streamed over
 * SSE. Filtering by category, stage (task), attempt and actor is client-side over
 * the already-fetched events; the stream itself is server-authoritative.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRecord,
  EventRecord,
  StageRecord,
  TaskRecord,
} from "../../core/types.js";
import {
  ALL_EVENT_CATEGORIES,
  categoryCounts,
  eventMessage,
  filterEvents,
  formatClock,
  formatTimestamp,
  statusLabel,
  type EventFilter,
} from "../view-model.js";
import { Button, ErrorBox, Pill, Select, TextInput } from "./Bits.js";

export function LogsDrawer({
  events,
  streamStatus,
  stages,
  tasks,
  agents,
  attempts,
  error,
  onReload,
}: {
  events: readonly EventRecord[];
  streamStatus: string;
  stages: readonly StageRecord[];
  tasks: readonly TaskRecord[];
  agents: readonly AgentRecord[];
  attempts: readonly { id: string; attemptNumber: number; stageKey: string }[];
  error?: string | null;
  onReload?: () => void;
}) {
  const [categories, setCategories] = useState<string[]>([]);
  const [stageKey, setStageKey] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [actor, setActor] = useState("");
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => categoryCounts(events), [events]);

  const filtered = useMemo(() => {
    const filter: EventFilter = {
      categories:
        categories.length > 0
          ? (categories as EventFilter["categories"])
          : undefined,
      actors: actor ? ([actor] as EventFilter["actors"]) : undefined,
      attempts: attemptId ? [attemptId] : undefined,
      text,
    };
    const base = filterEvents(events, filter);
    return stageKey
      ? base.filter((event) => event.stageKey === stageKey)
      : base;
  }, [events, categories, actor, attemptId, text, stageKey]);

  useEffect(() => {
    const container = endRef.current?.parentElement;
    if (follow && container) container.scrollTop = container.scrollHeight;
  }, [filtered.length, follow]);

  const actors = useMemo(
    () => [...new Set(events.map((event) => event.actor))].sort(),
    [events],
  );

  return (
    <section className="drawer" aria-label="Run event log">
      <div className="drawer__head">
        <h3>
          Log stream{" "}
          <Pill
            tone={
              streamStatus === "live"
                ? "success"
                : streamStatus === "reconnecting"
                  ? "warn"
                  : "muted"
            }
          >
            {streamStatus}
          </Pill>
        </h3>
        <span className="faint small">
          {filtered.length} / {events.length} events · newest id{" "}
          {events.length > 0 ? events[events.length - 1]?.id : "none"}
        </span>
        <div
          className="drawer__filters"
          role="group"
          aria-label="Event category filters"
        >
          {ALL_EVENT_CATEGORIES.map((category) => {
            const active = categories.includes(category);
            const count =
              counts.find((entry) => entry.category === category)?.count ?? 0;
            return (
              <button
                key={category}
                type="button"
                className="chip"
                aria-pressed={active}
                disabled={count === 0}
                onClick={() =>
                  setCategories((current) =>
                    current.includes(category)
                      ? current.filter((value) => value !== category)
                      : [...current, category],
                  )
                }
              >
                {category} {count}
              </button>
            );
          })}
        </div>
        <div className="drawer__filters">
          <Select
            ariaLabel="Filter by stage"
            value={stageKey}
            onChange={setStageKey}
            placeholder="All stages"
            options={stages.map((stage) => ({
              value: stage.key,
              label: `${stage.name} (${statusLabel(stage.status)})`,
            }))}
          />
          <Select
            ariaLabel="Filter by attempt"
            value={attemptId}
            onChange={setAttemptId}
            placeholder="All attempts"
            options={attempts.map((attempt) => ({
              value: attempt.id,
              label: `#${attempt.attemptNumber} ${attempt.stageKey}`,
            }))}
          />
          <Select
            ariaLabel="Filter by actor"
            value={actor}
            onChange={setActor}
            placeholder="All actors"
            options={actors.map((value) => ({ value, label: value }))}
          />
          <TextInput
            ariaLabel="Filter log text"
            value={text}
            onChange={setText}
            placeholder="search text"
          />
          <Button
            size="sm"
            variant={follow ? "primary" : "default"}
            onClick={() => setFollow((current) => !current)}
          >
            {follow ? "Following" : "Follow"}
          </Button>
          {onReload ? (
            <Button size="sm" variant="ghost" onClick={onReload}>
              Reload
            </Button>
          ) : null}
        </div>
      </div>

      <ErrorBox error={error ?? null} onRetry={onReload} />

      {filtered.length === 0 ? (
        <p className="faint small">
          No events match the current filters.{" "}
          {events.length === 0
            ? "The run has not recorded any events yet."
            : ""}
        </p>
      ) : (
        <div
          className="terminal terminal--tall"
          role="log"
          aria-live="off"
          aria-relevant="additions"
        >
          {filtered.map((event) => {
            const attempt = attempts.find(
              (candidate) => candidate.id === event.attemptId,
            );
            const agent = agents.find(
              (candidate) =>
                candidate.id ===
                (event.payload["agentId"] as string | undefined),
            );
            return (
              <div key={event.id} className="terminal__line">
                <span
                  className="terminal__time"
                  title={formatTimestamp(event.createdAt)}
                >
                  {formatClock(event.createdAt)}
                </span>
                <span className="terminal__actor">{event.actor}</span>
                <span className="wrap-anywhere">
                  <span className="faint mono">
                    {event.category}/{event.type}
                    {event.stageKey ? ` · ${event.stageKey}` : ""}
                    {attempt ? ` · attempt #${attempt.attemptNumber}` : ""}
                    {agent ? ` · ${agent.name}` : ""}
                  </span>{" "}
                  {eventMessage(event)}
                </span>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      )}
      <p className="faint small" style={{ marginTop: 8 }}>
        Showing the latest captured events. Filters apply to this log buffer.
      </p>
      {tasks.length > 0 ? (
        <p className="sr-only">
          {tasks.length} task records exist for this run; the stage filter above
          is the task selector.
        </p>
      ) : null}
    </section>
  );
}
