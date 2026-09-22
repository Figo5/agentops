/**
 * Review: who reviewed it, what they decided, what they found.
 *
 * The default view is reviewer → verdict → finding counts → findings, with the
 * reviewer's full prose one click away in `Read full review` and the raw payload
 * below it. The persisted severity word and the reviewer's provenance sentence
 * live under `Technical details`; the review/fix chronology — every earlier
 * verdict, newest first — is folded below rather than deleted.
 */
import { useMemo } from "react";
import type { RunDetailResponse } from "../api.js";
import { formatTimestamp } from "../view-model.js";
import { reviewHistory, type ReviewEntryView } from "../run-view.js";
import {
  Card,
  CodeBlock,
  Disclosure,
  KeyValue,
  Notice,
  Pill,
} from "./Bits.js";

function FindingList({
  label,
  findings,
}: {
  label: string;
  findings: ReviewEntryView["issues"];
}) {
  if (findings.length === 0) return null;
  return (
    <div className="stack--tight">
      <h4>
        {label} ({findings.length})
      </h4>
      <ul className="evidence-issues">
        {findings.map((issue, index) => (
          <li key={index} className="evidence-issue">
            <span className="evidence-issue__body wrap-anywhere">
              {issue.description}
            </span>
            {issue.location ? (
              <span className="mono small faint">{issue.location}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntryBody({ entry }: { entry: ReviewEntryView }) {
  const blockers = entry.issues.filter((issue) => issue.disposition === "blocker");
  const suggestions = entry.issues.filter(
    (issue) => issue.disposition === "suggestion",
  );
  return (
    <div className="stack">
      <div className="review__head">
        <Pill tone={entry.tone}>{entry.label}</Pill>
        <span className="review__reviewer wrap-anywhere">
          <b>{entry.reviewer}</b>
        </span>
        <span className="faint small">{formatTimestamp(entry.createdAt)}</span>
      </div>
      <p className="faint small">
        {entry.blockers} blocker{entry.blockers === 1 ? "" : "s"} ·{" "}
        {entry.suggestions} suggestion
        {entry.suggestions === 1 ? "" : "s"}
      </p>

      {!entry.valid ? (
        <Notice tone="warn">
          This verdict could not be used: {entry.validationErrors.join("; ") || "no detail reported"}
        </Notice>
      ) : null}

      {blockers.length + suggestions.length === 0 ? (
        <p className="faint small">The reviewer raised no findings.</p>
      ) : null}
      <FindingList label="Blockers" findings={blockers} />
      <FindingList label="Suggestions" findings={suggestions} />

      <Disclosure summary="Read full review">
        {entry.summary ? (
          <p className="wrap-anywhere">{entry.summary}</p>
        ) : (
          <p className="faint small">
            The reviewer wrote no summary for this verdict.
          </p>
        )}
      </Disclosure>

      <Disclosure summary="Technical details">
        <KeyValue
          rows={[
            ["Review stage", entry.stageName],
            ["Stage key", <span className="mono">{entry.stageKey}</span>],
            ["Review cycle", String(entry.cycle)],
            ["Verdict", entry.label],
            ["Payload usable", entry.valid ? "yes" : "no"],
            [
              "Validation errors",
              entry.validationErrors.length > 0
                ? entry.validationErrors.join("; ")
                : "none",
            ],
          ]}
        />
        <p className="faint small">{entry.reviewerProvenance}</p>
        <ul className="evidence-issues">
          {entry.issues.map((issue, index) => (
            <li key={index} className="evidence-issue">
              <span className="faint small">
                reviewed severity: {issue.severity}
                {issue.location ? ` · ${issue.location}` : ""}
              </span>
              <span className="evidence-issue__body wrap-anywhere">
                {issue.description}
              </span>
            </li>
          ))}
        </ul>
        <Disclosure summary="Raw review payload (JSON)">
          <CodeBlock
            text={entry.raw}
            emptyLabel="No raw payload was persisted."
          />
        </Disclosure>
      </Disclosure>
    </div>
  );
}

export function ReviewPanel({ detail }: { detail: RunDetailResponse }) {
  const history = useMemo(
    () =>
      reviewHistory({
        verdicts: detail.reviewVerdicts,
        attempts: detail.attempts,
        agents: detail.agents,
        stages: detail.stages,
      }),
    [detail],
  );
  const latest = history[0] ?? null;
  const prior = history.slice(1);

  return (
    <div className="panel panel--review">
      <Card title="Review verdicts">
        {latest ? (
          <EntryBody entry={latest} />
        ) : (
          <p className="faint small">This run has not been reviewed yet.</p>
        )}
      </Card>

      {prior.length > 0 ? (
        <Card
          title={`Earlier reviews (${prior.length})`}
          hint="Every earlier verdict this run recorded, newest first."
        >
          <div className="stack--tight">
            {prior.map((entry) => (
              <Disclosure
                key={entry.id}
                summary={`${entry.label} · ${entry.reviewer} · ${formatTimestamp(entry.createdAt)}`}
              >
                <EntryBody entry={entry} />
              </Disclosure>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
