import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { execute } from "../shell/process.js";

export async function validateRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"))
    throw new Error("Project path must be absolute");
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Project root is not a directory");
  return canonical;
}
export async function containedPath(
  root: string,
  relative: string,
): Promise<string> {
  const canonical = await validateRoot(root);
  if (path.isAbsolute(relative) || relative.includes("\0"))
    throw new Error("Artifact path must be relative");
  const resolved = await realpath(path.resolve(canonical, relative));
  if (resolved !== canonical && !resolved.startsWith(canonical + path.sep))
    throw new Error("Path escapes project root");
  return resolved;
}
async function git(
  root: string,
  args: string[],
  optional = false,
): Promise<string> {
  const result = await execute({
    executable: "git",
    args: [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    cwd: root,
    timeoutMs: 15000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (result.truncated)
    throw new Error(
      "Git output exceeded the capture limit; checkpoint or diff is unavailable rather than partial",
    );
  if (result.exitCode !== 0 && !optional)
    throw new Error(result.stderr || result.error || "Git command failed");
  return result.exitCode === 0 ? result.stdout.trimEnd() : "";
}
export interface GitSnapshot {
  timestamp: string;
  root: string;
  branch: string;
  head: string;
  dirty: boolean;
  remote: string | null;
  defaultBranch: string;
  staged: string[];
  changed: string[];
  untracked: string[];
  status: string;
  insertions: number;
  deletions: number;
  ahead: number | null;
  behind: number | null;
  commits: string[];
}
export async function snapshot(
  root: string,
  previousHead?: string,
): Promise<GitSnapshot> {
  root = await validateRoot(root);
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(top)) !== root)
    throw new Error("Register the git repository root, not a subdirectory");
  const [branch, head, status, remote, defaultRef, numstat, divergence] =
    await Promise.all([
      git(root, ["symbolic-ref", "--short", "HEAD"], true),
      git(root, ["rev-parse", "--verify", "HEAD"], true),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      git(root, ["remote", "get-url", "origin"], true),
      git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"], true),
      git(
        root,
        ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "HEAD", "--"],
        true,
      ),
      git(
        root,
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        true,
      ),
    ]);
  const staged: string[] = [],
    changed: string[] = [],
    untracked: string[] = [];
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (!item) continue;
    const xy = item.slice(0, 2),
      name = item.slice(3);
    if (xy === "??") untracked.push(name);
    else {
      if (xy[0] !== " ") staged.push(name);
      if (xy[1] !== " ") changed.push(name);
    }
    if (/[RC]/.test(xy)) i++;
  }
  let insertions = 0,
    deletions = 0;
  for (const line of numstat.split("\n")) {
    const [a, b] = line.split("\t");
    insertions += Number(a) || 0;
    deletions += Number(b) || 0;
  }
  const div = divergence.match(/^(\d+)\s+(\d+)$/);
  const commits =
    previousHead && /^[0-9a-f]{40,64}$/.test(previousHead) && head
      ? (
          await git(
            root,
            ["log", "--format=%h %s", `${previousHead}..${head}`, "--"],
            true,
          )
        )
          .split("\n")
          .filter(Boolean)
      : [];
  return {
    timestamp: new Date().toISOString(),
    root,
    branch: branch || "(detached)",
    head,
    dirty: !!status,
    remote: remote || null,
    defaultBranch:
      defaultRef.replace("refs/remotes/origin/", "") || branch || "main",
    staged,
    changed,
    untracked,
    status,
    insertions,
    deletions,
    ahead: div ? Number(div[1]) : null,
    behind: div ? Number(div[2]) : null,
    commits,
  };
}
export async function diff(root: string, staged = false): Promise<string> {
  root = await validateRoot(root);
  return git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    ...(staged ? ["--cached"] : []),
    "--",
  ]);
}
export type GitOperation =
  | { kind: "commit"; message: string }
  | { kind: "branch"; name: string };
export function validateGitPolicy(operation: GitOperation, allowed: string[]) {
  if (
    !operation ||
    !["commit", "branch"].includes(operation.kind) ||
    !allowed.includes(operation.kind)
  )
    throw new Error("Git operation is not allowed by workflow policy");
  if (
    operation.kind === "commit" &&
    (!operation.message?.trim() || operation.message.length > 10000)
  )
    throw new Error("Commit message required");
  if (
    operation.kind === "branch" &&
    (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,150}$/.test(operation.name) ||
      operation.name.includes("..") ||
      operation.name.endsWith("/"))
  )
    throw new Error("Invalid branch name");
}
export async function writeGit(
  root: string,
  operation: GitOperation,
  allowed: string[],
) {
  validateGitPolicy(operation, allowed);
  root = await validateRoot(root);
  return git(
    root,
    operation.kind === "commit"
      ? ["-c", "commit.gpgsign=false", "commit", "-m", operation.message]
      : ["branch", "--", operation.name],
  );
}
