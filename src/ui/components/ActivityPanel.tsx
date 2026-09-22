/**
 * Activity: what happened on this run, in plain sentences.
 *
 * The list is the run's lifecycle — started, finished, failed, waiting for you,
 * approved, rejected — one short line each, with the time. Agent output,
 * protocol frames and tool calls never appear here: they are the raw log stream,
 * which lives in its own disclosure with its own stream/severity filters and its
 * own follow behaviour.
 */
import { useMemo, useState } from "react";
import type {
  AgentRecord,
  EventRecord,
  StageRecord,
  TaskRecord,
} from "../../core/types.js";
import { formatClock, formatTimestamp } from "../view-model.js";
import {
  activityEntries,
  activityEvent,
  rawLogEntries,
  type ActivityEntry,
} from "../run-view.js";
import { Button, Disclosure } from "./Bits.js";
import { RawLogStream } from "./RawLogStream.js";

export function ActivityPanel({
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
  attempts: readonly {
    id: string;
    attemptNumber: number;
    stageKey: string;
    agentId: string | null;
  }[];
  error?: string | null;
  onReload?: () => void;
}) {
  const [attentionOnly, setAttentionOnly] = useState(false);

  const context = useMemo(
    () => ({
      stageNames: new Map(stages.map((stage) => [stage.key, stage.name])),
      attemptNumbers: new Map(
        attempts.map((attempt) => [attempt.id, attempt.attemptNumber]),
      ),
      agentNames: new Map(agents.map((agent) => [agent.id, agent.name])),
      attemptAgents: new Map(
        attempts.map((attempt) => [
          attempt.id,
          agents.find((agent) => agent.id === attempt.agentId)?.name ?? "",
        ]),
      ),
    }),
    [stages, attempts, agents],
  );

  const entries: ActivityEntry[] = useMemo(
    () => activityEntries(events, context, { attentionOnly }).slice().reverse(),
    [events, context, attentionOnly],
  );
  const raw = useMemo(() => rawLogEntries(events, context), [events, context]);
  const skipped = events.filter((event) => !activityEvent(event)).length;

  return (
    <div className="panel panel--activity">
      <div className="activity__bar">
        <h3>Activity</h3>
        <span className="faint small">Newest first</span>
        <div className="activity__follow">
          <Button
            size="sm"
            variant={attentionOnly ? "primary" : "default"}
            aria-pressed={attentionOnly}
            onClick={() => setAttentionOnly((current) => !current)}
          >
            {attentionOnly ? "Showing problems" : "Problems only"}
          </Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="faint small">
          {events.length === 0
            ? "This run has not done anything yet."
            : attentionOnly
              ? "Nothing went wrong on this run."
              : "No run activity was recorded."}
        </p>
      ) : (
        <ol className="activity__list" aria-label="Run activity">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="activity__row"
              data-attention={entry.attention ? "true" : undefined}
            >
              <span
                className="activity__time"
                title={formatTimestamp(entry.at)}
              >
                {formatClock(entry.at)}
              </span>
              <span className="activity__text wrap-anywhere">
                {entry.sentence}
              </span>
            </li>
          ))}
        </ol>
      )}

      <Disclosure
        summary={`Raw logs (${raw.length} lines${
          skipped > 0 ? `, ${skipped} output frames` : ""
        })`}
      >
        <RawLogStream
          lines={raw}
          streamStatus={streamStatus}
          stages={stages}
          tasks={tasks}
          agents={agents}
          attempts={attempts}
          error={error}
          onReload={onReload}
        />
      </Disclosure>
    </div>
  );
}
