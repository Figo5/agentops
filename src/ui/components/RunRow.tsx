import type { ReactNode } from "react";
import type { RunListRecord } from "../ui-types.js";
import {
  relativeTime,
  routeHref,
  statusLabel,
  verdictLabel,
  verdictTone,
} from "../view-model.js";
import { Pill, StatusPill } from "./Bits.js";

/**
 * One run row, shared by the dashboard and the history view. Every field is
 * rendered from the persisted record; nothing is synthesised.
 */
export function RunRow({
  run,
  projectName,
  right,
}: {
  run: RunListRecord;
  projectName?: string;
  right?: ReactNode;
}) {
  const branch = run.branch ?? null;
  const verdict = run.lastReviewVerdict ?? null;
  return (
    <a
      className="list__row"
      href={routeHref({ view: "run", runId: run.id })}
      aria-label={`Open run: ${run.goal}`}
    >
      <div className="list__goal">
        <b title={run.goal}>{run.goal}</b>
        <span className="list__meta">
          <span>{projectName ?? run.projectId}</span>
          <span aria-hidden="true">·</span>
          <span title={run.updatedAt}>
            updated {relativeTime(run.updatedAt)}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {run.templateId} v{run.templateVersion}
          </span>
          {branch ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="mono">{branch}</span>
            </>
          ) : null}
          {verdict ? (
            <>
              <span aria-hidden="true">·</span>
              <Pill tone={verdictTone(verdict)} dot={false}>
                {verdictLabel(verdict)}
              </Pill>
            </>
          ) : null}
          {run.status === "WAITING_APPROVAL" ? (
            <>
              <span aria-hidden="true">·</span>
              <Pill
                tone="warn"
                dot={false}
                title="The run is waiting for a human decision"
              >
                {statusLabel(run.status)}
              </Pill>
            </>
          ) : null}
        </span>
      </div>
      <div className="list__right">
        {right}
        <StatusPill status={run.status} />
      </div>
    </a>
  );
}

export function RunSection({
  title,
  tone,
  runs,
  projectNames,
  emptyLabel,
  hint,
}: {
  title: string;
  tone: "accent" | "neutral" | "danger";
  runs: RunListRecord[];
  projectNames: Record<string, string>;
  emptyLabel: string;
  hint?: string;
}) {
  return (
    <section className="card">
      <div className="card__head">
        <h2>
          {title}{" "}
          <Pill tone={tone === "accent" ? "active" : tone}>{runs.length}</Pill>
        </h2>
      </div>
      {hint ? <p className="card__hint">{hint}</p> : null}
      {runs.length === 0 ? (
        <p className="faint small">{emptyLabel}</p>
      ) : (
        <div className="list">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              projectName={projectNames[run.projectId]}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Tiny presentational helper so dashboards keep a consistent tone legend. */
export function StatusLegend() {
  const entries: { status: string; label: string }[] = [
    { status: "RUNNING", label: "engine working" },
    { status: "WAITING_APPROVAL", label: "human decision required" },
    { status: "FAILED", label: "stopped at a failing gate" },
    { status: "COMPLETED", label: "accepted and closed" },
  ];
  return (
    <div className="row row--tight">
      {entries.map((entry) => (
        <StatusPill
          key={entry.status}
          status={entry.status}
          title={entry.label}
        />
      ))}
    </div>
  );
}
