/**
 * The run decision sheet: the one elevated surface on the page, holding the
 * single primary action for whatever the operator actually has to do next.
 *
 * The order is deliberate and load-bearing — recorded evidence first, the one
 * filled action after it, and everything destructive or optional behind a quiet
 * disclosure. The same components serve all four shapes of the sheet:
 *
 *   - a human gate (rendered by `ApprovalPanel`, not here),
 *   - an agent blocked on input (question adjacent to the answer field),
 *   - a draft run that has not been started,
 *   - a failed/interrupted run that needs a deliberate retry with a reason.
 */
import type { ReactNode } from "react";
import type { StageRecord } from "../../core/types.js";
import {
  formatTimestamp,
  relativeTime,
  statusLabel,
  text,
} from "../view-model.js";
import type { PendingInputQuestion } from "../view-model.js";
import { Button, Disclosure, Field, KeyValue, Pill, TextArea } from "./Bits.js";

export function InputRequest({
  question,
  stageName,
  value,
  onChange,
  onSubmit,
  busy,
}: {
  question: PendingInputQuestion;
  /** Plain stage name, when the run knows one. */
  stageName?: string | null;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const source =
    question.source === "input.requested"
      ? "the run recorded an input request"
      : question.source === "agent.waiting"
        ? "the agent reported that it is waiting"
        : question.source === "attempt summary"
          ? "the waiting attempt's own summary"
          : "nothing was recorded";
  const context = [
    stageName ?? question.stageKey,
    question.attemptNumber !== null ? `attempt ${question.attemptNumber}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <div className="operator-input">
      <div className="operator-question">
        <p className="operator-question__text wrap-anywhere">
          {question.text
            ? question.text
            : "The agent asked for input but no question text was saved. Read its output above before answering."}
        </p>
        {context ? <p className="faint small">{context}</p> : null}
      </div>
      <div className="stack">
        <Field
          label="Your answer"
          htmlFor="operator-input"
          help="The agent will continue with your answer."
        >
          <TextArea
            id="operator-input"
            rows={3}
            value={value}
            onChange={onChange}
            ariaLabel="Your answer"
          />
        </Field>
        <div>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={busy || !value.trim()}
          >
            {busy ? "Sending…" : "Send input"}
          </Button>
        </div>
        <Disclosure summary="Technical details">
          <KeyValue
            rows={[
              ["Question source", source],
              [
                "Stage key",
                <span className="mono">{question.stageKey ?? "not recorded"}</span>,
              ],
              [
                "Attempt",
                question.attemptNumber === null
                  ? "not recorded"
                  : `#${question.attemptNumber}`,
              ],
              ["Raised", formatTimestamp(question.at)],
            ]}
          />
        </Disclosure>
      </div>
    </div>
  );
}

export function StartRunBlock({
  onStart,
  busy,
}: {
  onStart: () => void;
  busy: boolean;
}) {
  return (
    <div className="stack">
      <h2 className="run-sheet__headline">Ready to start</h2>
      <p className="faint small">
        The plan is frozen. Starting launches the entry stage; every human gate
        still stops the run.
      </p>
      <div>
        <Button variant="primary" onClick={onStart} disabled={busy}>
          {busy ? "Starting…" : "Start run"}
        </Button>
      </div>
    </div>
  );
}

export function FailureEvidence({
  stage,
  reason,
  attempts,
}: {
  stage: StageRecord | null;
  reason: string | null;
  attempts: number;
}) {
  return (
    <KeyValue
      rows={[
        [
          "What failed",
          stage ? (
            <span>
              {stage.name}{" "}
              <Pill tone="muted" dot={false}>
                {stage.kind}
              </Pill>{" "}
              · {statusLabel(stage.status)}
            </span>
          ) : (
            "no stage recorded a failure"
          ),
        ],
        ["Recorded reason", text(reason, "no reason recorded")],
        [
          "When",
          stage?.endedAt
            ? `${formatTimestamp(stage.endedAt)} (${relativeTime(stage.endedAt)})`
            : "UNKNOWN",
        ],
        ["Attempts on this run", String(attempts)],
      ]}
    />
  );
}

export function RetryForm({
  reason,
  instruction,
  onReasonChange,
  onInstructionChange,
  onSubmit,
  busy,
  error,
  inlineNotice = "The previous attempt is kept and never overwritten.",
}: {
  reason: string;
  instruction: string;
  onReasonChange: (value: string) => void;
  onInstructionChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error?: string | null;
  inlineNotice?: string;
}) {
  return (
    <div className="run-form">
      <Field
        label="Retry reason (mandatory)"
        htmlFor="retry-reason"
        help="Stored on the new attempt as its immutable reason."
        error={error ?? undefined}
      >
        <TextArea
          id="retry-reason"
          rows={2}
          value={reason}
          onChange={onReasonChange}
          invalid={Boolean(error)}
        />
      </Field>
      <Field
        label="Instruction for the retried attempt (optional)"
        htmlFor="retry-instruction"
      >
        <TextArea
          id="retry-instruction"
          rows={2}
          value={instruction}
          onChange={onInstructionChange}
        />
      </Field>
      <div className="row">
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={busy || !reason.trim()}
        >
          {busy ? "Retrying…" : "Create retry attempt"}
        </Button>
        <span className="faint small">{inlineNotice}</span>
      </div>
    </div>
  );
}

/** Quiet utilities: optional controls and the collapsed cancellation form. */
export function QuietControls({
  children,
  hidden,
}: {
  children: ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return <div className="run-quiet-controls">{children}</div>;
}
