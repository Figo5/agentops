/**
 * Overview: the run's recent life, the one fact the header does not already
 * state, and the selected stage's full audit record one level down.
 *
 * The default leads with recent activity. The live state belongs to the header
 * and the gate belongs to the decision sheet, so the Overview only adds what
 * nothing else on the page says: the run's recorded outcome once it has
 * finished, and the work in flight when the run itself recorded a summary.
 * Every original capability (exact prompt, previous-prompt diff, streamed
 * output, commands, verification, review payload, artifacts, usage, stage
 * record) stays reachable inside `Stage evidence`. Nothing is deleted to make
 * the summary short.
 */
import { useMemo } from "react";
import type { EventRecord, StageRecord } from "../../core/types.js";
import type { AgentOpsClient, RunDetailResponse } from "../api.js";
import {
  UNKNOWN,
  formatClock,
  formatTimestamp,
  reviewCycleView,
  statusLabel,
  text,
  verdictActionWord,
} from "../view-model.js";
import {
  activityEntries,
  changedFilesView,
  reviewHistory,
  runTabLabel,
  verificationFailed,
  verificationHistory,
  type RunTabId,
} from "../run-view.js";
import { AttemptDetail } from "./AttemptDetail.js";
import {
  Button,
  Card,
  Disclosure,
  KeyValue,
  Pill,
  StatusPill,
} from "./Bits.js";
import {
  ArtifactList,
  ArtifactRegistration,
  MeasuredUsage,
} from "./RunAssets.js";

const RECENT_EVENT_LIMIT = 6;

/** One quiet finding line for a stage, used by the stage picker. */
function stageLine(stage: StageRecord, agentName: string | null): string {
  const parts: string[] = [statusLabel(stage.status)];
  if (agentName) parts.push(agentName);
  parts.push(
    stage.attemptCount === 1 ? "1 attempt" : `${stage.attemptCount} attempts`,
  );
  if (stage.failureReason) parts.push(stage.failureReason);
  if (stage.skipReason) parts.push(`skipped: ${stage.skipReason}`);
  return parts.join(" · ");
}

export function OverviewPanel({
  client,
  detail,
  events,
  activityContext,
  activeSummary,
  showOutcome = false,
  selectedStage,
  selectedStageKey,
  selectedAttemptId,
  onSelectAttempt,
  onSelectStage,
  onOpenTab,
  evidenceOpen,
  onEvidenceOpen,
  refreshDetail,
}: {
  client: AgentOpsClient;
  detail: RunDetailResponse;
  events: readonly EventRecord[];
  /** Stage/attempt/agent names the Activity sentences are built from. */
  activityContext: {
    stageNames: ReadonlyMap<string, string>;
    attemptNumbers: ReadonlyMap<string, number>;
    agentNames: ReadonlyMap<string, string>;
    /** Agent name of each attempt, so an agent event can name its own agent. */
    attemptAgents?: ReadonlyMap<string, string>;
  };
  /** Short summary of the work in flight, when the run recorded one. */
  activeSummary: string | null;
  /**
   * `true` only when nothing else on the page states the outcome — a finished
   * run without a decision sheet. The header owns the live state and the sheet
   * owns the gate, so those runs show no outcome block here.
   */
  showOutcome?: boolean;
  selectedStage: StageRecord | null;
  selectedStageKey: string | null;
  selectedAttemptId: string | null;
  onSelectAttempt: (attemptId: string) => void;
  onSelectStage: (stageKey: string) => void;
  onOpenTab: (tab: RunTabId) => void;
  evidenceOpen: boolean;
  onEvidenceOpen: (open: boolean) => void;
  refreshDetail: () => void | Promise<void>;
}) {
  const verification = useMemo(
    () =>
      verificationHistory({
        attempts: detail.attempts,
        tests: detail.tests,
        commands: detail.commands,
        stages: detail.stages,
      }),
    [detail],
  );
  const reviews = useMemo(
    () =>
      reviewHistory({
        verdicts: detail.reviewVerdicts,
        attempts: detail.attempts,
        agents: detail.agents,
        stages: detail.stages,
      }),
    [detail],
  );
  const newestSnapshot = useMemo(() => {
    const sorted = [...detail.snapshots].sort((a, b) =>
      a.capturedAt.localeCompare(b.capturedAt),
    );
    return sorted[sorted.length - 1] ?? null;
  }, [detail.snapshots]);

  const changed = changedFilesView({ snapshot: newestSnapshot });
  const latestVerification = verification[0] ?? null;
  const latestReview = reviews[0] ?? null;
  // The newest activity, newest first: the operator reads what just happened
  // without scrolling to the bottom of the run's whole life.
  const recent = useMemo(
    () =>
      activityEntries(events, activityContext)
        .slice(-RECENT_EVENT_LIMIT)
        .reverse(),
    [events, activityContext],
  );

  /**
   * Three short operator lines instead of a record table: what verification
   * said, what the reviewer said, and how much changed. The long goal and every
   * id/key stay in the header, the relevant tab or Technical details.
   */
  const outcomeLines: { label: string; value: string }[] = [];
  if (latestVerification) {
    const failed = verificationFailed(latestVerification);
    outcomeLines.push({
      label: "Verification",
      value: `${failed ? "Failed" : "Passed"} · ${latestVerification.shortLabel} (${latestVerification.stageName})`,
    });
  }
  if (latestReview) {
    outcomeLines.push({
      label: "Review",
      value: `${latestReview.reviewer} ${verdictActionWord(latestReview.kind, latestReview.valid)} · ${latestReview.blockers} blocker${
        latestReview.blockers === 1 ? "" : "s"
      }, ${latestReview.suggestions} suggestion${
        latestReview.suggestions === 1 ? "" : "s"
      }`,
    });
  }
  if (changed.count !== null) {
    outcomeLines.push({ label: "Changes", value: changed.label });
  } else if (detail.snapshots.length > 0) {
    outcomeLines.push({ label: "Changes", value: changed.label });
  }

  return (
    <div className="panel panel--overview">
      {/* Recent activity leads the Overview: what the run just did is the one
          thing the header, the progress bar and the decision sheet never say. */}
      <Card
        title="Recent activity"
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenTab("activity")}
          >
            Open {runTabLabel("activity")}
          </Button>
        }
      >
        {recent.length === 0 ? (
          <p className="faint small">No meaningful events recorded yet.</p>
        ) : (
          <ul className="activity__summary">
            {recent.map((entry) => (
              <li key={entry.id} className="activity__summary-row">
                <span className="faint small" title={formatTimestamp(entry.at)}>
                  {formatClock(entry.at)}
                </span>
                <span aria-hidden="true" className="activity__dot" />
                <span className="wrap-anywhere">{entry.sentence}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* The work in flight, and only what the run itself recorded about it:
          the header already says which stage is running and who is on it. */}
      {activeSummary ? (
        <section className="overview">
          <h3>Now</h3>
          <p className="faint small wrap-anywhere">{activeSummary}</p>
        </section>
      ) : null}

      {/* Outcome: three short lines, no record table, no repeated goal. Only
          for a finished run whose facts no other surface states. */}
      {showOutcome ? (
        <section className="overview">
          <h3>Outcome</h3>
          {outcomeLines.length === 0 ? (
            <p className="faint small">Nothing has finished on this run yet.</p>
          ) : (
            <ul className="overview__lines">
              {outcomeLines.map((line) => (
                <li key={line.label} className="overview__line">
                  <span className="overview__label">{line.label}</span>
                  <span className="wrap-anywhere">{line.value}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <Card
        title="Artifacts and usage"
        hint="Every file this run references, and the measured usage of every attempt. Run-level: an artifact may belong to no single stage."
      >
        <Disclosure summary={`Artifacts (${detail.artifacts.length})`}>
          <div className="stack">
            <ArtifactList artifacts={detail.artifacts} />
            <ArtifactRegistration
              client={client}
              runId={detail.run.id}
              refresh={refreshDetail}
            />
          </div>
        </Disclosure>
        <Disclosure summary="Measured usage">
          <MeasuredUsage attempts={detail.attempts} agents={detail.agents} />
        </Disclosure>
      </Card>

      <Disclosure
        summary={`Stage evidence${selectedStage ? ` — ${selectedStage.name}` : ""}`}
        open={evidenceOpen}
        onToggle={onEvidenceOpen}
      >
        <div className="stack">
          <p className="faint small">
            The selected stage's own record: exact prompt, previous-prompt
            comparison, streamed output, commands, verification, review payload,
            artifacts and measured usage. Attempts are never discarded.
          </p>
          <ul className="stage-picker">
            {detail.stages.map((stage) => (
              <li key={stage.key}>
                <button
                  type="button"
                  className="stage-picker__button"
                  aria-current={
                    stage.key === selectedStageKey ? "true" : undefined
                  }
                  onClick={() => onSelectStage(stage.key)}
                >
                  <span>{`Open evidence for ${stage.name}`}</span>
                  <span className="faint small">
                    {stageLine(
                      stage,
                      detail.agents.find(
                        (agent) => agent.id === stage.agentId,
                      )?.name ?? null,
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <AttemptDetail
            detail={detail}
            stage={selectedStage}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={onSelectAttempt}
          />
        </div>
      </Disclosure>
    </div>
  );
}
