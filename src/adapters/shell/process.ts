import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export { redactSecrets as redact } from "../../core/redaction.js";
import { redactSecrets as redact } from "../../core/redaction.js";

export interface CommandSpec {
  executable: string;
  args: string[];
}
export interface ProcessOptions extends CommandSpec {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}
export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  truncated: boolean;
}

export function validateCommand(value: unknown): CommandSpec {
  const c = value as CommandSpec;
  if (
    !c ||
    typeof c.executable !== "string" ||
    !c.executable.trim() ||
    c.executable.length > 4096 ||
    /[\0\r\n]/.test(c.executable) ||
    !Array.isArray(c.args) ||
    c.args.length > 256 ||
    c.args.some(
      (a) => typeof a !== "string" || a.length > 65536 || a.includes("\0"),
    )
  )
    throw new Error("Expected executable and argument array");
  // Shell scripts require a separately reviewed adapter. Never interpret a pasted command as shell syntax.
  const base = c.executable.split(/[\\/]/).at(-1)!.toLowerCase();
  if (
    [
      "sh",
      "bash",
      "zsh",
      "fish",
      "dash",
      "cmd",
      "cmd.exe",
      "powershell",
      "pwsh",
    ].includes(base)
  )
    throw new Error(
      "Shell interpreters are not supported; use executable and argument arrays",
    );
  return { executable: c.executable, args: [...c.args] };
}

/** Only this object's freshly spawned child group is ever signalled. No persisted PID is accepted. */
export class ManagedProcess extends EventEmitter {
  readonly result: Promise<ProcessResult>;
  private child?: ChildProcess;
  private settled = false;
  private stopping?: "cancelled" | "timed_out";
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private reported?: {
    exitCode: number | null;
    signal: string | null;
    error?: string;
  };
  private finish!: (
    code: number | null,
    signal: string | null,
    error?: string,
  ) => void;
  readonly options: ProcessOptions;
  constructor(options: ProcessOptions) {
    super();
    this.options = options;
    const started = Date.now(),
      startedAt = new Date(started).toISOString();
    let stdout = "",
      stderr = "",
      bytes = 0,
      truncated = false;
    const privateKeyBlock = { stdout: false, stderr: false };
    const max = Math.min(
      Math.max(options.maxOutputBytes ?? 1024 * 1024, 1024),
      8 * 1024 * 1024,
    );
    const emit = (stream: "stdout" | "stderr", raw: string) => {
      if (bytes >= max) {
        truncated = true;
        return;
      }
      const filtered = raw
        .split(/(?<=\n)/)
        .map((line) => {
          if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
            privateKeyBlock[stream] = true;
            return "[REDACTED PRIVATE KEY]\n";
          }
          if (privateKeyBlock[stream]) {
            if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line))
              privateKeyBlock[stream] = false;
            return "";
          }
          return line;
        })
        .join("");
      const safe = redact(filtered);
      const limited = Buffer.from(safe)
        .subarray(0, max - bytes)
        .toString("utf8");
      bytes += Buffer.byteLength(limited);
      if (limited !== safe) truncated = true;
      if (stream === "stdout") stdout += limited;
      else stderr += limited;
      options.onOutput?.(stream, limited);
      this.emit("output", { stream, text: limited });
    };
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const pending = { stdout: "", stderr: "" };
    const receive = (stream: "stdout" | "stderr", chunk: Buffer) => {
      pending[stream] += decoders[stream].write(chunk);
      const last = pending[stream].lastIndexOf("\n");
      if (last >= 0) {
        emit(stream, pending[stream].slice(0, last + 1));
        pending[stream] = pending[stream].slice(last + 1);
      }
      // Never persist a token fragment from an unbounded, unterminated line.
      if (pending[stream].length > 65536) {
        pending[stream] = "";
        emit(stream, "[overlong output line omitted]\n");
        truncated = true;
      }
    };
    this.result = new Promise((resolve) => {
      this.finish = (exitCode, signal, error) => {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(this.timer);
        clearTimeout(this.deadline);
        for (const stream of ["stdout", "stderr"] as const)
          emit(stream, pending[stream] + decoders[stream].end());
        if (truncated) {
          const marker = "\n[output truncated]\n";
          stderr += marker;
          options.onOutput?.("stderr", marker);
        }
        const result: ProcessResult = {
          exitCode,
          signal,
          stdout,
          stderr,
          status:
            this.stopping ??
            (exitCode === 0 && !error ? "completed" : "failed"),
          ...(error ? { error: redact(error) } : {}),
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          truncated,
        };
        resolve(result);
        this.emit("finished", result);
      };
    });
    try {
      const spec = validateCommand(options);
      if (process.platform === "win32")
        throw new Error(
          "POSIX process supervision is required in this release",
        );
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      // Node's test harness uses this private variable to switch output into a
      // binary child protocol. A user verification command must be independent.
      delete (env as NodeJS.ProcessEnv)["NODE_TEST_CONTEXT"];
      this.child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./supervisor.cjs", import.meta.url))],
        {
          cwd: options.cwd,
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env,
        },
      );
      this.child.stdout!.on("data", (chunk) => receive("stdout", chunk));
      this.child.stderr!.on("data", (chunk) => receive("stderr", chunk));
      this.child.stdin!.on("error", () => {});
      this.child.on("error", (error) => this.finish(null, null, error.message));
      this.child.on("message", (message: unknown) => {
        const m = message as {
          type?: string;
          exitCode: number | null;
          signal: string | null;
          error?: string;
        };
        if (m.type === "result") this.reported = m;
      });
      this.child.on("close", () => {
        const r = this.reported;
        this.finish(
          r?.exitCode ?? null,
          r?.signal ?? (this.stopping ? "SIGKILL" : null),
          r?.error ??
            (!r && !this.stopping
              ? "Process supervisor exited unexpectedly"
              : undefined),
        );
      });
      this.child.send(
        {
          type: "start",
          executable: spec.executable,
          args: spec.args,
          cwd: options.cwd,
        },
        (error) => {
          if (error) this.finish(null, null, error.message);
        },
      );
      this.timer = setTimeout(
        () => this.stop("timed_out"),
        Math.min(Math.max(options.timeoutMs ?? 600000, 10), 86400000),
      );
      if (options.input !== undefined) this.child.stdin!.end(options.input);
    } catch (error) {
      this.finish(null, null, String(error));
    }
  }
  sendInput(text: string) {
    if (this.settled || this.stopping || !this.child?.stdin?.writable)
      throw new Error("Process is not accepting input");
    this.child.stdin.write(text);
  }
  closeInput() {
    this.child?.stdin?.end();
  }
  cancel() {
    this.stop("cancelled");
    return this.result;
  }
  private stop(reason: "cancelled" | "timed_out") {
    if (this.settled || this.stopping) return;
    this.stopping = reason;
    const grace = Math.min(Math.max(this.options.killGraceMs ?? 750, 10), 5000);
    if (this.child?.connected)
      this.child.send({ type: "stop", grace }, () => {});
    this.deadline = setTimeout(() => {
      // Only the still-live ChildProcess handle may be killed. Group cleanup
      // belongs to the leader itself, avoiding recycled numeric group IDs.
      if (this.child?.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGKILL");
      this.child?.stdout?.destroy();
      this.child?.stderr?.destroy();
      this.finish(null, "SIGKILL", "Process cleanup deadline reached");
    }, grace + 1500);
  }
}

export async function execute(options: ProcessOptions) {
  const p = new ManagedProcess(options);
  if (options.input === undefined) p.closeInput();
  return p.result;
}
