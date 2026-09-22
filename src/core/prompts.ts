/**
 * Prompt packet construction. The packet is the complete, auditable handoff:
 * everything an agent needs, persisted verbatim per attempt.
 */
import { redactSecrets, redactValue } from "./redaction.js";
import type {
  AgentArtifactRef,
  AgentRecord,
  AgentTaskPacket,
  GitCheckpointSummary,
  PriorAttemptSummary,
  PriorStageSummary,
  ProjectRecord,
  PromptPacket,
  ReviewVerdict,
  RunRecord,
  StageRecord,
  VerificationSummary,
} from "./types.js";

export const STOPPING_RULE = [
  "Stop when the stage objective is satisfied and its evidence is captured.",
  "If you are blocked, stop and report the blocker instead of guessing.",
  "Never continue past a failed verification, and never report success you did not observe.",
  "Report exactly what you changed, what you verified, and what remains unknown.",
].join(" ");

export const REVIEW_RESPONSE_CONTRACT = [
  "Reply with a JSON object (and nothing else after it) of the form:",
  '{ "verdict": "APPROVE" | "APPROVE_WITH_FIXES" | "REJECT",',
  '  "summary": "<one paragraph>",',
  '  "issues": [ { "severity": "blocking|major|minor|nit", "description": "...", "path": "optional/relative/path", "line": 0 } ],',
  '  "confidence": 0.0 }',
  "An exit code of zero is not a verdict. Only this object is accepted.",
].join("\n");

export interface PromptBuildInput {
  run: RunRecord;
  project: ProjectRecord;
  stage: StageRecord;
  agent: AgentRecord;
  attemptNumber: number;
  attemptReason: string | null;
  priorAttempts: PriorAttemptSummary[];
  priorStageResults: PriorStageSummary[];
  latestCheckpoint: GitCheckpointSummary | null;
  verification: VerificationSummary[];
  artifacts: AgentArtifactRef[];
  review: {
    cycle: number;
    maxCycles: number;
    priorVerdicts: ReviewVerdict[];
  } | null;
  humanInstruction: string | null;
  operatorInputs: string[];
}

export function buildPromptPacket(input: PromptBuildInput): AgentTaskPacket {
  const packet: PromptPacket = redactValue({
    packetVersion: 1,
    runId: input.run.id,
    projectId: input.project.id,
    projectName: input.project.name,
    projectRoot: input.project.canonicalRoot,
    goal: input.run.goal,
    constraints: [...input.run.constraints],
    stageKey: input.stage.key,
    stageName: input.stage.name,
    stageKind: input.stage.kind,
    stageInstructions: input.stage.instructions,
    role: input.stage.role,
    agentId: input.agent.id,
    adapterKind: input.agent.adapterKind,
    attemptNumber: input.attemptNumber,
    attemptReason: input.attemptReason,
    templateId: input.run.templateId,
    stoppingRule: STOPPING_RULE,
    priorAttempts: input.priorAttempts,
    priorStageResults: input.priorStageResults,
    latestCheckpoint: input.latestCheckpoint,
    verification: input.verification,
    artifacts: input.artifacts,
    review: input.review,
    humanInstruction: input.humanInstruction,
    operatorInputs: input.operatorInputs,
  });
  return { ...packet, promptText: renderPromptText(packet) };
}

/**
 * Deterministic rendering of a packet. The result is redacted before it is
 * returned so exact-prompt storage never contains credential-shaped content.
 */
export function renderPromptText(packet: PromptPacket): string {
  const lines: string[] = [];
  const push = (...text: string[]): void => {
    lines.push(...text);
  };

  push(`# AgentOps task: ${packet.stageName} (${packet.stageKey})`, "");
  push(`Run: ${packet.runId}  Template: ${packet.templateId}`);
  push(`Project: ${packet.projectName}`);
  push(`Repository root: ${packet.projectRoot}`);
  push(
    `Stage kind: ${packet.stageKind}  Role: ${packet.role}  Attempt: ${packet.attemptNumber}`,
  );
  if (packet.attemptReason) push(`Attempt reason: ${packet.attemptReason}`);
  push("");

  push("## Goal", packet.goal, "");

  if (packet.constraints.length > 0) {
    push("## Constraints");
    for (const item of packet.constraints) push(`- ${item}`);
    push("");
  }

  push("## Stage instructions", packet.stageInstructions, "");

  if (packet.humanInstruction) {
    push("## Operator instruction", packet.humanInstruction, "");
  }

  if (packet.operatorInputs.length > 0) {
    push("## Operator input");
    packet.operatorInputs.forEach((value, index) =>
      push(`${index + 1}. ${value}`),
    );
    push("");
  }

  if (packet.priorStageResults.length > 0) {
    push("## Prior stage results");
    for (const stage of packet.priorStageResults) {
      const outcome =
        stage.status === "COMPLETED" ? "completed" : `status=${stage.status}`;
      push(
        `- ${stage.stageKey} (${stage.name}): ${outcome}${stage.summary ? ` — ${stage.summary}` : ""}`,
      );
      if (stage.failureReason) push(`  failure: ${stage.failureReason}`);
    }
    push("");
  }

  if (packet.priorAttempts.length > 0) {
    push("## Prior attempts on this stage");
    for (const attempt of packet.priorAttempts) {
      push(
        `- attempt ${attempt.attemptNumber}: ${attempt.status}${attempt.summary ? ` — ${attempt.summary}` : ""}`,
      );
      if (attempt.reviewVerdict)
        push(`  review verdict: ${attempt.reviewVerdict}`);
      if (attempt.error) push(`  error: ${attempt.error}`);
    }
    push("");
  }

  if (packet.review) {
    push("## Review context");
    push(`Cycle ${packet.review.cycle} of at most ${packet.review.maxCycles}.`);
    if (packet.review.priorVerdicts.length === 0) {
      push("No prior verdicts on this stage.");
    } else {
      for (const verdict of packet.review.priorVerdicts) {
        push(`- ${verdict.verdict}: ${verdict.summary}`);
        for (const issue of verdict.issues) {
          push(
            `  [${issue.severity}] ${issue.description}${issue.path ? ` (${issue.path}${issue.line ? `:${issue.line}` : ""})` : ""}`,
          );
        }
      }
    }
    push("");
  }

  if (packet.verification.length > 0) {
    push("## Verification results");
    for (const verification of packet.verification) {
      push(
        `- ${verification.stageKey}: ${verification.status} — ${verification.summary}`,
      );
    }
    push("");
  }

  if (packet.artifacts.length > 0) {
    push("## Known artifacts");
    for (const artifact of packet.artifacts) {
      push(
        `- ${artifact.path} (${artifact.kind})${artifact.note ? `: ${artifact.note}` : ""}`,
      );
    }
    push("");
  }

  push("## Latest git checkpoint");
  if (packet.latestCheckpoint) {
    const checkpoint = packet.latestCheckpoint;
    push(
      `HEAD: ${checkpoint.headSha ?? "unknown"}  Branch: ${checkpoint.branch ?? "unknown"}${checkpoint.detached ? " (detached)" : ""}`,
    );
    push(
      `Dirty: ${checkpoint.dirty ? "yes" : "no"}  Ahead: ${checkpoint.ahead ?? "unknown"}  Behind: ${checkpoint.behind ?? "unknown"}`,
    );
    if (checkpoint.localCommits.length > 0) {
      push("Local commits:");
      for (const commit of checkpoint.localCommits)
        push(`- ${commit.sha} ${commit.subject}`);
    }
    if (checkpoint.diffStat) push(`Diff stat: ${checkpoint.diffStat}`);
  } else {
    push("No checkpoint is available.");
  }
  push("");

  push("## Stopping rule", packet.stoppingRule, "");

  if (packet.stageKind === "review") {
    push("## Response contract (review)", REVIEW_RESPONSE_CONTRACT, "");
  } else {
    push(
      "## Response contract",
      "Finish with a concise summary: what you changed, the evidence you observed, and anything unknown.",
      "",
    );
  }

  return redactSecrets(lines.join("\n"));
}

/** Best-effort extraction of a structured review object from raw agent text. */
export function extractReviewPayload(rawText: string): unknown {
  if (!rawText) return undefined;
  const candidates: string[] = [];
  const fences = rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const fence of fences) {
    if (fence[1]) candidates.push(fence[1].trim());
  }
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(rawText.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}
