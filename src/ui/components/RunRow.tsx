/**
 * One run row, shared by the operational home and the history view.
 *
 * A row answers four questions in order: which project, what the goal was, how
 * it stands, and how long ago it moved. The status is a single semantic icon +
 * word (never duplicated), the time is quiet, and the action is an explicit
 * link-style control the operator can click or tab to.
 *
 * Every field is rendered from the persisted record; nothing is synthesised.
 */
import type { ReactNode } from "react";
import type { RunListRecord } from "../ui-types.js";
import { relativeTime, routeHref, statusLabel } from "../view-model.js";
import { StatusPill } from "./Bits.js";

/** What the operator can do next with this run, in one word. */
function actionLabel(run: RunListRecord): string {
  if (run.status === "WAITING_APPROVAL" || run.status === "WAITING_INPUT")
    return "Review";
  if (run.status === "FAILED" || run.status === "INTERRUPTED") return "Retry";
  if (run.status === "DRAFT") return "Start";
  if (run.status === "RUNNING") return "Open";
  return "View";
}

export function RunRow({
  run,
  projectName,
  right,
}: {
  run: RunListRecord;
  projectName?: string;
  right?: ReactNode;
}) {
  const href = routeHref({ view: "run", runId: run.id });
  return (
    <div className="run-row">
      <div className="run-row__text">
        <b className="run-row__goal" title={run.goal}>
          {run.goal}
        </b>
        <span className="run-row__meta">
          <span className="run-row__project">
            {projectName ?? run.projectId}
          </span>
          <span aria-hidden="true">·</span>
          <span title={run.updatedAt}>
            updated {relativeTime(run.updatedAt)}
          </span>
        </span>
      </div>
      <div className="run-row__status">
        <StatusPill
          status={run.status}
          title={`${statusLabel(run.status)} (${run.status})`}
        />
      </div>
      {right ? <div className="run-row__extra">{right}</div> : null}
      <a className="run-row__link" href={href}>
        {actionLabel(run)}
        <span aria-hidden="true">›</span>
      </a>
    </div>
  );
}

/**
 * One calm home section: a heading with a count, then hairline-separated rows.
 *
 * Rendered only when it has content — an empty category is a fact about the
 * run list, not a card that needs to be on screen.
 */
export function RunSection({
  title,
  runs,
  projectNames,
  hint,
}: {
  title: string;
  runs: RunListRecord[];
  projectNames: Record<string, string>;
  hint?: string;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="home-section">
      <div className="home-section__head">
        <h2>{title}</h2>
        <span className="home-section__count">{runs.length}</span>
      </div>
      {hint ? <p className="home-section__hint">{hint}</p> : null}
      <div className="run-list">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            projectName={projectNames[run.projectId]}
          />
        ))}
      </div>
    </section>
  );
}
