/**
 * Right-hand inspector: git checkpoints and the real diff, test runs, review
 * verdicts, artifacts (with registration) and measured usage.
 *
 * Everything is read from the run detail payload. Absent values render as
 * UNKNOWN rather than as zero, and the diff viewer is labelled for what it
 * actually is: the project's current working-tree/index diff, not a historical
 * snapshot diff (the API exposes no snapshot-scoped diff).
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { AgentOpsClient, RunDetailResponse } from "../api.js";
import { useAction, useResource } from "../hooks.js";
import {
  EMPTY_ARTIFACT_FORM,
  artifactView,
  classifyDiff,
  formatBytes,
  formatDuration,
  formatTimestamp,
  relativeTime,
  reviewerIdentity,
  reviewCycleView,
  snapshotView,
  statusLabel,
  testCountsLabel,
  text,
  usageView,
  validateArtifactForm,
  verdictLabel,
  verdictTone,
  type ArtifactForm,
} from "../view-model.js";
import {
  Button,
  Card,
  Checkbox,
  CodeBlock,
  DiffView,
  ErrorBox,
  Field,
  KeyValue,
  Notice,
  Pill,
  StatusPill,
  TabPanel,
  TextInput,
  Tabs,
} from "./Bits.js";

const INSPECTOR_TABS_ID = "inspector-sections";

function SnapshotCard({
  client,
  detail,
}: {
  client: AgentOpsClient;
  detail: RunDetailResponse;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const snapshots = useMemo(
    () =>
      [...detail.snapshots].sort((a, b) =>
        a.capturedAt.localeCompare(b.capturedAt),
      ),
    [detail.snapshots],
  );
  const selected =
    snapshots.find((snapshot) => snapshot.id === selectedId) ??
    snapshots[snapshots.length - 1] ??
    null;
  const projectId = detail.project?.id ?? detail.run.projectId;

  const diff = useResource(
    detail.project && detail.project.vcs === "git"
      ? () => client.projectDiff(projectId, staged)
      : null,
    [projectId, staged, detail.project?.vcs],
  );

  if (detail.project && detail.project.vcs !== "git") {
    return (
      <Card title="Git checkpoints">
        <Notice tone="warn">
          This project is registered with{" "}
          <span className="mono">vcs: none</span>. No snapshots, diffs or branch
          policy are recorded for it.
        </Notice>
      </Card>
    );
  }

  return (
    <Card
      title="Git checkpoints"
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void diff.reload()}
          disabled={diff.loading}
        >
          {diff.loading ? "Loading…" : "Refresh diff"}
        </Button>
      }
      hint={`${snapshots.length} checkpoint(s) recorded for this run.`}
    >
      {snapshots.length === 0 ? (
        <p className="faint small">
          No git checkpoints were captured for this run.
        </p>
      ) : (
        <div className="stack--tight checkpoint-list">
          {snapshots.map((snapshot) => {
            const view = snapshotView(snapshot);
            const isSelected = selected?.id === snapshot.id;
            return (
              <div
                key={snapshot.id}
                className="attempt"
                aria-current={isSelected ? "true" : undefined}
              >
                <button
                  type="button"
                  className="rail__button"
                  style={{ padding: 0 }}
                  onClick={() => setSelectedId(snapshot.id)}
                  aria-expanded={isSelected}
                >
                  <span className="attempt__head">
                    <Pill
                      tone={snapshot.phase === "before" ? "info" : "muted"}
                      dot={false}
                    >
                      {snapshot.phase}
                    </Pill>
                    <span className="mono small">{snapshot.stageKey}</span>
                    <Pill
                      tone={snapshot.dirty ? "warn" : "success"}
                      dot={false}
                    >
                      {view.dirtyLabel}
                    </Pill>
                  </span>
                  <span className="faint small mono">
                    {view.branch} @ {view.head}
                  </span>
                  <span className="faint small">
                    staged {view.staged} · unstaged {view.unstaged} · untracked{" "}
                    {view.untracked} · ahead {view.ahead} · behind {view.behind}
                  </span>
                  <span className="faint small">
                    {formatTimestamp(snapshot.capturedAt)}
                  </span>
                </button>
                {snapshot.unavailableReason ? (
                  <p className="field__error small">
                    checkpoint unavailable: {snapshot.unavailableReason}
                  </p>
                ) : null}
                {isSelected ? (
                  <div className="stack--tight" style={{ marginTop: 8 }}>
                    {view.changedPaths.length > 0 ? (
                      <CodeBlock
                        label="changed / untracked paths"
                        text={view.changedPaths.join("\n")}
                      />
                    ) : (
                      <p className="faint small">
                        No changed or untracked paths in this checkpoint.
                      </p>
                    )}
                    {snapshot.diffStat ? (
                      <>
                        <span className="faint small">diff stat</span>
                        <pre className="code">{snapshot.diffStat}</pre>
                        {view.diffStats ? (
                          <span className="faint small">
                            parsed: {view.diffStats.filesChanged ?? "UNKNOWN"}{" "}
                            file(s) changed,{" "}
                            {view.diffStats.insertions ?? "UNKNOWN"}{" "}
                            insertion(s),{" "}
                            {view.diffStats.deletions ?? "UNKNOWN"} deletion(s)
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <p className="faint small">diff stat: UNKNOWN</p>
                    )}
                    {snapshot.localCommits.length > 0 ? (
                      <div>
                        <span className="faint small">local commits</span>
                        <ul
                          className="stack--tight"
                          style={{ margin: 0, paddingLeft: 18 }}
                        >
                          {snapshot.localCommits.map((commit) => (
                            <li key={commit.sha} className="mono small">
                              {commit.sha.slice(0, 8)} {commit.subject}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="faint small">
                        No local commits recorded in this checkpoint.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="stack" style={{ marginTop: 12 }}>
        <h4>Repository diff</h4>
        <p className="faint small">
          This is the project's current{" "}
          {staged ? "staged (index)" : "working-tree"} diff as reported by the
          server — not a reconstruction of the historical checkpoint above.
        </p>
        <Checkbox
          checked={staged}
          onChange={setStaged}
          id="inspector-diff-staged"
          label="Use the staged diff (index)"
        />
        <ErrorBox error={diff.error} onRetry={() => void diff.reload()} />
        {diff.data ? (
          diff.data.diff.trim() ? (
            <DiffView lines={classifyDiff(diff.data.diff)} />
          ) : (
            <p className="faint small">The diff is empty.</p>
          )
        ) : null}
      </div>
    </Card>
  );
}

function ArtifactRegistration({
  client,
  detail,
  refresh,
}: {
  client: AgentOpsClient;
  detail: RunDetailResponse;
  refresh: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<ArtifactForm>(EMPTY_ARTIFACT_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const idPrefix = useId();
  const action = useAction(client, refresh);

  const submit = async () => {
    const result = validateArtifactForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const created = await action.run((c) =>
      c.registerArtifact(detail.run.id, result.value),
    );
    if (created) setForm(EMPTY_ARTIFACT_FORM);
  };

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <h4>Register an artifact reference</h4>
      <div className="grid grid--forms">
        <Field
          label="Repository-relative path"
          htmlFor={`${idPrefix}-path`}
          error={errors["path"]}
          help="Must stay inside the project root."
        >
          <TextInput
            id={`${idPrefix}-path`}
            value={form.path}
            onChange={(value) => setForm({ ...form, path: value })}
            placeholder="reports/run.md"
          />
        </Field>
        <Field
          label="Kind"
          htmlFor={`${idPrefix}-kind`}
          error={errors["kind"]}
          help="e.g. report, patch, log"
        >
          <TextInput
            id={`${idPrefix}-kind`}
            value={form.kind}
            onChange={(value) => setForm({ ...form, kind: value })}
          />
        </Field>
      </div>
      {action.error ? <ErrorBox error={action.error} /> : null}
      <div>
        <Button size="sm" onClick={submit} disabled={action.pending}>
          {action.pending ? "Registering…" : "Register artifact"}
        </Button>
      </div>
    </div>
  );
}

export function Inspector({
  client,
  detail,
  refreshDetail,
}: {
  client: AgentOpsClient;
  detail: RunDetailResponse;
  refreshDetail: () => void | Promise<void>;
}) {
  const [panel, setPanel] = useState("evidence");
  const [showAllTests, setShowAllTests] = useState(false);
  useEffect(() => setShowAllTests(false), [detail.run.id]);

  const reviewCycle = reviewCycleView(detail.run);
  const tests = showAllTests ? detail.tests : detail.tests.slice(0, 5);
  const usageRows = detail.attempts.map((attempt) => ({
    id: attempt.id,
    label: `#${attempt.attemptNumber} ${attempt.stageKey}`,
    usage: usageView(attempt.usage, attempt.usageKnown),
  }));
  const knownUsage = usageRows.filter((row) => row.usage.known).length;

  return (
    <aside className="inspector" aria-label="Run inspector">
      <Tabs
        idBase={INSPECTOR_TABS_ID}
        label="Run inspector sections"
        active={panel}
        onChange={setPanel}
        tabs={[
          { id: "evidence", label: "Checks" },
          { id: "git", label: "Git" },
          { id: "artifacts", label: "Files" },
          { id: "record", label: "Details" },
        ]}
      />
      <TabPanel
        idBase={INSPECTOR_TABS_ID}
        id="git"
        selected={panel === "git"}
        className="inspector-section"
      >
        <SnapshotCard client={client} detail={detail} />
      </TabPanel>
      <TabPanel
        idBase={INSPECTOR_TABS_ID}
        id="evidence"
        selected={panel === "evidence"}
        className="inspector-section"
      >
        <Card
          title="Tests & verification"
          hint="Only confidently parsed counts are shown; anything else is UNKNOWN."
        >
          {detail.tests.length === 0 ? (
            <p className="faint small">
              No test runs were recorded for this run.
            </p>
          ) : (
            <div className="stack--tight">
              {tests.map((test) => (
                <div key={test.id} className="attempt">
                  <div className="row row--between">
                    <b className="mono">{test.framework}</b>
                    <StatusPill status={test.status} />
                  </div>
                  <div className="faint small">{testCountsLabel(test)}</div>
                  <div className="faint small">
                    stage {test.stageKey} · {formatDuration(test.durationMs)} ·{" "}
                    {formatTimestamp(test.createdAt)}
                  </div>
                  {test.summary ? (
                    <p className="small wrap-anywhere">{test.summary}</p>
                  ) : null}
                </div>
              ))}
              {detail.tests.length > 5 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAllTests((current) => !current)}
                >
                  {showAllTests
                    ? "Show fewer"
                    : `Show all ${detail.tests.length}`}
                </Button>
              ) : null}
            </div>
          )}
        </Card>

        <Card
          title="Review verdicts"
          hint="A verdict is only accepted when the structured payload validates."
        >
          {detail.reviewVerdicts.length === 0 ? (
            <p className="faint small">No review verdict was recorded yet.</p>
          ) : (
            <div className="stack--tight">
              {detail.reviewVerdicts.map((verdict) => (
                <div key={verdict.id} className="attempt">
                  <div className="row row--between">
                    <Pill tone={verdictTone(verdict.verdict)}>
                      {verdictLabel(verdict.verdict, verdict.valid)}
                    </Pill>
                    <span className="faint small">
                      review cycle {verdict.cycle}
                    </span>
                  </div>
                  <div className="faint small">
                    {verdict.stageKey} · reviewer{" "}
                    <b className="wrap-anywhere">
                      {
                        reviewerIdentity({
                          reviewer: verdict.reviewer,
                          attemptId: verdict.attemptId,
                          attempts: detail.attempts,
                          agents: detail.agents,
                        }).name
                      }
                    </b>{" "}
                    · {formatTimestamp(verdict.createdAt)}
                  </div>
                  {verdict.summary ? (
                    <p className="small wrap-anywhere">{verdict.summary}</p>
                  ) : null}
                  <div className="faint small">
                    {verdict.issues.length} issue(s)
                    {verdict.valid
                      ? ""
                      : ` · invalid: ${verdict.validationErrors.join("; ") || "no detail"}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </TabPanel>
      <TabPanel
        idBase={INSPECTOR_TABS_ID}
        id="artifacts"
        selected={panel === "artifacts"}
        className="inspector-section"
      >
        <Card
          title="Artifacts"
          hint="References to canonical paths inside the repository. No payload is downloaded."
        >
          {detail.artifacts.length === 0 ? (
            <p className="faint small">No artifacts registered for this run.</p>
          ) : (
            <div className="stack--tight">
              {detail.artifacts.map((artifact) => {
                const view = artifactView(artifact);
                return (
                  <div key={artifact.id} className="attempt">
                    <div className="row row--between">
                      <b className="mono wrap-anywhere">{artifact.path}</b>
                      <Pill tone={artifact.exists ? "success" : "danger"}>
                        {view.exists}
                      </Pill>
                    </div>
                    <div className="faint small">
                      kind {artifact.kind} · creator {artifact.creator} · size{" "}
                      {formatBytes(artifact.sizeBytes)}
                    </div>
                    <div className="faint small">
                      stage {artifact.stageKey} · registered{" "}
                      {formatTimestamp(artifact.createdAt)} (
                      {relativeTime(artifact.createdAt)})
                    </div>
                    {artifact.note ? (
                      <p className="small">{artifact.note}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <ArtifactRegistration
            client={client}
            detail={detail}
            refresh={refreshDetail}
          />
        </Card>
      </TabPanel>
      <TabPanel
        idBase={INSPECTOR_TABS_ID}
        id="record"
        selected={panel === "record"}
        className="inspector-section"
      >
        <Card
          title="Measured usage"
          hint={`${knownUsage}/${usageRows.length} attempt(s) report measured usage. Unknown is never rendered as zero.`}
        >
          {usageRows.length === 0 ? (
            <p className="faint small">No attempts yet.</p>
          ) : (
            <div className="stack--tight">
              {usageRows.map((row) => (
                <KeyValue
                  key={row.id}
                  rows={[
                    [
                      row.label,
                      <span className="mono">
                        {row.usage.known
                          ? `${row.usage.input} in / ${row.usage.output} out / ${row.usage.total} total`
                          : "UNKNOWN"}
                      </span>,
                    ],
                    ["cost", <span className="mono">{row.usage.cost}</span>],
                  ]}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title="Run record">
          <KeyValue
            rows={[
              [
                "Run id",
                <span className="mono wrap-anywhere">{detail.run.id}</span>,
              ],
              ["Status", statusLabel(detail.run.status)],
              [
                "Project root",
                <span className="mono wrap-anywhere">
                  {detail.run.projectRoot}
                </span>,
              ],
              [
                "Template",
                `${detail.run.templateId} v${detail.run.templateVersion}`,
              ],
              [
                "Review cycle",
                `${reviewCycle.label} · ${reviewCycle.used} fix cycle(s) used`,
              ],
              ["Git policy", detail.run.policy.gitPolicy],
              ["Epoch", String(detail.run.epoch)],
              ["Next stage", text(detail.run.nextStageKey, "none")],
              ["Created", formatTimestamp(detail.run.createdAt)],
              ["Started", formatTimestamp(detail.run.startedAt)],
              ["Ended", formatTimestamp(detail.run.endedAt)],
              ["Failure", detail.run.failureReason ?? "none"],
              ["Cancel reason", detail.run.cancelReason ?? "none"],
              ["Interrupt reason", detail.run.interruptReason ?? "none"],
            ]}
          />
        </Card>
      </TabPanel>
    </aside>
  );
}
