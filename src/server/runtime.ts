import {
  Engine,
  type VerificationExecutor,
  type VerificationCommandOutcome,
  type SnapshotProvider,
} from "../core/engine.js";
import type { Store } from "../db/store.js";
import { createMockAdapter } from "../adapters/agents/mock.js";
import { CliAdapter } from "../adapters/agents/cli.js";
import { ManagedProcess } from "../adapters/shell/process.js";
import { parseTestSummary } from "../adapters/tests/index.js";
import {
  snapshot,
  validateRoot,
  containedPath,
} from "../adapters/git/index.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ADAPTERS } from "./services.js";

export function createRuntime(store: Store): Engine {
  const verification: VerificationExecutor = {
    kind: "local-process",
    async run(input, signal) {
      if (!input.commands.length)
        return {
          status: "unavailable",
          summary:
            "No verification command configured. Configure a test or build command before starting a new run.",
          reason: "no-command",
          mode: "local-process",
        };
      const outcomes: VerificationCommandOutcome[] = [];
      for (const spec of input.commands) {
        if (signal.aborted)
          return {
            status: "failed",
            summary: "Verification cancelled",
            commands: outcomes,
            mode: "local-process",
          };
        const cwd = await validateRoot(input.project.canonicalRoot);
        if (spec.cwd && (await validateRoot(spec.cwd)) !== cwd)
          throw new Error(
            "Verification working directory must be the registered project root",
          );
        const context = {
          projectId: input.run.projectId,
          runId: input.run.id,
          taskId: input.attempt.taskId,
          attemptId: input.attempt.id,
          stageKey: input.stage.key,
          category: "verification" as const,
          actor: "verifier" as const,
        };
        store.appendEvent({
          ...context,
          type: "COMMAND_STARTED",
          payload: {
            name: spec.name,
            executable: spec.executable,
            args: spec.args,
            cwd,
          },
        });
        const child = new ManagedProcess({
          ...spec,
          cwd,
          timeoutMs: spec.timeoutMs ?? 300000,
          onOutput: (stream, text) =>
            store.appendEvent({
              ...context,
              type: "COMMAND_OUTPUT",
              payload: { stream, text },
            }),
        });
        child.closeInput();
        const abort = () => {
          void child.cancel();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const result = await child.result;
        signal.removeEventListener("abort", abort);
        const parsed = parseTestSummary(result.stdout + "\n" + result.stderr);
        const status = result.status === "completed" ? "passed" : "failed";
        const counts =
          parsed.passed !== null &&
          parsed.failed !== null &&
          parsed.total !== null
            ? {
                passed: parsed.passed,
                failed: parsed.failed,
                skipped: parsed.skipped ?? 0,
                total: parsed.total,
              }
            : null;
        const summary = counts
          ? `${counts.passed} passed, ${counts.failed} failed`
          : `Exit ${result.exitCode ?? "unknown"} (${result.status}); test count UNKNOWN`;
        outcomes.push({
          spec: { ...spec, cwd },
          status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdoutExcerpt: result.stdout,
          stderrExcerpt: result.stderr,
          truncated: result.truncated,
          framework: parsed.source,
          counts,
          parsedConfidently: counts !== null,
          summary,
        });
        store.appendEvent({
          ...context,
          type: "COMMAND_COMPLETED",
          payload: {
            name: spec.name,
            status,
            exitCode: result.exitCode,
            summary,
            durationMs: result.durationMs,
          },
        });
        if (status === "failed")
          return {
            status: "failed",
            summary: `${spec.name}: ${summary}`,
            reason: result.error ?? result.status,
            commands: outcomes,
            mode: "local-process",
          };
      }
      return {
        status: "passed",
        summary: outcomes.map((o) => `${o.spec.name}: ${o.summary}`).join("; "),
        commands: outcomes,
        mode: "local-process",
      };
    },
  };
  const snapshots: SnapshotProvider = {
    kind: "git",
    async capture(input) {
      const project = store.getProject(input.run.projectId);
      if (project?.vcs !== "git") return null;
      const previous = store.listGitSnapshots(input.run.id).at(-1);
      const s = await snapshot(
        input.run.projectRoot,
        previous?.headSha ?? undefined,
      );
      return {
        headSha: s.head || null,
        branch: s.branch,
        detached: s.branch === "(detached)",
        dirty: s.dirty,
        staged: s.staged,
        unstaged: s.changed,
        untracked: s.untracked,
        diffStat: `+${s.insertions} / −${s.deletions}`,
        localCommits: s.commits.map((c) => {
          const [sha, ...rest] = c.split(" ");
          return { sha: sha!, subject: rest.join(" ") };
        }),
        ahead: s.ahead,
        behind: s.behind,
        capturedAt: s.timestamp,
      };
    },
  };
  return new Engine({
    store,
    verification,
    snapshots,
    outputEventLimit: 2000,
    resolveAdapter: (agent) => {
      if (!ADAPTERS.includes(agent.adapterKind)) return undefined;
      const adapter =
        agent.adapterKind === "mock"
          ? createMockAdapter(agent, { overrides: { usage: null } })
          : new CliAdapter(agent.adapterKind);
      return {
        kind: adapter.kind,
        async startTask(packet, config) {
          const root = await validateRoot(packet.projectRoot);
          const session = await adapter.startTask(packet, {
            ...config,
            timeoutMs:
              typeof config.config["timeoutMs"] === "number"
                ? config.config["timeoutMs"]
                : 600000,
          });
          return {
            id: session.id,
            sendInput: (text) => session.sendInput(text),
            cancel: (reason) => session.cancel(reason),
            getStatus: () => session.getStatus(),
            streamEvents: () => session.streamEvents(),
            collectResult: async () => {
              const result = await session.collectResult();
              try {
                for (const artifact of result.artifacts ?? []) {
                  const full = await containedPath(root, artifact.path);
                  if (!(await stat(full)).isFile())
                    throw new Error("Artifact is not a file");
                  artifact.path = path.relative(root, full);
                }
              } catch (error) {
                return {
                  status: "failed" as const,
                  summary: "Agent artifact validation failed",
                  exitCode: result.exitCode,
                  error: String(error),
                  usage: result.usage,
                };
              }
              return result;
            },
          };
        },
      };
    },
  });
}
