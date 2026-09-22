import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Store } from "../db/store.js";
import type { AgentRecord, CommandSpec, ProjectRecord } from "../core/types.js";
import {
  snapshot,
  validateRoot,
  containedPath,
} from "../adapters/git/index.js";
import { redact, validateCommand } from "../adapters/shell/process.js";
import { redactValue } from "../core/redaction.js";
import { HttpError, stringField } from "./security.js";

export const ADAPTERS = [
  "mock",
  "generic-cli",
  "codex",
  "claude-code",
  "hermes-opencode",
];
export function rejectSecrets(value: unknown) {
  const text = JSON.stringify(value);
  if (
    JSON.stringify(redactValue(value)) !== text ||
    redact(text) !== text ||
    /"(?:env|apiKey|api_key|password|token|secret)"\s*:/i.test(text)
  )
    throw new HttpError(
      400,
      "Credentials and environment variables cannot be stored in AgentOps",
    );
}
export function commands(value: unknown): CommandSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12)
    throw new HttpError(400, "Expected at most 12 verification commands");
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object")
      throw new HttpError(400, "Invalid command");
    const c = raw as Record<string, unknown>;
    const spec = validateCommand(c);
    rejectSecrets(spec);
    const name = typeof c["name"] === "string" ? c["name"] : "test";
    if (!["test", "build", "lint", "typecheck", "custom"].includes(name))
      throw new HttpError(400, "Invalid command name");
    return {
      ...spec,
      name,
      timeoutMs: Math.min(
        Math.max(Number(c["timeoutMs"]) || 300000, 100),
        3600000,
      ),
    };
  });
}
export function allowedAdapters(value: unknown): string[] {
  if (value === undefined) return [...ADAPTERS];
  if (!Array.isArray(value) || value.some((v) => !ADAPTERS.includes(v)))
    throw new HttpError(400, "Invalid allowed adapters");
  return value as string[];
}
export async function registerProject(
  store: Store,
  body: Record<string, unknown>,
): Promise<ProjectRecord> {
  rejectSecrets(body);
  const name = stringField(body, "name", 120);
  const root = await validateRoot(stringField(body, "path", 4096));
  if (store.getProjectByRoot(root))
    throw new HttpError(409, "This repository is already registered");
  const vcs = body["vcs"] === "none" ? "none" : "git";
  const git = vcs === "git" ? await snapshot(root) : null;
  const project = store.createProject({
    name,
    canonicalRoot: root,
    vcs,
    defaultBranch: git?.defaultBranch,
    verificationCommands: commands(body["verificationCommands"]),
    settings: {
      remote: git?.remote ?? null,
      notes: stringField(body, "notes", 10000, true),
      allowedAdapters: allowedAdapters(body["allowedAdapters"]),
    },
  });
  store.appendEvent({
    projectId: project.id,
    category: "project",
    type: "PROJECT_REGISTERED",
    actor: "operator",
    payload: { root, dirty: git?.dirty ?? null },
  });
  return project;
}
export function updateProject(
  store: Store,
  id: string,
  body: Record<string, unknown>,
) {
  rejectSecrets(body);
  const project = store.getProject(id);
  if (!project) throw new HttpError(404, "Project not found");
  return store.updateProject(id, {
    name:
      body["name"] === undefined
        ? project.name
        : stringField(body, "name", 120),
    verificationCommands:
      body["verificationCommands"] === undefined
        ? project.verificationCommands
        : commands(body["verificationCommands"]),
    settings: {
      ...project.settings,
      ...(body["notes"] === undefined
        ? {}
        : { notes: stringField(body, "notes", 10000, true) }),
      ...(body["allowedAdapters"] === undefined
        ? {}
        : { allowedAdapters: allowedAdapters(body["allowedAdapters"]) }),
    },
  });
}
export function saveAgent(
  store: Store,
  body: Record<string, unknown>,
  id?: string,
): AgentRecord | undefined {
  rejectSecrets(body);
  const existing = id ? store.getAgent(id) : undefined;
  if (id && !existing) throw new HttpError(404, "Agent not found");
  const merged = { ...existing, ...body };
  const name = stringField(merged, "name", 120);
  const adapterKind = stringField(merged, "adapterKind", 100);
  if (!ADAPTERS.includes(adapterKind))
    throw new HttpError(400, "Unsupported adapter");
  const config = (merged["config"] ?? {}) as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new HttpError(400, "Invalid agent config");
  const allowed = [
    "executable",
    "args",
    "scenario",
    "manual",
    "provider",
    "allowHermesOneshot",
    "delayMs",
    "timeoutMs",
    "capabilities",
  ];
  if (Object.keys(config).some((k) => !allowed.includes(k)))
    throw new HttpError(400, "Unknown agent configuration field");
  if (config["executable"] !== undefined)
    validateCommand({
      executable: config["executable"],
      args: config["args"] ?? [],
    });
  if (
    config["args"] !== undefined &&
    (!Array.isArray(config["args"]) ||
      config["args"].some((a) => typeof a !== "string"))
  )
    throw new HttpError(400, "Arguments must be a string array");
  for (const key of ["manual", "allowHermesOneshot"])
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new HttpError(400, `Invalid ${key}`);
  const input = {
    name,
    adapterKind,
    roleHint: stringField(merged, "roleHint", 80, true) || null,
    model: stringField(merged, "model", 200, true) || null,
    effort: stringField(merged, "effort", 50, true) || null,
    enabled: merged["enabled"] !== false,
    config,
  };
  const agent = id ? store.updateAgent(id, input) : store.createAgent(input);
  store.appendEvent({
    category: "system",
    type: id ? "AGENT_UPDATED" : "AGENT_REGISTERED",
    actor: "operator",
    payload: { agentId: agent?.id, name, adapterKind },
  });
  return agent;
}
export async function agentAvailability(agent: AgentRecord): Promise<string> {
  if (!agent.enabled) return "DISABLED";
  if (agent.adapterKind === "mock") return "MOCK";
  if (agent.config["manual"] === true) return "MANUAL";
  const exe = String(
    agent.config["executable"] ??
      { codex: "codex", "claude-code": "claude", "hermes-opencode": "hermes" }[
        agent.adapterKind
      ] ??
      "",
  );
  if (!exe) return "UNCONFIGURED";
  const candidates = exe.includes("/")
    ? [exe]
    : (process.env["PATH"] ?? "")
        .split(path.delimiter)
        .map((p) => path.join(p, exe));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return "INSTALLED";
    } catch {
      /* continue */
    }
  }
  return "UNAVAILABLE";
}
export async function registerArtifact(
  store: Store,
  runId: string,
  body: Record<string, unknown>,
) {
  const run = store.requireRun(runId);
  const relative = stringField(body, "path", 4096);
  const kind = stringField(body, "kind", 80);
  rejectSecrets(body);
  const canonical = await validateRoot(run.projectRoot);
  const full = await containedPath(canonical, relative);
  const info = await stat(full);
  if (!info.isFile()) throw new HttpError(400, "Artifact must be a file");
  const last = store.listAttemptsForRun(runId).at(-1);
  const artifact = store.insertArtifact({
    runId,
    stageKey: last?.stageKey ?? "operator",
    attemptId: last?.id,
    taskId: last?.taskId,
    path: path.relative(canonical, full),
    kind,
    creator: "operator",
    exists: true,
    sizeBytes: info.size,
  });
  store.appendEvent({
    projectId: run.projectId,
    runId,
    category: "artifact",
    type: "ARTIFACT_REGISTERED",
    actor: "operator",
    payload: { artifactId: artifact.id, path: artifact.path },
  });
  return artifact;
}
