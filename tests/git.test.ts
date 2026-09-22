import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execute } from "../src/adapters/shell/process.js";
import {
  snapshot,
  diff,
  containedPath,
  validateGitPolicy,
} from "../src/adapters/git/index.js";
test("git checkpoint captures staged, dirty, untracked and real diffs", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agentops-git-"));
  try {
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
    ])
      assert.equal(
        (await execute({ executable: "git", args, cwd })).exitCode,
        0,
      );
    await writeFile(path.join(cwd, "hello.txt"), "hello\n");
    await execute({ executable: "git", args: ["add", "hello.txt"], cwd });
    await execute({
      executable: "git",
      args: ["commit", "-m", "fixture"],
      cwd,
    });
    await writeFile(path.join(cwd, "hello.txt"), "hello\nworld\n");
    await writeFile(path.join(cwd, "new.txt"), "new");
    const s = await snapshot(cwd);
    assert.equal(s.branch, "main");
    assert.equal(s.dirty, true);
    assert.deepEqual(s.changed, ["hello.txt"]);
    assert.deepEqual(s.untracked, ["new.txt"]);
    assert.equal(s.insertions, 1);
    assert.match(await diff(cwd), /\+world/);
    await symlink("/etc", path.join(cwd, "escape"));
    await assert.rejects(containedPath(cwd, "escape/hosts"), /escapes/);
    await assert.rejects(containedPath(cwd, "../outside"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("git policy fails closed", () => {
  assert.throws(() => validateGitPolicy({ kind: "commit", message: "x" }, []));
  assert.throws(() => validateGitPolicy({ kind: "reset" } as never, ["reset"]));
  assert.throws(() =>
    validateGitPolicy({ kind: "branch", name: "--evil" }, ["branch"]),
  );
  validateGitPolicy({ kind: "branch", name: "feature/valid" }, ["branch"]);
});
