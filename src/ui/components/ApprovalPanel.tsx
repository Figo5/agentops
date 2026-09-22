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
  classNames,
  formatTimestamp,
  type ApprovalEvidence,
  type DecisionOption,
} from "../view-model.js";
import {
  decisionLead,
  type DecisionFact,
  type VerificationTestRow,
} from "../run-view.js";
import { Button, Disclosure, Field, TextArea } from "./Bits.js";

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
  facts = [],
}: {
  evidence: ApprovalEvidence;
  /** Recorded facts shown before any button: changes, checks, blockers. */
  facts?: readonly DecisionFact[];
}) {
  const { verdict, verification } = evidence;
  return (
    <div className="evidence-summary">
      <h2 className="evidence-summary__state">
        {approvalStateHeadline(evidence.gate)}
      </h2>
      <p className="evidence-summary__lead">{decisionLead(evidence)}</p>
      {facts.length > 0 ? (
        <ul className="evidence-facts">
          {facts.map((fact, index) => (
            <li
              key={`${index}-${fact.label}`}
              className={classNames(
                "evidence-fact",
                `evidence-fact--${fact.tone}`,
              )}
            >
              {fact.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Everything behind the decision, in one collapsed disclosure: the persisted
 * provenance, each fact's own detail, the attempt's test rows and what each
 * decision does. Nothing is deleted; none of it competes with the buttons.
 */
export function ApprovalEvidenceDetails({
  evidence,
  options,
  facts = [],
  latestTests = [],
  testsHidden = 0,
}: {
  evidence: ApprovalEvidence;
  options: readonly DecisionOption[];
  facts?: readonly DecisionFact[];
  latestTests?: readonly VerificationTestRow[];
  testsHidden?: number;
}) {
  return (
    <>
      <Disclosure summary="Technical details">
        <Provenance evidence={evidence} />
        {facts.length > 0 ? (
          <ul className="stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
            {facts.map((fact, index) => (
              <li
                key={`detail-${index}-${fact.label}`}
                className="small wrap-anywhere"
              >
                <b>{fact.label}</b>
                {fact.detail ? ` — ${fact.detail}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {latestTests.length > 0 ? (
          <>
            <span className="faint small">
              Test rows for this attempt ({latestTests.length}
              {testsHidden > 0 ? ` of ${latestTests.length + testsHidden}` : ""}
              )
            </span>
            <ul className="stack--tight" style={{ margin: 0, paddingLeft: 18 }}>
              {latestTests.map((test) => (
                <li key={test.id} className="small wrap-anywhere">
                  <b>{test.framework}</b> — {test.countsLabel} ·{" "}
                  {formatTimestamp(test.createdAt)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <span className="faint small">What each decision does</span>
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
  facts,
  latestTests,
  testsHidden,
  selected,
  reason,
  busy,
  error,
  onSelect,
  onReasonChange,
  onCancel,
  onConfirm,
  onReviewChanges,
  onOpenReview,
  showDetails = true,
}: {
  evidence: ApprovalEvidence;
  options: readonly DecisionOption[];
  facts?: readonly DecisionFact[];
  latestTests?: readonly VerificationTestRow[];
  testsHidden?: number;
  /** The reason-requiring decision the operator selected, if any. */
  selected: ApprovalDecision | null;
  reason: string;
  busy: boolean;
  error?: string | null;
  onSelect: (decision: ApprovalDecision) => void;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: (decision: ApprovalDecision) => void;
  /** Secondary action at the final gate: read the changes before accepting. */
  onReviewChanges?: () => void;
  /** Secondary action: the reviewer's own findings live in the Review tab. */
  onOpenReview?: () => void;
  /**
   * `false` keeps the sheet to its summary, facts and buttons: the run page
   * renders the technical disclosure once, at the bottom of the page.
   */
  showDetails?: boolean;
}) {
  const selectedOption =
    options.find((option) => option.decision === selected) ?? null;
  const immediate = options.filter((option) => !option.requiresInstruction);
  const gated = options.filter((option) => option.requiresInstruction);

  return (
    <div className="stack">
      <div className="approval-evidence" aria-label="Approval evidence">
        <ApprovalEvidenceBlock evidence={evidence} facts={facts} />

        <div className="approval-panel">
          <div className="approval-actions">
            {immediate.map((option) => (
              <Button
                key={option.decision}
                variant={option.decision === "approve" ? "primary" : "default"}
                size={option.decision === "approve" ? "md" : "sm"}
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
            {onReviewChanges ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onReviewChanges}
                disabled={busy}
              >
                Review changes
              </Button>
            ) : null}
            {onOpenReview ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenReview}
                disabled={busy}
              >
                Read full review
              </Button>
            ) : null}
          </div>
        </div>

        {showDetails ? (
          <ApprovalEvidenceDetails
            evidence={evidence}
            options={options}
            facts={facts}
            latestTests={latestTests}
            testsHidden={testsHidden}
          />
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
  );
}
