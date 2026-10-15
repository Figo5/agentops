/**
 * The whole service: take events in, fan them out, serve the field.
 *
 * Four routes.
 *
 *   POST /ingest        one event, or an array of them
 *   GET  /api/events    SSE, resumable with Last-Event-ID
 *   GET  /api/bootstrap the token and the recent window
 *   GET  /*             the built client
 *
 * It orchestrates nothing and never launches a process. That is the point: an
 * agent of any provider reports what it is doing and appears in the field, so
 * the viewer has no opinion about how the agent is run.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvent, type EventRecord } from "../core/events.js";
import { Store } from "../db/store.js";
import { HttpError, LocalGuard, readJson } from "./security.js";

export interface AppOptions {
  dbPath?: string;
  port?: number;
}

/** How many events a fresh client is handed before the live stream takes over. */
const BOOTSTRAP_WINDOW = 400;
/** Maximum events accepted in one POST. */
const MAX_BATCH = 100;

const CLIENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/ui",
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function createApp(options: AppOptions = {}) {
  const store = new Store({ path: options.dbPath });
  const guard = new LocalGuard(options.port ?? 4317);
  /** Open SSE responses, woken whenever something is appended. */
  const clients = new Set<() => void>();

  const broadcast = () => {
    for (const wake of clients) wake();
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const method = req.method ?? "GET";
      const ingesting = url.pathname === "/ingest" && method === "POST";
      guard.check(req, res, { tokenRequired: !ingesting });

      if (ingesting) {
        const body = await readJson(req);
        // One event, or `{ events: [...] }`: a batching agent should not have
        // to open a request per tool call.
        const batch = Array.isArray(body["events"])
          ? (body["events"] as unknown[])
          : [body];
        if (batch.length === 0) throw new HttpError(400, "No events posted");
        if (batch.length > MAX_BATCH)
          throw new HttpError(
            413,
            `At most ${MAX_BATCH} events per request (received ${batch.length})`,
          );
        const accepted: EventRecord[] = [];
        const rejected: { index: number; errors: string[] }[] = [];
        batch.forEach((candidate, index) => {
          const validation = validateEvent(candidate);
          if (validation.ok) accepted.push(store.append(validation.value));
          else rejected.push({ index, errors: validation.errors });
        });
        if (accepted.length > 0) broadcast();
        // A partially valid batch is reported, never silently dropped: the
        // sender is told exactly which entries failed and why.
        return json(
          res,
          {
            accepted: accepted.length,
            rejected,
            latestId: store.latestId(),
          },
          rejected.length === 0 ? 202 : 207,
        );
      }

      if (url.pathname === "/api/bootstrap" && method === "GET")
        return json(res, {
          token: guard.token,
          version: "2.0.0",
          events: store.list({ limit: BOOTSTRAP_WINDOW }),
          latestId: store.latestId(),
          total: store.count(),
        });

      if (url.pathname === "/api/events" && method === "GET") {
        const session = url.searchParams.get("session");
        let cursor = Number(
          req.headers["last-event-id"] ?? url.searchParams.get("afterId") ?? 0,
        );
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new HttpError(400, "Invalid event cursor");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        let blocked = false;
        const pump = () => {
          if (blocked || res.destroyed) return;
          try {
            for (const event of store.since(cursor)) {
              cursor = event.id;
              if (session && event.session !== session) continue;
              if (
                !res.write(
                  `id: ${event.id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`,
                )
              ) {
                blocked = true;
                break;
              }
            }
          } catch {
            res.end();
          }
        };
        clients.add(pump);
        res.on("drain", () => {
          blocked = false;
          pump();
        });
        pump();
        const heartbeat = setInterval(() => {
          if (!blocked) res.write(": keepalive\n\n");
          else res.end();
        }, 15000);
        res.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(pump);
        });
        return;
      }

      // The README is the agent-facing setup guide, and it tells agents to
      // read it from this URL — so it has to be reachable from here, not just
      // from the repository.
      if (url.pathname === "/README.md" && method === "GET") {
        try {
          const readme = await readFile(
            path.resolve(CLIENT_ROOT, "../../README.md"),
          );
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Length": readme.byteLength,
          });
          return res.end(readme);
        } catch {
          throw new HttpError(404, "README.md is not next to this install");
        }
      }

      if (url.pathname.startsWith("/api/"))
        throw new HttpError(404, "Unknown API route");
      if (method !== "GET" && method !== "HEAD")
        throw new HttpError(405, "Method not allowed");

      // Static client. Every unknown path falls back to index.html so the
      // single-page app owns its own routing.
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      const resolved = path.resolve(CLIENT_ROOT, `.${requested}`);
      const safe = resolved.startsWith(CLIENT_ROOT + path.sep)
        ? resolved
        : path.join(CLIENT_ROOT, "index.html");
      let file: Buffer;
      try {
        file = await readFile(safe);
      } catch {
        try {
          file = await readFile(path.join(CLIENT_ROOT, "index.html"));
        } catch {
          throw new HttpError(
            503,
            "The client is not built yet. Run `npm run build`, then reload.",
          );
        }
      }
      res.writeHead(200, {
        "Content-Type":
          CONTENT_TYPES[path.extname(safe)] ?? "application/octet-stream",
        "Content-Length": file.byteLength,
      });
      res.end(file);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof Error ? error.message : "Unexpected failure";
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, { error: message }, status);
    }
  });

  return {
    store,
    guard,
    listen(port = options.port ?? 4317): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          const bound =
            typeof address === "object" && address ? address.port : port;
          guard.setPort(bound);
          resolve(bound);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const wake of clients) wake();
        clients.clear();
        server.closeAllConnections?.();
        server.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };
}
