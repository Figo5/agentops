/**
 * Horizontal stage progress: Plan · Build · Verify · Review · Final.
 *
 * One compact button per milestone — icon, plain name, one state word — of equal
 * height, with no record rows in the default progression. Each click opens the
 * evidence that belongs to that milestone, and the whole stage chronology
 * (owning the review → fix → re-verification branch and every stage record) is
 * available under one collapsed `Workflow details` disclosure.
 */
import { classNames, statusLabel, type Tone } from "../view-model.js";
import {
  runTabLabel,
  type MilestoneState,
  type RunMilestoneView,
} from "../run-view.js";
import { Button, Disclosure, Pill } from "./Bits.js";

const STATE_TONES: Record<MilestoneState, Tone> = {
  complete: "success",
  current: "active",
  failed: "danger",
  wait: "muted",
};

export function RunProgress({
  milestones,
  selectedStageKey,
  onSelectStage,
  onOpenMilestone,
}: {
  milestones: readonly RunMilestoneView[];
  selectedStageKey: string | null;
  /** Selects one stage and opens its evidence view. */
  onSelectStage: (stageKey: string, milestone: RunMilestoneView) => void;
  /** Opens the evidence tab that belongs to a milestone. */
  onOpenMilestone: (milestone: RunMilestoneView) => void;
}) {
  if (milestones.length === 0) return null;
  return (
    <nav className="progress" aria-label="Stage progress">
      <ol className="progress__list">
        {milestones.map((milestone) => {
          const selected = milestone.stages.some(
            (stage) => stage.key === selectedStageKey,
          );
          return (
            <li key={milestone.id} className="progress__step">
              <button
                type="button"
                className={classNames(
                  "progress__button",
                  `progress__button--${milestone.state}`,
                )}
                aria-current={selected ? "true" : undefined}
                aria-label={`${milestone.name} · ${milestone.stateWord}${
                  milestone.statusWord ? ` · ${milestone.statusWord}` : ""
                }`}
                onClick={() => onOpenMilestone(milestone)}
              >
                <span
                  className={classNames(
                    "progress__icon",
                    `progress__icon--${milestone.state}`,
                  )}
                  aria-hidden="true"
                >
                  {milestone.icon}
                </span>
                <span className="progress__name">{milestone.name}</span>
                <span className="progress__state">{milestone.stateWord}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <Disclosure summary="Workflow details" className="progress__details">
        <div className="stack">
          <p className="faint small">
            Every stage of the frozen plan, in order, with the review → fix →
            re-verification branch attached to the review it belongs to.
          </p>
          <ul className="progress__stages">
            {milestones.flatMap((milestone) =>
              milestone.stages.map((stage) => (
                <li key={stage.key} className="progress__stage">
                  <button
                    type="button"
                    className="progress__stagebutton"
                    aria-current={
                      stage.key === selectedStageKey ? "true" : undefined
                    }
                    aria-label={`${stage.name} ${stage.kind} ${stage.role} ${stage.agentName ?? ""} ${statusLabel(stage.status)}`}
                    onClick={() => onSelectStage(stage.key, milestone)}
                  >
                    <span className="progress__stagename">{stage.name}</span>
                    <Pill tone={STATE_TONES[milestone.state]} dot={false}>
                      {stage.statusWord}
                    </Pill>
                    {stage.agentName ? (
                      <span className="faint small">{stage.agentName}</span>
                    ) : null}
                  </button>
                  {stage.loopLabel ? (
                    <span className="faint small">{stage.loopLabel}</span>
                  ) : null}
                  {stage.attemptCount > 1 ? (
                    <span className="faint small">
                      {stage.attemptCount} attempts
                    </span>
                  ) : null}
                  {stage.overridden ? (
                    <Pill
                      tone="warn"
                      dot={false}
                      title="A human override was recorded for this stage"
                    >
                      overridden
                    </Pill>
                  ) : null}
                  {stage.failureReason ? (
                    <span className="field__error small wrap-anywhere">
                      {stage.failureReason}
                    </span>
                  ) : null}
                  {stage.skippedReason ? (
                    <span className="faint small">
                      skipped: {stage.skippedReason}
                    </span>
                  ) : null}
                </li>
              )),
            )}
          </ul>
          <div className="row">
            {milestones.map((milestone) => (
              <Button
                key={`${milestone.id}-evidence`}
                size="sm"
                variant="ghost"
                onClick={() => onOpenMilestone(milestone)}
              >
                {milestone.name} · {runTabLabel(milestone.tab)} evidence
              </Button>
            ))}
          </div>
        </div>
      </Disclosure>
    </nav>
  );
}
