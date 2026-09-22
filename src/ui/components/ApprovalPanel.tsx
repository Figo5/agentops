/**
 * The human decision block for a pending approval gate.
 *
 * Ordering is deliberate and load-bearing: the persisted evidence (gate, the
 * blocking verdict, the verification outcome and the review-cycle position) is
 * rendered *before* any decision button, so an operator never decides from a
 * bare pair of buttons.
 *
 * The default view of that evidence is deliberately short — reviewer + verdict,
 * the count of blockers and suggestions, and the latest verification — because
 * a full review payload used to consume the entire viewport. The complete
 * payload is not hidden or deleted: the review prose, every finding with its
 * persisted severity and location, and all provenance move one level down into
 * `Read full review` / `Technical details`. Nothing is summarised away, and
 * nothing is invented to fill a gap.
 *
 * A decision that requires a reason is selected first and only then reveals its
 * mandatory reason field; the decision itself is submitted by an explicit
 * confirm button. A single stray click cannot record a rejection or an override.
 * Decisions that take no reason (acceptance) submit directly.
 */
import type { ApprovalDecision } from "../../core/types.js";
import {
  approvalStateHeadline,
  approvalSummaryLine,
  formatTimestamp,
  issueDisposition,
  issueDispositionLabel,
  type ApprovalEvidence,
  type DecisionOption,
} from "../view-model.js";
import { Button, Disclosure, Field, Notice, Pill, TextArea } from "./Bits.js";

function Provenance({ evidence }: { evidence: ApprovalEvidence }) {
  const { verdict, verification } = evidence;
  return (
    <dl className="kv">
      <dt>Gate</dt>
      <dd>
        {evidence.gateLabel}
        {evidence.stageKey ? ` · stage ${evidence.stageKey}` : ""}
      </dd>
      <dt>Review cycle</dt>
      <dd>{evidence.cycle.label}</dd>
      {evidence.reason ? (
        <>
          <dt>Recorded reason</dt>
          <dd>{evidence.reason}</dd>
        </>
      ) : null}
      {verdict ? (
        <>
          <dt>Verdict</dt>
          <dd>
            {verdict.label}
            {verdict.valid ? "" : " (payload failed validation)"} · stage{" "}
            {verdict.stageKey} · cycle {verdict.cycle} ·{" "}
            {formatTimestamp(verdict.createdAt)}
          </dd>
          <dt>Reviewer</dt>
          <dd>
            {verdict.reviewer} — {verdict.reviewerProvenance}
          </dd>
          <dt>Findings</dt>
          <dd>{verdict.tally.label}</dd>
        </>
      ) : (
        <>
          <dt>Verdict</dt>
          <dd>
            No review verdict is recorded for this stage; the gate comes from
            the run plan rather than from a reviewer payload.
          </dd>
        </>
      )}
      <dt>Verification</dt>
      <dd>
        {verification ? (
          <>
            {verification.label} · stage {verification.stageKey} · attempt #
            {verification.attemptNumber}
            {verification.countsSource === "normalized test run"
              ? ` (counts from the normalized test run${verification.framework ? ` ${verification.framework}` : ""})`
              : ""}
            {verification.onGateStage
              ? ""
              : " (last verification recorded for this run)"}
          </>
        ) : (
          "No verification outcome is recorded for this run."
        )}
      </dd>
    </dl>
  );
}

export function ApprovalEvidenceBlock({
  evidence,
}: {
  evidence: ApprovalEvidence;
}) {
  const { verdict, verification } = evidence;
  return (
    <div className="evidence-summary">
      <h2 className="evidence-summary__state">
        {approvalStateHeadline(evidence.gate)}
      </h2>
      <p className="evidence-summary__lead">{approvalSummaryLine(evidence)}</p>
      <div className="evidence-summary__facts">
        <span>{evidence.cycle.label}</span>
        {verdict ? <span>{verdict.tally.label}</span> : null}
        <span>
          {verification
            ? `Verification: ${verification.shortLabel}`
            : "No verification recorded"}
        </span>
      </div>
    </div>
  );
}

/** The full payload, one level down: prose, findings and provenance. */
export function ApprovalEvidenceDetails({
  evidence,
  options,
}: {
  evidence: ApprovalEvidence;
  options: readonly DecisionOption[];
}) {
  const { verdict } = evidence;
  return (
    <>
      {verdict ? (
        <Disclosure summary={`Read full review (${verdict.tally.label})`}>
          <div className="evidence-verdict-head">
            <Pill tone={verdict.tone} dot={false}>
              {verdict.label}
            </Pill>
            <span className="faint small">
              {verdict.reviewer} · stage {verdict.stageKey} · cycle{" "}
              {verdict.cycle} · {formatTimestamp(verdict.createdAt)}
            </span>
          </div>
          {!verdict.valid ? (
            <Notice tone="warn">
              The verdict payload failed validation, so no structured verdict
              was accepted.
            </Notice>
          ) : null}
          <p className="wrap-anywhere">
            {verdict.summary ?? "No review summary was recorded."}
          </p>
          {verdict.issues.length > 0 ? (
            <ul className="evidence-issues">
              {verdict.issues.map((issue, index) => {
                const disposition = issueDisposition(issue.severity);
                return (
                  <li key={index} className="evidence-issue">
                    <div className="evidence-issue__head">
                      <Pill
                        tone={disposition === "blocker" ? "danger" : "muted"}
                        dot={false}
                      >
                        {issueDispositionLabel(disposition)}
                      </Pill>
                      <span className="faint small">
                        reviewed severity: {issue.severity}
                        {issue.location ? ` · ${issue.location}` : ""}
                      </span>
                    </div>
                    <span className="evidence-issue__body">
                      {issue.description}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="faint small">The verdict lists no issues.</p>
          )}
        </Disclosure>
      ) : null}

      <Disclosure summary="Technical details">
        <Provenance evidence={evidence} />
      </Disclosure>

      <Disclosure summary="What each decision does">
        <ul className="stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
          {options.map((option) => (
            <li key={option.decision} className="small wrap-anywhere">
              <b>{option.label}</b> — {option.detail}
              {option.requiresInstruction ? " A reason is mandatory." : ""}
            </li>
          ))}
        </ul>
      </Disclosure>
    </>
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
      <div className="approval-evidence" aria-label="Approval evidence">
        <ApprovalEvidenceBlock evidence={evidence} />

        <div className="approval-panel">
          <div className="approval-actions">
            {immediate.map((option) => (
              <Button
                key={option.decision}
                variant={option.decision === "approve" ? "primary" : "default"}
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
                /* Neutral until the operator confirms the destructive choice. */
                variant="default"
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
        </div>

        <ApprovalEvidenceDetails evidence={evidence} options={options} />
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
  );
}
