import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManagedProcess,
  execute,
  redact,
  validateCommand,
} from "../src/adapters/shell/process.js";
import { parseTestSummary } from "../src/adapters/tests/index.js";
import { setTimeout as delay } from "node:timers/promises";
test("process captures stdout, stderr, exit and provenance", async () => {
  const chunks: string[] = [];
  const r = await execute({
    executable: process.execPath,
    args: ["-e", 'console.log("hello");console.error("oops")'],
    cwd: process.cwd(),
    onOutput: (_, s) => chunks.push(s),
  });
  assert.equal(r.status, "completed");
  assert.match(r.stdout, /hello/);
  assert.match(r.stderr, /oops/);
  assert.ok(chunks.length);
});
test("unavailable executable fails explicitly", async () => {
  const r = await execute({
    executable: "/nonexistent/agentops-cli",
    args: [],
    cwd: process.cwd(),
  });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /ENOENT/);
});
test("timeout and cancellation are bounded", async () => {
  const a = await execute({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    timeoutMs: 80,
    killGraceMs: 50,
  });
  assert.equal(a.status, "timed_out");
  const p = new ManagedProcess({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
  });
  assert.equal((await p.cancel()).status, "cancelled");
});
test("stdin is delivered and logs redact tokens across chunks", async () => {
  const p = new ManagedProcess({
    executable: process.execPath,
    args: [
      "-e",
      'process.stdin.on("data",d=>{process.stdout.write("api_ke");setTimeout(()=>{console.log("y=supersecretvalue");process.exit(0)},20)})',
    ],
    cwd: process.cwd(),
  });
  p.sendInput("go\n");
  const r = await p.result;
  assert.ok(!r.stdout.includes("supersecretvalue"));
  assert.match(r.stdout, /REDACTED/);
});
test("bounded output and explicit shell rejection", async () => {
  assert.throws(() =>
    validateCommand({ executable: "bash", args: ["-c", "echo unsafe"] }),
  );
  assert.equal(redact("password=verysecret"), "password=[REDACTED]");
  const r = await execute({
    executable: process.execPath,
    args: ["-e", 'console.log("x".repeat(10000))'],
    cwd: process.cwd(),
    maxOutputBytes: 1024,
  });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 1024);
});
test("test counts require an actual supported summary", () => {
  assert.deepEqual(parseTestSummary("# pass 156\n# fail 0"), {
    passed: 156,
    failed: 0,
    total: 156,
    source: "node:test",
  });
  assert.equal(
    parseTestSummary("everything is fine, 156 probably pass").passed,
    null,
  );
  assert.equal(
    parseTestSummary("Tests: 2 failed, 4 passed, 6 total").failed,
    2,
  );
});
test("cancellation kills an owned descendant even when its parent closes pipes", async () => {
  let descendant = 0;
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`;
  const p = new ManagedProcess({
    executable: process.execPath,
    args: ["-e", code],
    cwd: process.cwd(),
    killGraceMs: 80,
    onOutput: (_, text) => {
      descendant = Number(text.trim()) || descendant;
    },
  });
  for (let i = 0; !descendant && i < 100; i++) await delay(10);
  assert.ok(descendant > 0);
  await delay(80);
  await p.cancel();
  let alive = true;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(descendant, 0);
      await delay(10);
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false);
});
