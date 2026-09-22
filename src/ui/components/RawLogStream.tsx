/**
 * Raw log stream: every persisted event line, with its own filters and its own
 * follow behaviour.
 *
 * This is the audit surface, so nothing is summarised away. It filters by
 * stream (stdout / stderr / system), by severity (needs attention / output /
 * everything) and — behind the advanced disclosure — by category, stage,
 * attempt, actor and free text. Following behaves like a terminal: it pauses as
 * soon as the operator scrolls up, counts the lines that arrived meanwhile and
 * offers a jump back to the newest line.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRecord,
  StageRecord,
  TaskRecord,
} from "../../core/types.js";
import {
  ALL_EVENT_CATEGORIES,
  formatClock,
  formatTimestamp,
  statusLabel,
} from "../view-model.js";
import {
  EVENT_SEVERITY_FILTERS,
  EVENT_SEVERITY_FILTER_LABELS,
  type EventSeverity,
  type EventSeverityFilter,
  type RawLogLineView,
} from "../run-view.js";
import {
  Button,
  Checkbox,
  Disclosure,
  ErrorBox,
  Pill,
  Select,
  TextInput,
} from "./Bits.js";

const STREAM_FILTERS = ["all", "stdout", "stderr", "system", "run"] as const;
type StreamFilter = (typeof STREAM_FILTERS)[number];

const STREAM_FILTER_LABELS: Record<StreamFilter, string> = {
  all: "All streams",
  stdout: "stdout",
  stderr: "stderr",
  system: "system",
  run: "run events",
};

const SEVERITY_TONES: Record<EventSeverity, "danger" | "info" | "muted"> = {
  attention: "danger",
  progress: "info",
  detail: "muted",
};

export function RawLogStream({
  lines,
  streamStatus,
  stages,
  tasks,
  agents,
  attempts,
  error,
  onReload,
}: {
  lines: readonly RawLogLineView[];
  streamStatus: string;
  stages: readonly StageRecord[];
  tasks: readonly TaskRecord[];
  agents: readonly AgentRecord[];
  attempts: readonly { id: string; attemptNumber: number; stageKey: string }[];
  error?: string | null;
  onReload?: () => void;
}) {
  const [stream, setStream] = useState<StreamFilter>("all");
  const [severity, setSeverity] = useState<EventSeverityFilter>("everything");
  const [stageKey, setStageKey] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [actor, setActor] = useState("");
  const [contains, setContains] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  /** Newest line id the operator has actually been shown at the bottom. */
  const seenIdRef = useRef<number>(lines.at(-1)?.id ?? 0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const newestId = lines.at(-1)?.id ?? 0;
  const actors = useMemo(
    () => [...new Set(lines.map((line) => line.actor))].sort(),
    [lines],
  );
  const categoryCount = (category: string) =>
    lines.filter((line) => line.category === category).length;

  const filtered = useMemo(
    () =>
      lines.filter((line) => {
        if (stream !== "all" && line.stream !== stream) return false;
        if (severity === "attention" && line.severity !== "attention")
          return false;
        if (severity === "output" && line.severity !== "detail") return false;
        if (categories.length > 0 && !categories.includes(line.category))
          return false;
        if (stageKey) {
          const stage = stages.find((entry) => entry.key === stageKey);
          if (stage && line.stageName !== stage.name) return false;
        }
        if (attemptId) {
          const attempt = attempts.find((entry) => entry.id === attemptId);
          if (attempt && line.attemptNumber !== attempt.attemptNumber)
            return false;
        }
        if (actor && line.actor !== actor) return false;
        if (contains) {
          const needle = contains.trim().toLowerCase();
          const haystack = `${line.type} ${line.agentName ?? ""} ${
            line.stageName ?? ""
          } ${line.actor} ${line.category} ${line.text}`.toLowerCase();
          if (needle && !haystack.includes(needle)) return false;
        }
        return true;
      }),
    [
      lines,
      stream,
      severity,
      categories,
      stageKey,
      attemptId,
      actor,
      contains,
      stages,
      attempts,
    ],
  );

  // Following keeps the newest line in view; it never fights a scroll upwards.
  useEffect(() => {
    if (!follow) return;
    const container = listRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    seenIdRef.current = newestId;
  }, [follow, newestId, filtered.length]);

  const pending = follow
    ? 0
    : filtered.filter((line) => line.id > seenIdRef.current).length;

  const onScroll = () => {
    const container = listRef.current;
    if (!container) return;
    const distance =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distance > 24) setFollow(false);
  };

  const jumpToLatest = () => {
    seenIdRef.current = newestId;
    setFollow(true);
    const container = listRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  };

  return (
    <div className="rawlog">
      <div className="rawlog__bar">
        <Select
          ariaLabel="Filter by stream"
          value={stream}
          onChange={(value) => setStream(value as StreamFilter)}
          options={STREAM_FILTERS.map((value) => ({
            value,
            label: STREAM_FILTER_LABELS[value],
          }))}
        />
        <Select
          ariaLabel="Filter by severity"
          value={severity}
          onChange={(value) => setSeverity(value as EventSeverityFilter)}
          options={EVENT_SEVERITY_FILTERS.map((value) => ({
            value,
            label: EVENT_SEVERITY_FILTER_LABELS[value],
          }))}
        />
        <span className="faint small">
          {filtered.length} / {lines.length} lines · stream {streamStatus}
          {newestId > 0 ? ` · newest #${newestId}` : ""}
        </span>
        <div className="rawlog__follow">
          <Button
            size="sm"
            variant={follow ? "primary" : "default"}
            aria-pressed={follow}
            onClick={() => (follow ? setFollow(false) : jumpToLatest())}
          >
            {follow ? "Following" : "Follow"}
          </Button>
          {!follow ? (
            <>
              <span className="faint small" role="status" aria-live="polite">
                {pending === 0
                  ? "No new lines while paused"
                  : `${pending} new line${pending === 1 ? "" : "s"} while paused`}
              </span>
              <Button size="sm" variant="ghost" onClick={jumpToLatest}>
                Jump to latest
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <ErrorBox error={error ?? null} onRetry={onReload} />

      <Disclosure summary="Advanced filters">
        <div className="rawlog__filters">
          <div
            className="drawer__filters"
            role="group"
            aria-label="Event category filters"
          >
            {ALL_EVENT_CATEGORIES.map((category) => {
              const count = categoryCount(category);
              return (
                <button
                  key={category}
                  type="button"
                  className="chip"
                  aria-pressed={categories.includes(category)}
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
              options={stages.map((entry) => ({
                value: entry.key,
                label: `${entry.name} (${statusLabel(entry.status)})`,
              }))}
            />
            <Select
              ariaLabel="Filter by attempt"
              value={attemptId}
              onChange={setAttemptId}
              placeholder="All attempts"
              options={attempts.map((entry) => ({
                value: entry.id,
                label: `#${entry.attemptNumber} ${entry.stageKey}`,
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
              value={contains}
              onChange={setContains}
              placeholder="search text"
            />
            <Checkbox
              checked={follow}
              onChange={setFollow}
              id="rawlog-follow"
              label="Follow new lines"
            />
            {onReload ? (
              <Button size="sm" variant="ghost" onClick={onReload}>
                Reload
              </Button>
            ) : null}
          </div>
          <p className="faint small">
            {tasks.length} task record(s) exist for this run; the stage filter
            above is the task selector. {agents.length} agent(s) known.
          </p>
        </div>
      </Disclosure>

      {filtered.length === 0 ? (
        <p className="faint small">
          No lines match the current filters.
          {lines.length === 0 ? " This run has logged nothing yet." : ""}
        </p>
      ) : (
        <div
          className="terminal terminal--tall"
          role="log"
          aria-live="off"
          aria-relevant="additions"
          aria-label="Raw run log"
          ref={listRef}
          onScroll={onScroll}
        >
          {filtered.map((line) => (
            <div key={line.id} className="terminal__line">
              <span className="terminal__time" title={formatTimestamp(line.at)}>
                {formatClock(line.at)}
              </span>
              <Pill tone={SEVERITY_TONES[line.severity]} dot={false}>
                {line.severity === "attention"
                  ? "problem"
                  : line.severity === "detail"
                    ? line.stream
                    : "progress"}
              </Pill>
              <span className="terminal__actor">
                {[
                  line.type,
                  line.stageName,
                  line.attemptNumber === null
                    ? null
                    : `attempt ${line.attemptNumber}`,
                  line.agentName,
                  line.actor,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ")}
              </span>
              <span className="wrap-anywhere">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
