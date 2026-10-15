/**
 * The ingest contract: what an agent may send, and what it gets back.
 *
 * These assert the promise the README makes to the agents that read it, so a
 * change here is a change to a published contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, verdictTone } from "../src/core/events.js";

test("two fields are enough", () => {
  const result = validateEvent({ actor: "claude-code", action: "tool_call" });
  assert.ok(result.ok);
  assert.equal(result.value.actor, "claude-code");
  assert.equal(result.value.action, "tool_call");
  // Everything optional is an explicit absence, never an invented default.
  assert.equal(result.value.session, null);
  assert.equal(result.value.provider, null);
  assert.equal(result.value.summary, null);
  assert.equal(result.value.status, null);
  assert.equal(result.value.verdict, null);
  assert.deepEqual(result.value.issues, []);
  assert.deepEqual(result.value.detail, {});
});

test("actor and action are required and named in the error", () => {
  const missing = validateEvent({});
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.errors.some((e) => e.includes("actor")));
  assert.ok(!missing.ok && missing.errors.some((e) => e.includes("action")));

  const blank = validateEvent({ actor: "   ", action: "x" });
  assert.equal(blank.ok, false);

  assert.equal(validateEvent("nope").ok, false);
  assert.equal(validateEvent(null).ok, false);
  assert.equal(validateEvent([1, 2]).ok, false);
});

test("a rich event keeps every field it sent", () => {
  const result = validateEvent({
    actor: "reviewer",
    action: "review",
    session: "sess_1",
    provider: "openai",
    target: "implementer",
    parent: "orchestrator",
    summary: "Parser is correct but the error message leaks the path",
    status: "blocked",
    verdict: "needs-fixes",
    issues: [
      {
        description: "Unbounded read",
        severity: "major",
        path: "a.ts",
        line: 42,
      },
      { description: "Missing test" },
    ],
  });
  assert.ok(result.ok);
  const value = result.value;
  assert.equal(value.session, "sess_1");
  assert.equal(value.provider, "openai");
  assert.equal(value.target, "implementer");
  assert.equal(value.parent, "orchestrator");
  assert.equal(value.status, "blocked");
  assert.equal(value.verdict, "needs-fixes");
  assert.equal(value.issues.length, 2);
  assert.equal(value.issues[0]!.line, 42);
  // Absent issue fields stay absent rather than being filled in.
  assert.equal(value.issues[1]!.severity, null);
  assert.equal(value.issues[1]!.path, null);
  assert.equal(value.issues[1]!.line, null);
});

test("status must be one of the four, and says so", () => {
  assert.ok(validateEvent({ actor: "a", action: "b", status: "running" }).ok);
  assert.ok(validateEvent({ actor: "a", action: "b", status: "OK" }).ok);
  const bad = validateEvent({ actor: "a", action: "b", status: "finished" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.errors[0]!.includes("running, ok, error, blocked"));
});

test("an issue without a description is rejected, not silently dropped", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    issues: [{ severity: "major" }],
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => e.includes("description")));
});

test("unknown top-level keys are kept in detail rather than refused", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    tokens: 1200,
    model: "claude-opus-5",
    detail: { cost: 0.03 },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.detail, {
    cost: 0.03,
    tokens: 1200,
    model: "claude-opus-5",
  });
});

test("credentials are stripped before anything is stored", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    summary:
      "ran with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.ok(result.ok);
  assert.ok(
    !/sk-ant-api03-AAAA/.test(result.value.summary ?? ""),
    "the key must not survive into storage",
  );
});

test("oversized strings are truncated, not rejected", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    summary: "x".repeat(5000),
  });
  assert.ok(result.ok);
  assert.ok((result.value.summary ?? "").length <= 2000);
  assert.ok((result.value.summary ?? "").endsWith("…"));
});

test("an oversized detail is refused with an actionable message", () => {
  const result = validateEvent({
    actor: "a",
    action: "b",
    detail: { blob: "x".repeat(20_000) },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors[0]!.includes("send a reference"));
});

test("verdict tone reads the common vocabularies and stays neutral otherwise", () => {
  assert.equal(verdictTone("APPROVE"), "success");
  assert.equal(verdictTone("passed"), "success");
  assert.equal(verdictTone("lgtm"), "success");
  assert.equal(verdictTone("needs fixes"), "warn");
  assert.equal(verdictTone("REJECT"), "danger");
  assert.equal(verdictTone("failed"), "danger");
  // Unrecognised is neutral: never reported as a failure nobody claimed.
  assert.equal(verdictTone("ship-it-friday"), "neutral");
  assert.equal(verdictTone(null), "neutral");
  // Status fills in when there is no verdict at all.
  assert.equal(verdictTone(null, "error"), "danger");
  assert.equal(verdictTone(null, "blocked"), "warn");
});
