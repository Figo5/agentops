import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LocalGuard } from "../src/server/security.js";
const response = { setHeader() {} } as unknown as ServerResponse;
test("local guard rejects rebinding, foreign origins and writes without token", () => {
  const guard = new LocalGuard(4317);
  const req = (host: string, method = "GET", extra = {}) =>
    ({ headers: { host, ...extra }, method }) as IncomingMessage;
  assert.throws(() => guard.check(req("evil.example:4317"), response), /Host/);
  assert.throws(
    () =>
      guard.check(
        req("127.0.0.1:4317", "GET", { origin: "https://evil.example" }),
        response,
      ),
    /origin/,
  );
  assert.throws(
    () => guard.check(req("127.0.0.1:4317", "POST"), response),
    /token/,
  );
  assert.throws(
    () =>
      guard.check(
        req("127.0.0.1:4317", "GET", { "sec-fetch-site": "cross-site" }),
        response,
      ),
    /site/,
  );
  assert.throws(
    () =>
      guard.check(
        req("127.0.0.1:4317", "GET", { "sec-fetch-site": "same-site" }),
        response,
      ),
    /site/,
  );
  assert.throws(
    () =>
      guard.check(
        req("127.0.0.1:4317", "POST", {
          "x-agentops-token": "a".repeat(63) + "é",
          "content-type": "application/json",
        }),
        response,
      ),
    /token/,
  );
  guard.check(
    req("127.0.0.1:4317", "POST", {
      "x-agentops-token": guard.token,
      "content-type": "application/json",
    }),
    response,
  );
});
