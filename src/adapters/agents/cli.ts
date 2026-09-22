import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentEvent,
  AgentResult,
  AgentSession,
  AgentSessionStatus,
  AgentTaskConfig,
  AgentTaskPacket,
} from "../../core/types.js";
import {
  ManagedProcess,
  redact,
  validateCommand,
  type ProcessOptions,
} from "../shell/process.js";
import { extractReviewPayload } from "../../core/prompts.js";

class EventQueue {
  private values: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private dropped = 0;
  private consumed = false;
  push(event: AgentEvent) {
    if (this.values.length < 2048) this.values.push(event);
    else this.dropped++;
    this.wake?.();
    this.wake = undefined;
  }
  end() {
    this.done = true;
    this.wake?.();
  }
  async *stream(): AsyncIterable<AgentEvent> {
    if (this.consumed)
      throw new Error("An agent event stream supports one consumer");
    this.consumed = true;
    while (!this.done || this.values.length) {
      const event = this.values.shift();
      if (event) yield event;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
    if (this.dropped)
      yield {
        type: "AGENT_OUTPUT",
        at: new Date().toISOString(),
        stream: "system",
        message: `[event stream truncated: ${this.dropped} events omitted]`,
      };
  }
}
export function parseStructuredResult(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}
export function buildInvocation(
  kind: string,
  packet: AgentTaskPacket,
  config: AgentTaskConfig,
): ProcessOptions {
  const c = config.config;
  const executable =
    typeof c["executable"] === "string"
      ? c["executable"]
      : {
          codex: "codex",
          "claude-code": "claude",
          "hermes-opencode": "hermes",
        }[kind];
  if (!executable)
    throw new Error("Configure an executable for the generic CLI adapter");
  const extra = c["args"] === undefined ? [] : c["args"];
  if (!Array.isArray(extra) || extra.some((x) => typeof x !== "string"))
    throw new Error("Agent args must be strings");
  let args: string[],
    input: string | undefined = packet.promptText;
  if (kind === "codex")
    args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      packet.role === "reviewer" || packet.role === "planner"
        ? "read-only"
        : "workspace-write",
      "-C",
      packet.projectRoot,
      ...(config.model ? ["--model", config.model] : []),
      ...(config.effort
        ? ["-c", `model_reasoning_effort=${JSON.stringify(config.effort)}`]
        : []),
      ...extra,
      "-",
    ];
  else if (kind === "claude-code")
    args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      packet.role === "reviewer" || packet.role === "planner"
        ? "dontAsk"
        : "acceptEdits",
      ...(packet.role === "reviewer" || packet.role === "planner"
        ? ["--tools", "Read,Glob,Grep"]
        : []),
      ...(config.model ? ["--model", config.model] : []),
      ...(config.effort ? ["--effort", config.effort] : []),
      ...extra,
    ];
  else if (kind === "hermes-opencode") {
    // Hermes one-shot takes its prompt as one argument and auto-bypasses its CLI approvals.
    if (c["allowHermesOneshot"] !== true)
      throw new Error(
        "Hermes one-shot auto-bypasses CLI approvals. Enable allowHermesOneshot explicitly or use manual mode.",
      );
    args = [
      "--in",
      packet.projectRoot,
      ...(typeof c["provider"] === "string"
        ? ["--provider", c["provider"]]
        : []),
      ...(config.model ? ["--model", config.model] : []),
      ...(config.effort ? ["--reasoning", config.effort] : []),
      ...extra,
      "-z",
      packet.promptText,
    ];
    input = undefined;
  } else args = [...extra];
  validateCommand({ executable, args });
  return {
    executable,
    args,
    cwd: packet.projectRoot,
    input,
    timeoutMs: config.timeoutMs ?? 600000,
  };
}

export class CliAdapter implements AgentAdapter {
  readonly kind: string;
  constructor(kind = "generic-cli") {
    this.kind = kind;
  }
  async startTask(
    packet: AgentTaskPacket,
    config: AgentTaskConfig,
  ): Promise<AgentSession> {
    if (config.config["manual"] === true) return new ManualSession(packet);
    const invocation = buildInvocation(this.kind, packet, config);
    const queue = new EventQueue();
    let status: AgentSessionStatus = "running";
    let finalText = "";
    let usage: AgentResult["usage"] = null;
    let adapterError: string | null = null;
    const event = (
      type: AgentEvent["type"],
      message?: string,
      data?: Record<string, unknown>,
      stream?: AgentEvent["stream"],
    ) =>
      queue.push({ type, at: new Date().toISOString(), message, data, stream });
    const safeArgs = invocation.args.map((arg) =>
      arg === packet.promptText ? "[persisted prompt packet]" : redact(arg),
    );
    event("AGENT_STARTED", "Process starting", {
      executable: invocation.executable,
      args: safeArgs,
      cwd: invocation.cwd,
      transport: "pipes",
    });
    const processHandle = new ManagedProcess({
      ...invocation,
      onOutput: (stream, text) => {
        event("AGENT_OUTPUT", text, undefined, stream);
        if (stream !== "stdout") return;
        for (const line of text.split("\n")) {
          try {
            const raw = JSON.parse(line);
            if (this.kind === "codex") {
              if (
                raw.type === "item.completed" &&
                raw.item?.type === "agent_message"
              )
                finalText = String(raw.item.text ?? "");
              if (
                raw.type === "item.started" &&
                raw.item?.type === "command_execution"
              )
                event("AGENT_TOOL_CALL", String(raw.item.command ?? ""));
              if (raw.type === "turn.completed" && raw.usage) {
                usage = {
                  inputTokens:
                    typeof raw.usage.input_tokens === "number"
                      ? raw.usage.input_tokens
                      : null,
                  outputTokens:
                    typeof raw.usage.output_tokens === "number"
                      ? raw.usage.output_tokens
                      : null,
                  totalTokens: null,
                };
              }
              if (raw.type === "turn.failed")
                adapterError = String(
                  raw.error?.message ?? "Codex turn failed",
                );
            } else if (this.kind === "claude-code") {
              if (raw.type === "result") {
                finalText = String(raw.result ?? "");
                if (raw.is_error || (raw.subtype && raw.subtype !== "success"))
                  adapterError = finalText || String(raw.subtype);
                if (raw.usage)
                  usage = {
                    inputTokens:
                      typeof raw.usage.input_tokens === "number"
                        ? raw.usage.input_tokens
                        : null,
                    outputTokens:
                      typeof raw.usage.output_tokens === "number"
                        ? raw.usage.output_tokens
                        : null,
                    totalTokens: null,
                    costUsd:
                      typeof raw.total_cost_usd === "number"
                        ? raw.total_cost_usd
                        : null,
                  };
              }
              if (raw.type === "assistant")
                for (const part of raw.message?.content ?? [])
                  if (part.type === "tool_use")
                    event("AGENT_TOOL_CALL", part.name, { input: part.input });
            }
          } catch {
            /* Unstructured output remains available verbatim after redaction. */
          }
        }
      },
    });
    if (invocation.input === undefined) processHandle.closeInput();
    const completed = processHandle.result.then((r): AgentResult => {
      const output = finalText || r.stdout;
      const structured = parseStructuredResult(output);
      status =
        r.status === "cancelled"
          ? "cancelled"
          : r.status === "completed" &&
              !adapterError &&
              structured?.["status"] !== "failed"
            ? "completed"
            : "failed";
      const result: AgentResult = {
        status,
        summary:
          redact(
            String(
              structured?.["summary"] ?? output.trim().slice(-16000) ?? "",
            ),
          ) ||
          r.error ||
          `Process ${r.status}`,
        exitCode: r.exitCode,
        usage,
        error:
          adapterError ??
          r.error ??
          (r.status === "timed_out" ? "Process timed out" : null),
        metadata: {
          durationMs: r.durationMs,
          stdout: r.stdout,
          stderr: r.stderr,
          truncated: r.truncated,
          command: {
            executable: invocation.executable,
            args: safeArgs,
            cwd: invocation.cwd,
          },
        },
      };
      if (packet.stageKind === "review") {
        const review = extractReviewPayload(output) as
          | Record<string, unknown>
          | undefined;
        result.review = structured?.["review"] ?? review ?? null;
      }
      if (Array.isArray(structured?.["artifacts"]))
        result.artifacts = structured["artifacts"].filter(
          (a: unknown): a is { path: string; kind: string } =>
            !!a &&
            typeof a === "object" &&
            typeof (a as Record<string, unknown>)["path"] === "string" &&
            typeof (a as Record<string, unknown>)["kind"] === "string",
        );
      event(
        status === "completed"
          ? "AGENT_COMPLETED"
          : status === "cancelled"
            ? "AGENT_CANCELLED"
            : "AGENT_FAILED",
        result.summary,
      );
      queue.end();
      return result;
    });
    return {
      id: randomUUID(),
      sendInput: async (text) => {
        processHandle.sendInput(text + "\n");
      },
      cancel: async () => {
        await processHandle.cancel();
      },
      getStatus: () => status,
      streamEvents: () => queue.stream(),
      collectResult: () => completed,
    };
  }
}

export class ManualSession implements AgentSession {
  readonly id = randomUUID();
  private status: AgentSessionStatus = "waiting_input";
  private queue = new EventQueue();
  private waitReported = false;
  private resolve!: (result: AgentResult) => void;
  private result = new Promise<AgentResult>((resolve) => {
    this.resolve = resolve;
  });
  private packet: AgentTaskPacket;
  constructor(packet: AgentTaskPacket) {
    this.packet = packet;
    this.queue.push({
      type: "AGENT_WAITING",
      at: new Date().toISOString(),
      message:
        "Manual handoff: copy the saved prompt into your agent, then submit its final result here. No process has been launched.",
    });
  }
  async sendInput(text: string) {
    if (this.status !== "waiting_input")
      throw new Error("Manual session is closed");
    const raw = parseStructuredResult(text);
    if (this.packet.stageKind === "review" && !raw)
      throw new Error("Reviewer input must be a JSON verdict object");
    const suppliedStatus = raw?.["status"];
    if (
      suppliedStatus !== undefined &&
      !["completed", "failed", "cancelled"].includes(String(suppliedStatus))
    )
      throw new Error(
        "Manual result status must be completed, failed or cancelled",
      );
    this.status =
      suppliedStatus === "failed"
        ? "failed"
        : suppliedStatus === "cancelled"
          ? "cancelled"
          : "completed";
    this.resolve({
      status: this.status,
      summary: String(raw?.["summary"] ?? text),
      error:
        this.status === "failed"
          ? String(raw?.["error"] ?? raw?.["summary"] ?? "Manual task failed")
          : null,
      exitCode: null,
      ...(this.packet.stageKind === "review" ? { review: raw } : {}),
      usage: null,
      metadata: { manual: true },
    });
    this.queue.push({
      type:
        this.status === "failed"
          ? "AGENT_FAILED"
          : this.status === "cancelled"
            ? "AGENT_CANCELLED"
            : "AGENT_COMPLETED",
      at: new Date().toISOString(),
      message: "Operator supplied manual result",
    });
    this.queue.end();
  }
  async cancel(reason: string) {
    if (this.status !== "waiting_input") return;
    this.status = "cancelled";
    this.resolve({
      status: "cancelled",
      summary: reason,
      exitCode: null,
      usage: null,
    });
    this.queue.end();
  }
  getStatus() {
    return this.status;
  }
  streamEvents() {
    return this.queue.stream();
  }
  collectResult() {
    if (this.status === "waiting_input" && !this.waitReported) {
      this.waitReported = true;
      return Promise.resolve<AgentResult>({
        status: "waiting_input",
        summary: "Manual handoff: paste the agent result to continue",
        exitCode: null,
        usage: null,
      });
    }
    return this.result;
  }
}
