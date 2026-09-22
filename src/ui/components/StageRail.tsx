/**
 * Center-stage rail: the frozen plan order plus the branched review -> fix ->
 * re-verification line. The branch is rendered attached to its review stage, so
 * a cycle is visible as a cycle instead of a fake linear list.
 */
import {
  classNames,
  fixLoopCycleLabel,
  statusLabel,
  type RailLoop,
  type RailNode,
  type StageRail as RailModel,
  type Tone,
} from "../view-model.js";
import { Pill } from "./Bits.js";

function toneOf(status: string): Tone {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "RUNNING":
      return "active";
    case "FAILED":
    case "CANCELLED":
    case "INTERRUPTED":
      return "danger";
    case "WAITING_APPROVAL":
    case "WAITING_INPUT":
    case "SKIPPED":
      return "warn";
    default:
      return "neutral";
  }
}

function glyphOf(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "RUNNING":
      return "▶";
    case "FAILED":
    case "CANCELLED":
      return "✕";
    case "WAITING_APPROVAL":
    case "WAITING_INPUT":
      return "!";
    case "INTERRUPTED":
      return "~";
    case "SKIPPED":
      return "–";
    default:
      return "";
  }
}

function RailNodeButton({
  node,
  selected,
  onSelect,
}: {
  node: RailNode;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const tone = toneOf(node.status);
  return (
    <div className="rail__node">
      <span
        className={classNames("rail__marker", `rail__marker--${tone}`)}
        aria-hidden="true"
      >
        {glyphOf(node.status)}
      </span>
      <button
        type="button"
        className="rail__button"
        aria-label={`${node.name} ${node.kind} ${node.role} ${node.agentName ?? ""} ${statusLabel(node.status)}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(node.key)}
      >
        <span className="rail__name">
          {node.name}
          {node.overridden ? (
            <>
              {" "}
              <Pill
                tone="warn"
                dot={false}
                title="A human override was recorded for this stage"
              >
                overridden
              </Pill>
            </>
          ) : null}
        </span>
        <span className="rail__sub">
          <span>
            {node.agentName ??
              (node.kind === "verify"
                ? "Verification"
                : node.role === "human"
                  ? "You"
                  : node.role)}
          </span>
          {node.attemptCount > 1 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {node.attemptCount} attempt{node.attemptCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
          {node.cycle > 1 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {node.loopPhase
                  ? `fixes from review cycle ${node.cycle}`
                  : `review cycle ${node.cycle}`}
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{statusLabel(node.status)}</span>
        </span>
        {node.failureReason ? (
          <span className="field__error">{node.failureReason}</span>
        ) : null}
        {node.skippedReason ? (
          <span className="faint small">skipped: {node.skippedReason}</span>
        ) : null}
      </button>
    </div>
  );
}

function RailLoopBranch({
  loop,
  selectedKey,
  onSelect,
}: {
  loop: RailLoop;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <details
      className="rail__loop"
      open={
        loop.activated || loop.nodes.some((node) => node.key === selectedKey)
      }
    >
      <summary className="rail__loophead">
        ↺ {fixLoopCycleLabel(loop.cycle, loop.maxReviewCycles)}{" "}
        {loop.activated ? "· active" : "· dormant"}
      </summary>
      {loop.nodes.map((node) => (
        <RailNodeButton
          key={node.key}
          node={node}
          selected={node.key === selectedKey}
          onSelect={onSelect}
        />
      ))}
      <p className="faint small" style={{ margin: "0 0 6px 4px" }}>
        {loop.activated
          ? "This branch ran: a verdict asked for fixes, then re-verification."
          : "Dormant: only a review verdict of APPROVE_WITH_FIXES activates this branch."}
      </p>
    </details>
  );
}

export function StageRail({
  rail,
  selectedKey,
  onSelect,
  runStatus,
}: {
  rail: RailModel;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  runStatus: string;
}) {
  const percent =
    rail.progress.total === 0
      ? 0
      : Math.round((rail.progress.completed / rail.progress.total) * 100);
  return (
    <div className="card card--tight">
      <div className="card__head">
        <h3>Stage rail</h3>
        <Pill tone={runStatus === "RUNNING" ? "active" : undefined}>
          {runStatus}
        </Pill>
      </div>
      <div className="rail">
        {rail.spine.map((node) => {
          const loop = rail.loops.find(
            (candidate) => candidate.reviewStageKey === node.key,
          );
          return (
            <div key={node.key}>
              <RailNodeButton
                node={node}
                selected={node.key === selectedKey}
                onSelect={onSelect}
              />
              {loop ? (
                <RailLoopBranch
                  loop={loop}
                  selectedKey={selectedKey}
                  onSelect={onSelect}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="rail__progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="faint small" style={{ marginTop: 6 }}>
        {rail.progress.completed}/{rail.progress.total} non-conditional stages
        completed
        {rail.currentKey ? ` · current: ${rail.currentKey}` : ""}
      </p>
    </div>
  );
}
