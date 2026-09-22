/**
 * Changes: the unified diff at full main width, with file navigation above it
 * and the recorded checkpoints folded underneath.
 *
 * The two things on this screen are labelled for what they are. The diff is the
 * project's *current* working-tree (or staged) diff as the server reports it —
 * it can move after the run stopped, and it is never presented as the frozen
 * state of the review. The checkpoints below are what the run actually
 * recorded, each with its own head, branch, dirty flag and divergence.
 */
import { useMemo, useState } from "react";
import type { AgentOpsClient, RunDetailResponse } from "../api.js";
import { useResource } from "../hooks.js";
import {
  UNKNOWN,
  formatCount,
  formatTimestamp,
  snapshotView,
} from "../view-model.js";
import { changedFilesView, diffFiles } from "../run-view.js";
import {
  Button,
  Card,
  Checkbox,
  CodeBlock,
  DiffView,
  Disclosure,
  ErrorBox,
  Notice,
  Pill,
} from "./Bits.js";

function CheckpointList({ detail }: { detail: RunDetailResponse }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  if (snapshots.length === 0) {
    return (
      <p className="faint small">
        No git checkpoints were captured for this run.
      </p>
    );
  }

  return (
    <div className="stack--tight checkpoint-list">
      {snapshots.map((snapshot) => {
        const view = snapshotView(snapshot);
        const isSelected = selected?.id === snapshot.id;
        const changed = changedFilesView({ snapshot });
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
                <Pill tone={snapshot.dirty ? "warn" : "success"} dot={false}>
                  {view.dirtyLabel}
                </Pill>
                <span className="faint small">{formatTimestamp(snapshot.capturedAt)}</span>
              </span>
              <span className="faint small mono">
                {view.branch} @ {view.head}
              </span>
              <span className="faint small">
                {changed.label} · staged {formatCount(view.staged)} · unstaged{" "}
                {formatCount(view.unstaged)} · untracked{" "}
                {formatCount(view.untracked)}
              </span>
              <span className="faint small">
                {view.ahead === UNKNOWN || view.behind === UNKNOWN
                  ? `ahead/behind ${UNKNOWN} — this checkpoint recorded no upstream comparison, so no reason can be given for it`
                  : `ahead ${view.ahead} · behind ${view.behind}`}
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
                  </>
                ) : (
                  <p className="faint small">
                    diff stat: UNKNOWN (nothing was recorded for this
                    checkpoint).
                  </p>
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
  );
}

export function ChangesPanel({
  client,
  detail,
}: {
  client: AgentOpsClient;
  detail: RunDetailResponse;
}) {
  const [staged, setStaged] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const projectId = detail.project?.id ?? detail.run.projectId;
  const isGit = detail.project?.vcs === "git";

  const diff = useResource(
    isGit ? () => client.projectDiff(projectId, staged) : null,
    [projectId, staged, isGit],
  );

  const sections = useMemo(() => diffFiles(diff.data?.diff ?? ""), [diff.data]);
  const shown =
    selectedPath === null
      ? sections
      : sections.filter((section) => section.path === selectedPath);
  const totalAdditions = sections.reduce(
    (total, section) => total + section.additions,
    0,
  );
  const totalRemovals = sections.reduce(
    (total, section) => total + section.removals,
    0,
  );

  if (detail.project && !isGit) {
    return (
      <div className="panel">
        <Notice tone="warn">
          This project is registered with <span className="mono">vcs: none</span>
          . No working-tree diff, checkpoint or branch policy is recorded for it.
        </Notice>
        <Card title="Recorded checkpoints">
          <CheckpointList detail={detail} />
        </Card>
      </div>
    );
  }

  return (
    <div className="panel panel--changes">
      <div className="changes__bar">
        <div className="changes__scope">
          <h3>{staged ? "Staged changes" : "Current working tree"}</h3>
          <p className="faint small">
            May differ from the recorded checkpoints below.
          </p>
        </div>
        <div className="changes__tools">
          <Checkbox
            checked={staged}
            onChange={setStaged}
            id="changes-diff-staged"
            label="Use the staged diff (index)"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void diff.reload()}
            disabled={diff.loading}
          >
            {diff.loading ? "Loading…" : "Refresh diff"}
          </Button>
        </div>
      </div>

      <Disclosure summary="How to read this">
        <p className="faint small">
          This is the project's {staged ? "staged (index)" : "working-tree"} diff
          as git reports it right now. It is not the frozen state that was
          reviewed, and it can change after the run stopped. The recorded
          checkpoints below are the run's own snapshot, with the head, branch and
          divergence that were captured at the time.
        </p>
      </Disclosure>

      <ErrorBox error={diff.error} onRetry={() => void diff.reload()} />

      {diff.data === null && diff.loading ? (
        <p className="faint small">Loading the working-tree diff…</p>
      ) : null}

      {diff.data ? (
        sections.length === 0 ? (
          <p className="faint small">
            The working-tree diff is empty. Nothing is currently changed.
          </p>
        ) : (
          <>
            <nav className="changes__nav" aria-label="Changed files">
              <button
                type="button"
                className="changes__file"
                aria-pressed={selectedPath === null}
                onClick={() => setSelectedPath(null)}
              >
                All files ({sections.length})
                <span className="faint small">
                  +{formatCount(totalAdditions)} −{formatCount(totalRemovals)}
                </span>
              </button>
              {sections.map((section) => (
                <button
                  key={section.path === "" ? "all-changes" : section.path}
                  type="button"
                  className="changes__file mono"
                  aria-pressed={selectedPath === section.path}
                  onClick={() => setSelectedPath(section.path)}
                >
                  {section.label}
                  <span className="faint small">
                    +{formatCount(section.additions)} −
                    {formatCount(section.removals)}
                  </span>
                </button>
              ))}
            </nav>

            <div className="changes__body">
              {shown.map((section) => (
                <div
                  key={section.path === "" ? "all-changes" : section.path}
                  className="changes__file-section"
                >
                  <h4 className="mono wrap-anywhere">{section.label}</h4>
                  <p className="faint small">
                    +{formatCount(section.additions)} additions, −
                    {formatCount(section.removals)} deletions
                  </p>
                  <DiffView lines={section.lines} />
                </div>
              ))}
            </div>
          </>
        )
      ) : null}

      <Disclosure
        summary={`Recorded checkpoints (${detail.snapshots.length})`}
        className="changes__checkpoints"
      >
        <CheckpointList detail={detail} />
      </Disclosure>
    </div>
  );
}
