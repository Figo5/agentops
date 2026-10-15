/**
 * The HTTP surface: ingest, stream, guard.
 *
 * Each test runs a real server on an ephemeral port with an in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createApp } from "../src/server/app.js";

async function withServer(
  run: (base: string, app: ReturnType<typeof createApp>) => Promise<void>,
): Promise<void> {
  const app = createApp();
  const port = await app.listen(0);
  try {
    await run(`http://127.0.0.1:${port}`, app);
  } finally {
    await app.close();
  }
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("an agent can report with no token and no handshake", async () => {
  await withServer(async (base, app) => {
    const response = await post(base, {
      actor: "claude-code",
      action: "hello",
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { accepted: number };
    assert.equal(body.accepted, 1);
    assert.equal(app.store.count(), 1);
    assert.equal(app.store.list()[0]!.actor, "claude-code");
  });
});

test("a batch is accepted, and a partial batch reports exactly what failed", async () => {
  await withServer(async (base, app) => {
    const good = await post(base, {
      events: [
        { actor: "a", action: "one" },
        { actor: "b", action: "two" },
      ],
    });
    assert.equal(good.status, 202);
    assert.equal(app.store.count(), 2);

    const mixed = await post(base, {
      events: [{ actor: "c", action: "three" }, { action: "no actor" }],
    });
    // 207: the valid entry was stored and the invalid one is named.
    assert.equal(mixed.status, 207);
    const body = (await mixed.json()) as {
      accepted: number;
      rejected: { index: number; errors: string[] }[];
    };
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0]!.index, 1);
    assert.ok(body.rejected[0]!.errors.some((e) => e.includes("actor")));
    assert.equal(app.store.count(), 3);
  });
});

test("an empty or oversized batch is refused", async () => {
  await withServer(async (base, app) => {
    assert.equal((await post(base, { events: [] })).status, 400);
    const huge = await post(base, {
      events: Array.from({ length: 101 }, () => ({ actor: "a", action: "b" })),
    });
    assert.equal(huge.status, 413);
    assert.equal(
      app.store.count(),
      0,
      "nothing from a refused batch is stored",
    );
  });
});

test("the guard refuses a cross-origin or cross-site post", async () => {
  await withServer(async (base, app) => {
    const crossOrigin = await post(
      base,
      { actor: "a", action: "b" },
      { origin: "https://evil.example" },
    );
    assert.equal(crossOrigin.status, 403);

    const crossSite = await post(
      base,
      { actor: "a", action: "b" },
      { "sec-fetch-site": "cross-site" },
    );
    assert.equal(crossSite.status, 403);
    assert.equal(app.store.count(), 0);
  });
});

test("the guard refuses an untrusted Host and a non-JSON body", async () => {
  await withServer(async (base, app) => {
    // `fetch` will not let a caller set Host, and Host is the check that stops
    // DNS rebinding, so this one goes over a raw socket.
    const port = Number(new URL(base).port);
    const body = '{"actor":"a","action":"b"}';
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /ingest HTTP/1.1\r\nHost: evil.example\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 403/);
    assert.equal(app.store.count(), 0);

    const badType = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "actor=a",
    });
    assert.equal(badType.status, 415);
  });
});

test("bootstrap hands back the recent window and the cursor", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "a", action: "one" });
    await post(base, { actor: "b", action: "two" });
    const payload = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
      events: { actor: string }[];
      latestId: number;
      total: number;
      token: string;
    };
    assert.equal(payload.total, 2);
    assert.equal(payload.latestId, 2);
    assert.deepEqual(
      payload.events.map((e) => e.actor),
      ["a", "b"],
      "oldest first, so the client can fold in order",
    );
    assert.ok(payload.token.length > 0);
  });
});

test("the stream replays from a cursor and then delivers live events", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "first", action: "before" });
    const response = await fetch(`${base}/api/events?afterId=0`);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      assert.ok(buffer.includes(needle), `stream never carried ${needle}`);
    };

    await readUntil('"actor":"first"');
    await post(base, { actor: "second", action: "after" });
    await readUntil('"actor":"second"');
    // Each frame carries its id, which is what makes Last-Event-ID resumable.
    assert.match(buffer, /\nid: \d+\n/);
    await reader.cancel();
  });
});

test("a session filter only streams that session", async () => {
  await withServer(async (base) => {
    await post(base, { actor: "a", action: "x", session: "keep" });
    await post(base, { actor: "b", action: "y", session: "drop" });
    const response = await fetch(`${base}/api/events?session=keep`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 3000;
    while (!buffer.includes('"actor":"a"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    assert.ok(buffer.includes('"actor":"a"'));
    assert.ok(!buffer.includes('"actor":"b"'), "the other session is withheld");
    await reader.cancel();
  });
});

test("an unknown API route is a 404, not the client", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });
});
