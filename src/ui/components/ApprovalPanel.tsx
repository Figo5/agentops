/**
 * The human decision block for a pending approval gate.
 *
 * Ordering is deliberate and load-bearing: the persisted evidence (gate, why it
 * stopped, the blocking verdict with its issues, the verification outcome and
 * the review-cycle position) is rendered *before* any decision button, so an
 * operator never decides from a bare pair of buttons.
 *
 * A decision that requires a reason is selected first and only then reveals its
 * mandatory reason field; the decision itself is submitted by an explicit
 * confirm button. A single stray click cannot record a rejection or an override.
 * Decisions that take no reason (acceptance) submit directly.
 */
import type { ApprovalDecision } from "../../core/types.js";
import {
  formatTimestamp,
  type ApprovalEvidence,
  type DecisionOption,
} from "../view-model.js";
import { Button, Field, Notice, Pill, StatusPill, TextArea } from "./Bits.js";

export function ApprovalEvidenceBlock({
  evidence,
  options,
}: {
  evidence: ApprovalEvidence;
  options: readonly DecisionOption[];
}) {
  const { verdict, verification } = evidence;
  return (
    <div className="approval-evidence stack" aria-label="Approval evidence">
      <div className="row row--between">
        <b>{evidence.gateLabel}</b>
        <Pill tone={verdict?.tone ?? "warn"}>{evidence.cycle.label}</Pill>
      </div>
      <p className="small">
        {evidence.reason
          ? `Recorded reason: ${evidence.reason}`
          : "No reason was recorded on this gate request."}
        {evidence.stageKey ? ` · stage ${evidence.stageKey}` : ""}
      </p>

      {verdict ? (
        <div className="attempt">
          <div className="row row--between">
            <Pill tone={verdict.tone}>{verdict.label}</Pill>
            <span className="faint small">
              stage {verdict.stageKey} · review cycle {verdict.cycle} ·{" "}
              <span className="wrap-anywhere">{verdict.reviewer}</span>
              {verdict.reviewerSource === "reviewer attempt agent"
                ? " (from the reviewer attempt's agent)"
                : ""}{" "}
              · {formatTimestamp(verdict.createdAt)}
            </span>
          </div>
          {!verdict.valid ? (
            <Notice tone="warn">
              The verdict payload failed validation, so no structured verdict
              was accepted.
            </Notice>
          ) : null}
          <p className="small wrap-anywhere">
            {verdict.summary ?? "No review summary was recorded."}
          </p>
          {verdict.issues.length > 0 ? (
            <ul className="stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
              {verdict.issues.map((issue, index) => (
                <li key={index} className="wrap-anywhere">
                  <Pill
                    tone={
                      issue.severity === "blocking"
                        ? "danger"
                        : issue.severity === "major"
                          ? "warn"
                          : "muted"
                    }
                    dot={false}
                  >
                    {issue.severity}
                  </Pill>{" "}
                  {issue.description}
                  {issue.location ? (
                    <span className="faint small mono"> {issue.location}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="faint small">The verdict lists no issues.</p>
          )}
        </div>
      ) : (
        <p className="faint small">
          No review verdict is recorded for this stage; the gate comes from the
          run plan rather than from a reviewer payload.
        </p>
      )}

      <div className="faint small">
        {verification ? (
          <>
            <StatusPill status={verification.status} />{" "}
            <span className="wrap-anywhere">
              stage {verification.stageKey} · attempt #
              {verification.attemptNumber} · {verification.label}
              {verification.countsSource === "normalized test run"
                ? ` (counts from the normalized test run${verification.framework ? ` ${verification.framework}` : ""})`
                : ""}
              {verification.onGateStage
                ? ""
                : " (last verification recorded for this run)"}
            </span>
          </>
        ) : (
          "No verification outcome is recorded for this run."
        )}
      </div>

      <details>
        <summary className="small" style={{ cursor: "pointer" }}>
          What each decision does
        </summary>
        <ul
          className="stack--tight"
          style={{ margin: "8px 0 0", paddingLeft: 18 }}
        >
          {options.map((option) => (
            <li key={option.decision} className="small wrap-anywhere">
              <b>{option.label}</b> — {option.detail}
              {option.requiresInstruction ? " A reason is mandatory." : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function ApprovalPanel({
  evidence,
  options,
  selected,
  reason,
  busy,
  error,
  onSelect,
  onReasonChange,
  onCancel,
  onConfirm,
}: {
  evidence: ApprovalEvidence;
  options: readonly DecisionOption[];
  /** The reason-requiring decision the operator selected, if any. */
  selected: ApprovalDecision | null;
  reason: string;
  busy: boolean;
  error?: string | null;
  onSelect: (decision: ApprovalDecision) => void;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: (decision: ApprovalDecision) => void;
}) {
  const selectedOption =
    options.find((option) => option.decision === selected) ?? null;
  const immediate = options.filter((option) => !option.requiresInstruction);
  const gated = options.filter((option) => option.requiresInstruction);

  return (
    <div className="stack">
      <ApprovalEvidenceBlock evidence={evidence} options={options} />

      <div className="approval-panel">
        <div className="row">
          {immediate.map((option) => (
            <Button
              key={option.decision}
              variant={option.decision === "approve" ? "success" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => onConfirm(option.decision)}
            >
              {option.label}
            </Button>
          ))}
          {gated.map((option) => (
            <Button
              key={option.decision}
              variant={option.decision === "reject" ? "danger" : "default"}
              size="sm"
              disabled={busy}
              aria-pressed={selected === option.decision}
              aria-expanded={selected === option.decision ? true : undefined}
              onClick={() => onSelect(option.decision)}
            >
              {option.label}
            </Button>
          ))}
          {options.length === 0 ? (
            <span className="faint small">
              The server allows no decision for this gate.
            </span>
          ) : null}
        </div>

        {selectedOption ? (
          <div className="stack">
            <Field
              label={selectedOption.reasonLabel ?? "Reason (mandatory)"}
              htmlFor="approval-reason"
              help={selectedOption.reasonHelp}
              error={error ?? undefined}
            >
              <TextArea
                id="approval-reason"
                rows={3}
                value={reason}
                onChange={onReasonChange}
                ariaLabel={selectedOption.reasonLabel ?? "Decision reason"}
                invalid={Boolean(error)}
              />
            </Field>
            <div className="row">
              <Button
                variant={
                  selectedOption.decision === "reject" ? "danger" : "primary"
                }
                size="sm"
                disabled={busy || reason.trim().length === 0}
                onClick={() => onConfirm(selectedOption.decision)}
              >
                Confirm {selectedOption.label}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
            <p className="faint small wrap-anywhere">{selectedOption.detail}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
