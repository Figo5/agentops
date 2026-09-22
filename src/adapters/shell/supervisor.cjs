// Keeps the process-group leader alive through descendant cleanup. Only the
// leader signals its own current group; the service never signals a saved PID.
const { spawn } = require("node:child_process");
let target,
  stopping = false,
  started = false,
  resultSent = false;
process.on("SIGTERM", () => {});
function killGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}
function report(result) {
  if (resultSent) return;
  resultSent = true;
  // Flush forwarded output before delivering the final status and ending the group.
  process.stdout.write("", () =>
    process.stderr.write("", () => {
      if (process.connected)
        process.send({ type: "result", ...result }, () => {
          if (!stopping) killGroup();
        });
      else if (!stopping) killGroup();
    }),
  );
}
function stop(grace = 750) {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  setTimeout(killGroup, Math.min(Math.max(grace, 10), 5000));
}
process.on("disconnect", () => stop(100));
process.on("message", (message) => {
  if (message.type === "stop") {
    stop(message.grace);
    return;
  }
  if (message.type !== "start" || started || stopping) return;
  started = true;
  try {
    target = spawn(message.executable, message.args, {
      cwd: message.cwd,
      shell: false,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    process.stdin.pipe(target.stdin);
    target.stdin.on("error", () => {});
    target.stdout.pipe(process.stdout, { end: false });
    target.stderr.pipe(process.stderr, { end: false });
    target.on("error", (error) =>
      report({ exitCode: null, signal: null, error: error.message }),
    );
    target.on("close", (exitCode, signal) => report({ exitCode, signal }));
  } catch (error) {
    report({ exitCode: null, signal: null, error: String(error) });
  }
});
