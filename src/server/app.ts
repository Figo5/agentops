import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Store } from "../db/store.js";
import type {
  ApprovalDecision,
  RunSearchQuery,
  RunStatus,
  ReviewVerdictKind,
} from "../core/types.js";
import { createRuntime } from "./runtime.js";
import { HttpError, LocalGuard, readJson, stringField } from "./security.js";
import {
  registerProject,
  updateProject,
  saveAgent,
  registerArtifact,
  rejectSecrets,
  agentAvailability,
} from "./services.js";
import {
  snapshot,
  diff,
  validateRoot,
  containedPath,
  writeGit,
  type GitOperation,
} from "../adapters/git/index.js";
import { redact } from "../adapters/shell/process.js";

export interface AppOptions {
  dbPath?: string;
  staticDir?: string;
  port?: number;
  seedAgents?: boolean;
}
export function createApp(options: AppOptions = {}) {
  const store = new Store({ path: options.dbPath ?? ":memory:" });
  const engine = createRuntime(store);
  const guard = new LocalGuard(options.port ?? 4317);
  if (options.seedAgents !== false && !store.listAgents().length)
    for (const role of [
      "planner",
      "implementer",
      "reviewer",
      "researcher",
      "documenter",
    ])
      store.createAgent({
        name: `Mock ${role}`,
        adapterKind: "mock",
        roleHint: role,
        model: null,
        effort: null,
        config: { scenario: "success" },
      });
  const clients = new Set<ServerResponse>();
  const responsiveAction = async (id: string, action: Promise<unknown>) => {
    let detached = false;
    const observed = action.catch((error) => {
      if (detached) {
        store.appendEvent({
          runId: id,
          category: "system",
          type: "ACTION_FAILED",
          actor: "system",
          payload: { error: redact(String(error)) },
        });
        return;
      }
      throw error;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        observed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            detached = true;
            resolve();
          }, 40);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body));
  };
  const detail = async (id: string) => {
    const d = store.getRunDetail(id, { eventLimit: 2000 });
    if (!d) throw new HttpError(404, "Run not found");
    const floor = store.db
      .prepare(
        "SELECT id FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1 OFFSET 1999",
      )
      .get(id) as { id: number } | undefined;
    d.events = store.listEvents({
      runId: id,
      afterId: floor ? floor.id - 1 : 0,
      limit: 2000,
    });
    const artifacts = await Promise.all(
      store.listArtifacts(id).map(async (a) => {
        let exists = false,
          sizeBytes: number | null = null;
        try {
          const s = await stat(await containedPath(d.run.projectRoot, a.path));
          exists = s.isFile();
          sizeBytes = exists ? s.size : null;
        } catch {
          /* Missing or escaping references remain visible but unavailable. */
        }
        if (exists !== a.exists || sizeBytes !== a.sizeBytes)
          store.db
            .prepare(
              "UPDATE artifacts SET exists_flag=?,size_bytes=? WHERE id=?",
            )
            .run(exists ? 1 : 0, sizeBytes, a.id);
        return { ...a, exists, sizeBytes };
      }),
    );
    return {
      ...d,
      snapshots: store.listGitSnapshots(id),
      commands: store.listShellCommands(id),
      tests: store.listTestRuns(id),
      artifacts,
      project: store.getProject(d.run.projectId),
      agents: store.listAgents(),
    };
  };
  const server = createServer(async (req, res) => {
    try {
      guard.check(req, res);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      if (url.pathname === "/api/bootstrap" && method === "GET")
        return json(res, {
          token: guard.token,
          version: "1.0.0",
          projects: store.listProjects(),
          agents: await Promise.all(
            store.listAgents().map(async (a) => ({
              ...a,
              availability: await agentAvailability(a),
            })),
          ),
          templates: store
            .listTemplates()
            .map((t) => ({ ...t, plan: store.getTemplatePlan(t.id) })),
          runs: store.listRuns({ limit: 100 }),
        });
      if (url.pathname === "/api/events" && method === "GET") {
        const runId = url.searchParams.get("runId");
        let cursor = Number(
          req.headers["last-event-id"] ?? url.searchParams.get("afterId") ?? 0,
        );
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new HttpError(400, "Invalid event cursor");
        if (runId && !store.getRun(runId))
          throw new HttpError(404, "Run not found");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        clients.add(res);
        let blocked = false;
        const pump = () => {
          if (blocked || res.destroyed) return;
          try {
            for (const event of store.listEvents({
              runId,
              afterId: cursor,
              limit: 200,
            })) {
              cursor = event.id;
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
        res.on("drain", () => {
          blocked = false;
          pump();
        });
        pump();
        const timer = setInterval(pump, 200);
        const heartbeat = setInterval(() => {
          if (!blocked) res.write(": keepalive\n\n");
          else res.end();
        }, 15000);
        res.on("close", () => {
          clearInterval(timer);
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      if (url.pathname === "/api/runs" && method === "GET") {
        const p = url.searchParams;
        const query: RunSearchQuery = {
          goalContains: p.get("q"),
          projectId: p.get("projectId"),
          agentId: p.get("agentId"),
          status: p.get("status") as RunStatus | null,
          branch: p.get("branch"),
          reviewVerdict: p.get("verdict") as ReviewVerdictKind | null,
          createdAfter: p.get("from"),
          createdBefore: p.get("to"),
          limit: 200,
        };
        return json(res, store.searchRuns(query));
      }
      if (url.pathname === "/api/projects" && method === "POST")
        return json(
          res,
          await registerProject(store, await readJson(req)),
          201,
        );
      if (url.pathname === "/api/agents" && method === "POST")
        return json(res, saveAgent(store, await readJson(req)), 201);
      if (
        parts[0] === "api" &&
        parts[1] === "agents" &&
        parts.length === 3 &&
        method === "PATCH"
      )
        return json(res, saveAgent(store, await readJson(req), parts[2]!));
      if (parts[0] === "api" && parts[1] === "projects" && parts[2]) {
        const project = store.getProject(parts[2]);
        if (!project) throw new HttpError(404, "Project not found");
        if (parts.length === 3 && method === "PATCH")
          return json(
            res,
            updateProject(store, project.id, await readJson(req)),
          );
        if (parts[3] === "snapshot" && method === "GET")
          return json(res, await snapshot(project.canonicalRoot));
        if (parts[3] === "diff" && method === "GET")
          return json(res, {
            diff: await diff(
              project.canonicalRoot,
              url.searchParams.get("staged") === "true",
            ),
          });
      }
      if (url.pathname === "/api/runs" && method === "POST") {
        const body = await readJson(req);
        rejectSecrets(body);
        const projectId = stringField(body, "projectId", 100),
          project = store.getProject(projectId);
        if (!project) throw new HttpError(404, "Project not found");
        await validateRoot(project.canonicalRoot);
        const roleMapping = body["roleMapping"];
        if (
          !roleMapping ||
          typeof roleMapping !== "object" ||
          Array.isArray(roleMapping) ||
          Object.values(roleMapping).some((v) => typeof v !== "string")
        )
          throw new HttpError(400, "Role mapping required");
        const allowed = project.settings["allowedAdapters"] as
          | string[]
          | undefined;
        for (const id of Object.values(roleMapping)) {
          const agent = store.getAgent(id as string);
          if (!agent || !agent.enabled)
            throw new HttpError(400, "Agent is unavailable or disabled");
          if (allowed && !allowed.includes(agent.adapterKind))
            throw new HttpError(
              400,
              "Agent adapter is not allowed for this project",
            );
        }
        const constraints = body["constraints"] ?? [];
        if (
          !Array.isArray(constraints) ||
          constraints.length > 50 ||
          constraints.some((c) => typeof c !== "string" || c.length > 10000)
        )
          throw new HttpError(400, "Invalid constraints");
        const created = await engine.createRun({
          projectId,
          templateId: stringField(body, "templateId", 100),
          goal: stringField(body, "goal", 30000),
          agents: roleMapping as Record<string, string>,
          constraints: constraints as string[],
        });
        return json(res, created.run, 201);
      }
      if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
        const id = parts[2];
        if (!store.getRun(id)) throw new HttpError(404, "Run not found");
        if (parts.length === 3 && method === "GET")
          return json(res, await detail(id));
        if (parts[3] === "events" && method === "GET") {
          const afterId = Number(url.searchParams.get("afterId") ?? 0);
          if (!Number.isSafeInteger(afterId) || afterId < 0)
            throw new HttpError(400, "Invalid cursor");
          return json(
            res,
            store.listEvents({ runId: id, afterId, limit: 1000 }),
          );
        }
        if (method === "POST") {
          const body = await readJson(req);
          rejectSecrets(body);
          switch (parts[3]) {
            case "start":
              await validateRoot(store.requireRun(id).projectRoot);
              await responsiveAction(id, engine.startRun(id));
              break;
            case "retry": {
              await validateRoot(store.requireRun(id).projectRoot);
              const reason = stringField(body, "reason", 10000);
              const instruction = stringField(body, "instruction", 10000, true);
              await responsiveAction(
                id,
                engine.retry(
                  id,
                  reason +
                    (instruction ? `\nNext instruction: ${instruction}` : ""),
                ),
              );
              break;
            }
            case "cancel":
              await engine.cancel(
                id,
                stringField(body, "reason", 10000, true) ||
                  "Cancelled by operator",
              );
              break;
            case "approval":
              await responsiveAction(
                id,
                engine.decideApproval(
                  id,
                  stringField(body, "decision", 30) as ApprovalDecision,
                  stringField(body, "instruction", 10000, true) || undefined,
                ),
              );
              break;
            case "input":
              await responsiveAction(
                id,
                engine.sendInput(id, stringField(body, "text", 30000)),
              );
              break;
            case "artifacts":
              return json(res, await registerArtifact(store, id, body), 201);
            case "git": {
              const run = store.requireRun(id);
              if (
                ["RUNNING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(
                  run.status,
                )
              )
                throw new HttpError(
                  409,
                  "Git writes are blocked during execution and approval gates",
                );
              const operation = body["operation"] as GitOperation;
              const allowed =
                run.policy.gitPolicy === "branch-and-commit"
                  ? ["branch", "commit"]
                  : [];
              const result = await writeGit(
                run.projectRoot,
                operation,
                allowed,
              );
              store.appendEvent({
                projectId: run.projectId,
                runId: id,
                category: "snapshot",
                type: "GIT_WRITE",
                actor: "operator",
                payload: {
                  operation,
                  result,
                  hooksDisabled: true,
                  unsigned: operation.kind === "commit",
                },
              });
              return json(res, { result });
            }
            default:
              throw new HttpError(404, "Unknown action");
          }
          return json(res, await detail(id));
        }
      }
      if (url.pathname.startsWith("/api/"))
        throw new HttpError(404, "Unknown API route");
      if (method !== "GET" && method !== "HEAD")
        throw new HttpError(405, "Method not allowed");
      const staticDir = options.staticDir ?? path.resolve("dist/ui");
      const rel = decodeURIComponent(url.pathname);
      let file = path.resolve(staticDir, "." + rel);
      if (file !== staticDir && !file.startsWith(staticDir + path.sep))
        throw new HttpError(403, "Invalid asset path");
      if (!path.extname(file)) file = path.join(staticDir, "index.html");
      try {
        if (!(await stat(file)).isFile()) throw new Error();
      } catch {
        throw new HttpError(
          404,
          "Client build not found. Run npm run build first.",
        );
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(method === "HEAD" ? undefined : await readFile(file));
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e = error as Error & { status?: number; code?: string };
      const status =
        e.status ??
        (e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400);
      json(res, { error: redact(e.message || String(error)) }, status);
    }
  });
  return {
    server,
    store,
    engine,
    guard,
    async listen(port = options.port ?? 4317) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : port;
      guard.setPort(actual);
      return actual;
    },
    async close() {
      for (const res of clients) res.end();
      await engine.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
