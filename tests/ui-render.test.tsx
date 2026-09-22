/**
 * Render tests for the UI components.
 *
 * The actual rendering happens in `ui-render.child.tsx`, executed as a child
 * process with `TSX_TSCONFIG_PATH` pointing at `src/ui/tsconfig.json`. That is
 * required because `tsx` takes JSX settings from the tsconfig of the working
 * directory (the repo root has none), while Vite compiles the UI with jsx:
 * react-jsx. Running the child reproduces the browser build's JSX transform
 * without adding compatibility imports to production files.
 *
 * These are server-rendered markup assertions: no DOM, no browser automation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const child = path.join(root, "tests", "ui-render.child.tsx");
const uiTsconfig = path.join(root, "src", "ui", "tsconfig.json");

test("UI components render real markup (server-rendered, no DOM)", () => {
  assert.ok(existsSync(child), `render harness is missing: ${child}`);
  assert.ok(existsSync(uiTsconfig), `UI tsconfig is missing: ${uiTsconfig}`);

  const result = spawnSync(process.execPath, ["--import", "tsx", child], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TSX_TSCONFIG_PATH: uiTsconfig },
    timeout: 120_000,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, `render harness failed:\n${output}`);
  assert.match(output, /6\/6 render checks passed/);
  assert.match(output, /ok - first-run empty state/);
  assert.match(
    output,
    /ok - the stage rail renders the review branch as a branch/,
  );
  assert.match(
    output,
    /ok - the app shell renders its navigation and loading state/,
  );
});
