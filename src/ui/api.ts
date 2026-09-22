/**
 * Typed HTTP client for the AgentOps local API.
 *
 * Every read and write the UI performs goes through this module — there is no
 * mock data path anywhere in the UI. Writes send JSON with the
 * `X-AgentOps-Token` header obtained from `GET /api/bootstrap`.
 *
 * The client is deliberately dependency-free (no React, no DOM beyond
 * `fetch`/`EventSource` injection) so it can be unit-tested in Node.
 */
import type {
  AgentRecord,
  ArtifactRecord,
  EventRecord,
  GitSnapshotRecord,
  ProjectRecord,
  RunDetail,
  RunRecord,
  ShellCommandRecord,
  StagePlan,
  TestRunRecord,
  WorkflowTemplateRecord,
} from "../core/types.js";
import {
  serializeQuery,
  type AgentPayload,
  type ProjectPayload,
  type RunCreatePayload,
} from "./view-model.js";

/** `GET /api/bootstrap` payload. */
export interface Bootstrap {
  token: string;
  projects: ProjectRecord[];
  agents: AgentRecord[];
  templates: (WorkflowTemplateRecord & { plan: StagePlan })[];
  runs: RunRecord[];
  version: string;
}

/** `GET /api/runs/:id` payload: the detail aggregate plus its inspector records. */
export interface RunDetailResponse extends RunDetail {
  snapshots: GitSnapshotRecord[];
  commands: ShellCommandRecord[];
  tests: TestRunRecord[];
  artifacts: ArtifactRecord[];
  project: ProjectRecord | null;
  agents: AgentRecord[];
}

export interface ProjectSnapshotResponse {
  head: string | null;
  branch: string | null;
  detached?: boolean;
  dirty?: boolean;
  changed?: string[];
  untracked?: string[];
  insertions?: number | null;
  deletions?: number | null;
  error?: string;
}

export interface RunSearchParams {
  q?: string;
  projectId?: string;
  agentId?: string;
  status?: string;
  branch?: string;
  verdict?: string;
  from?: string;
  to?: string;
}

export interface SseEventPayload {
  id: number;
  event: "event";
  data: EventRecord;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Extracts the server's `{error}` contract, tolerating plain-text failures. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.text();
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim())
          message = parsed.error;
        else message = body.trim();
      } catch {
        message = body.trim();
      }
    }
  } catch {
    /* Body unreadable: keep the status line. */
  }
  return new ApiError(response.status, message);
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ClientOptions {
  /** Defaults to same-origin (`''`), which is how the server serves the client. */
  baseUrl?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
}

export interface AgentOpsClient {
  readonly baseUrl: string;
  setToken(token: string | null): void;
  getToken(): string | null;
  bootstrap(): Promise<Bootstrap>;
  runs(params: RunSearchParams): Promise<RunRecord[]>;
  runDetail(runId: string): Promise<RunDetailResponse>;
  eventsUrl(runId: string, afterId: number): string;
  projectDiff(projectId: string, staged?: boolean): Promise<{ diff: string }>;
  projectSnapshot(projectId: string): Promise<ProjectSnapshotResponse>;
  createProject(payload: ProjectPayload): Promise<ProjectRecord>;
  updateProject(
    projectId: string,
    payload: Partial<ProjectPayload>,
  ): Promise<ProjectRecord>;
  createAgent(payload: AgentPayload): Promise<AgentRecord>;
  updateAgent(
    agentId: string,
    payload: Partial<AgentPayload>,
  ): Promise<AgentRecord>;
  createRun(payload: RunCreatePayload): Promise<RunRecord>;
  startRun(runId: string): Promise<RunDetailResponse>;
  retryRun(
    runId: string,
    body: { reason: string; instruction?: string | null },
  ): Promise<RunDetailResponse>;
  cancelRun(
    runId: string,
    body: { reason: string },
  ): Promise<RunDetailResponse>;
  decideApproval(
    runId: string,
    body: {
      decision: "approve" | "reject" | "override" | "retry";
      instruction?: string | null;
    },
  ): Promise<RunDetailResponse>;
  sendInput(runId: string, body: { text: string }): Promise<RunDetailResponse>;
  registerArtifact(
    runId: string,
    body: { path: string; kind: string },
  ): Promise<ArtifactRecord>;
}

export function createClient(options: ClientOptions = {}): AgentOpsClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch =
    options.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => fetch(...args));
  let token: string | null = options.token ?? null;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    withToken = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (withToken) {
      if (!token)
        throw new ApiError(
          0,
          "No local action token yet — the bootstrap request has not succeeded.",
        );
      headers.set("X-AgentOps-Token", token);
    }
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new ApiError(
        0,
        `Cannot reach the AgentOps server: ${describeError(error)}`,
      );
    }
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        response.status,
        `Malformed JSON response from ${path}`,
      );
    }
  }

  return {
    baseUrl,
    setToken(next) {
      token = next;
    },
    getToken() {
      return token;
    },
    async bootstrap() {
      const payload = await request<Bootstrap>("/api/bootstrap");
      if (payload && typeof payload.token === "string") token = payload.token;
      return payload;
    },
    runs(params) {
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(params))
        if (value) query[key] = String(value);
      return request<RunRecord[]>(`/api/runs${serializeQuery(query)}`);
    },
    runDetail(runId) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}`,
      );
    },
    eventsUrl(runId, afterId) {
      const query = new URLSearchParams({
        runId,
        afterId: String(Math.max(0, Math.trunc(afterId))),
      });
      return `${baseUrl}/api/events?${query.toString()}`;
    },
    projectDiff(projectId, staged = false) {
      const query = staged ? "?staged=true" : "";
      return request<{ diff: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/diff${query}`,
      );
    },
    projectSnapshot(projectId) {
      return request<ProjectSnapshotResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/snapshot`,
      );
    },
    createProject(payload) {
      return request<ProjectRecord>(
        "/api/projects",
        { method: "POST", body: JSON.stringify(payload) },
        true,
      );
    },
    updateProject(projectId, payload) {
      return request<ProjectRecord>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        { method: "PATCH", body: JSON.stringify(payload) },
        true,
      );
    },
    createAgent(payload) {
      return request<AgentRecord>(
        "/api/agents",
        { method: "POST", body: JSON.stringify(payload) },
        true,
      );
    },
    updateAgent(agentId, payload) {
      return request<AgentRecord>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: "PATCH", body: JSON.stringify(payload) },
        true,
      );
    },
    createRun(payload) {
      return request<RunRecord>(
        "/api/runs",
        { method: "POST", body: JSON.stringify(payload) },
        true,
      );
    },
    startRun(runId) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}/start`,
        { method: "POST", body: JSON.stringify({}) },
        true,
      );
    },
    retryRun(runId, body) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}/retry`,
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
    },
    cancelRun(runId, body) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
    },
    decideApproval(runId, body) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}/approval`,
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
    },
    sendInput(runId, body) {
      return request<RunDetailResponse>(
        `/api/runs/${encodeURIComponent(runId)}/input`,
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
    },
    registerArtifact(runId, body) {
      return request<ArtifactRecord>(
        `/api/runs/${encodeURIComponent(runId)}/artifacts`,
        { method: "POST", body: JSON.stringify(body) },
        true,
      );
    },
  };
}

/** Parses one SSE frame's `data:` line. Returns null for comments/keep-alives. */
export function parseSseEventFrame(frame: string): EventRecord | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as Partial<EventRecord>;
    if (typeof parsed.id !== "number") return null;
    return parsed as EventRecord;
  } catch {
    return null;
  }
}
