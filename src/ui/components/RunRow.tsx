/**
 * One run row, shared by the operational home and the history view.
 *
 * A row answers four questions in order: which project (primary), what the goal
 * was, how it stands, and how long ago it moved. The project name is the row's
 * heading because that is what the operator scans for; the goal is quiet text
 * under it and is ellipsized rather than wrapped. The status is a single
 * semantic icon + word (never duplicated), and the action is an explicit
 * link-style control with an accessible name that says what it does and to
 * which project.
 *
 * Every field is rendered from the persisted record; nothing is synthesised. A
 * row that needs the operator may carry one concise evidence line when the run's
 * own records contain one, and says so explicitly while it is loading or when
 * the detail request failed.
 */
import type { ReactNode } from "react";
import type { RunListRecord } from "../ui-types.js";
import { relativeTime, routeHref, statusLabel } from "../view-model.js";
import type { RunEvidenceState } from "../hooks.js";
import { StatusMark } from "./Bits.js";

/** What the operator can do next with this run, in one word. */
function actionLabel(run: RunListRecord): string {
  if (run.status === "WAITING_APPROVAL" || run.status === "WAITING_INPUT")
    return "Review";
  if (run.status === "FAILED" || run.status === "INTERRUPTED") return "Retry";
  if (run.status === "DRAFT") return "Start";
  if (run.status === "RUNNING") return "Open";
  return "View";
}

/** The evidence line for a row, or `null` when there is nothing truthful to add. */
function evidenceText(state: RunEvidenceState | undefined): string | null {
  if (!state) return null;
  if (state.status === "loading") return "Loading evidence…";
  if (state.status === "unavailable") return "Evidence unavailable";
  return state.line;
}

export function RunRow({
  run,
  projectName,
  evidence,
  detail,
  right,
}: {
  run: RunListRecord;
  projectName?: string;
  /** Concise persisted evidence for a row that needs the operator. */
  evidence?: RunEvidenceState;
  /** Current stage and agent for a row that is running, when known. */
  detail?: string | null;
  right?: ReactNode;
}) {
  const href = routeHref({ view: "run", runId: run.id });
  const project = projectName ?? run.projectId;
  const evidenceLine = evidenceText(evidence);
  const detailLine = evidenceLine ? null : (detail ?? null);
  /**
   * The persisted gate when the detail request succeeded, the run's own status
   * word otherwise (including while the request is in flight or after it
   * failed — a generic word is only used when nothing more is known).
   */
  const stateWord =
    (evidence?.status === "ready" ? evidence.state : null) ??
    statusLabel(run.status);
  return (
    <div className="run-row">
      <div className="run-row__text">
        <span className="run-row__project">{project}</span>
        <span className="run-row__meta">
          <span className="run-row__goal" title={run.goal}>
            {run.goal}
          </span>
          <span aria-hidden="true">·</span>
          <span title={run.updatedAt}>
            updated {relativeTime(run.updatedAt)}
          </span>
        </span>
        {evidenceLine ? (
          <span className="run-row__evidence">{evidenceLine}</span>
        ) : null}
        {detailLine ? (
          <span className="run-row__detail">{detailLine}</span>
        ) : null}
      </div>
      <div className="run-row__status">
        {/*
          The word is the persisted gate when the run's detail has been read
          (`Ready for final approval`, `Changes requested`) and the run's own
          status otherwise; the title always carries the raw enum.
        */}
        <StatusMark
          status={run.status}
          label={stateWord}
          title={`${stateWord} (${run.status})`}
        />
      </div>
      {right ? <div className="run-row__extra">{right}</div> : null}
      <a
        className="run-row__link"
        href={href}
        aria-label={`${actionLabel(run)} ${project}`}
      >
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
 * run list, not a card that needs to be on screen. The heading and the rows say
 * everything; there is no policy prose or implementation hint underneath.
 */
export function RunSection({
  title,
  runs,
  projectNames,
  evidence,
  details,
}: {
  title: string;
  runs: RunListRecord[];
  projectNames: Record<string, string>;
  evidence?: Record<string, RunEvidenceState>;
  /** Current stage/agent line per run id, for the running section. */
  details?: Record<string, string | null>;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="home-section">
      <div className="home-section__head">
        <h2>{title}</h2>
        <span className="home-section__count">{runs.length}</span>
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            projectName={projectNames[run.projectId]}
            evidence={evidence?.[run.id]}
            detail={details?.[run.id]}
          />
        ))}
      </div>
    </section>
  );
}
