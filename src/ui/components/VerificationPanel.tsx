/**
 * Verification: the commands that were run, what they decided, and the raw
 * output.
 *
 * The default view is operator language and nothing else: one row per command
 * with its status, counts and duration, the raw stdout/stderr folded behind it,
 * and — when the attempt ran several commands — the attempt-level counts stated
 * once with the attribution limit. Everything derived from the normalized test
 * rows (the parsed rows themselves, the recorded summary, the count source, the
 * exit codes, stage and attempt keys) lives under `Technical details`, so the
 * same count is never presented twice. Nothing is deleted; nothing is presented
 * twice.
 */
import { useMemo } from "react";
import type { RunDetailResponse } from "../api.js";
import {
  formatCount,
  formatDuration,
  formatTimestamp,
  statusLabel,
} from "../view-model.js";
import {
  verificationFailed,
  verificationHistory,
  type VerificationCommandRow,
  type VerificationEntryView,
} from "../run-view.js";
import {
  Button,
  Card,
  CodeBlock,
  Disclosure,
  KeyValue,
  Notice,
  Pill,
  StatusPill,
} from "./Bits.js";

/** One command row: what ran, what it decided, how long it took. */
function CommandRow({
  command,
  counts,
}: {
  command: VerificationCommandRow;
  /**
   * Counts for this command, only when the attribution is unambiguous: an
   * attempt that ran exactly one command. A multi-command attempt keeps its
   * counts at attempt level instead of stamping them on every command.
   */
  counts: string | null;
}) {
  return (
    <div className="command-row">
      <div className="command-row__head">
        <b className="mono wrap-anywhere">{command.command}</b>
        <span className="command-row__facts">
          <StatusPill status={command.status} />
          {counts ? <span className="faint small">{counts}</span> : null}
          <span className="faint small">
            {formatDuration(command.durationMs)}
          </span>
          {command.truncated ? <Pill tone="warn">truncated</Pill> : null}
        </span>
      </div>
      {command.stdoutExcerpt || command.stderrExcerpt ? (
        <Disclosure summary="Raw output">
          {command.stdoutExcerpt ? (
            <CodeBlock text={command.stdoutExcerpt} label="stdout" />
          ) : null}
          {command.stderrExcerpt ? (
            <CodeBlock text={command.stderrExcerpt} label="stderr" />
          ) : null}
        </Disclosure>
      ) : null}
      {command.status === "failed" ? (
        <p className="faint small">
          Exit code {command.exitCode === null ? "unknown" : command.exitCode} ·
          run in {command.cwd ?? "the repository root"}
        </p>
      ) : null}
    </div>
  );
}

function EntryBody({ entry }: { entry: VerificationEntryView }) {
  const failed = verificationFailed(entry);
  const singleCommand = entry.commands.length === 1;
  return (
    <div className="stack">
      {failed ? (
        <Notice tone="error">
          This verification did not pass.
          {entry.reason ? ` ${entry.reason}` : ""}
        </Notice>
      ) : null}

      {entry.commands.length > 0 ? (
        <div className="stack--tight">
          {entry.commands.map((command) => (
            <CommandRow
              key={command.id}
              command={command}
              counts={singleCommand ? entry.countsLabel : null}
            />
          ))}
        </div>
      ) : (
        <p className="faint small">
          No command was recorded for this verification.
        </p>
      )}

      {!singleCommand && entry.commands.length > 1 ? (
        <p className="faint small wrap-anywhere">
          {entry.countsLabel} for this verification as a whole. The commands
          above are listed individually because the run cannot attribute those
          counts to one of them.
        </p>
      ) : null}

      <Disclosure summary="Technical details">
        <KeyValue
          rows={[
            ["Outcome", statusLabel(entry.status)],
            [
              "Recorded summary",
              entry.summary ?? "no summary was recorded for this verification",
            ],
            ["Counts", entry.countsLabel],
            [
              "Count source",
              entry.countsSource === "verification record"
                ? "the attempt's verification outcome"
                : entry.countsSource === "normalized test run"
                  ? `the parsed ${entry.framework ?? "test"} output for this attempt`
                  : "no counts were parsed",
            ],
            ["Stage", entry.stageName],
            ["Stage key", <span className="mono">{entry.stageKey}</span>],
            [
              "Attempt",
              <span className="mono">
                #{entry.attemptNumber} ({entry.attemptId})
              </span>,
            ],
            [
              "Exit codes",
              entry.commands
                .map((command) =>
                  command.exitCode === null
                    ? "unknown"
                    : String(command.exitCode),
                )
                .join(", ") || "no commands",
            ],
          ]}
        />
        {entry.tests.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Framework</th>
                <th scope="col">Status</th>
                <th scope="col">Counts</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {entry.tests.map((test) => (
                <tr key={test.id}>
                  <td className="mono">{test.framework}</td>
                  <td>
                    <StatusPill status={test.status} />
                  </td>
                  <td className="wrap-anywhere">{test.countsLabel}</td>
                  <td>{formatDuration(test.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="faint small">
            No parsed test output was recorded for this attempt.
          </p>
        )}
        {entry.testsHidden > 0 ? (
          <p className="faint small">
            {formatCount(entry.testsHidden)} earlier parsed test record
            {entry.testsHidden === 1 ? "" : "s"} for this attempt are folded;
            the counts above stay this attempt's newest record.
          </p>
        ) : null}
      </Disclosure>
    </div>
  );
}

export function VerificationPanel({ detail }: { detail: RunDetailResponse }) {
  const history = useMemo(
    () =>
      verificationHistory({
        attempts: detail.attempts,
        tests: detail.tests,
        commands: detail.commands,
        stages: detail.stages,
      }),
    [detail],
  );
  const latest = history[0] ?? null;
  const older = history.slice(1);

  if (!latest) {
    return (
      <div className="panel panel--verification">
        <Card title="Verification">
          <p className="faint small">This run has not verified anything yet.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="panel panel--verification">
      <Card
        title={latest.stageName}
        hint={`Verified ${formatTimestamp(latest.recordedAt)}`}
      >
        <EntryBody entry={latest} />
      </Card>

      {older.length > 0 ? (
        <Card
          title="Earlier verifications"
          hint={`${older.length} earlier verification${older.length === 1 ? "" : "s"} on this run.`}
        >
          <div className="stack--tight">
            {older.map((entry) => (
              <Disclosure
                key={entry.attemptId}
                // The heading names the attempt and its persisted outcome; the
                // parsed test counts belong to the command rows inside, not to
                // a second summary line here.
                summary={`${entry.stageName} · ${statusLabel(entry.status)} · ${formatTimestamp(entry.recordedAt)}`}
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
