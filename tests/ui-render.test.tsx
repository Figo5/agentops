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
  assert.match(output, /31\/31 render checks passed/);
  assert.match(output, /ok - first-run empty state offers one useful action/);
  assert.match(
    output,
    /ok - dashboard groups runs into needs you, running and recent sections/,
  );
  assert.match(
    output,
    /ok - empty categories are not rendered as placeholder sections/,
  );
  assert.match(
    output,
    /ok - needs-you rows carry one persisted evidence line, or say why not/,
  );
  assert.match(
    output,
    /ok - the sidebar navigates and names blocked projects, with no inventory/,
  );
  assert.match(
    output,
    /ok - the shell renders no footer inventory and no duplicate home title/,
  );
  assert.match(
    output,
    /ok - a row states its evidence, its loading state or its failure/,
  );
  assert.match(
    output,
    /ok - the app shell renders its navigation and loading state/,
  );
  assert.match(
    output,
    /ok - tabs use a roving tabindex and every aria-controls has a panel/,
  );
  assert.match(
    output,
    /ok - approval evidence precedes the decision buttons and gates the reason/,
  );
  assert.match(output, /ok - the final acceptance gate offers Accept run/);
  // Pass 3 run-screen behaviour.
  assert.match(
    output,
    /ok - stage progress is compact and its chronology is folded/,
  );
  assert.match(
    output,
    /ok - the run state headline is the semantic sentence, not the enum/,
  );
  assert.match(
    output,
    /ok - activity lists lifecycle sentences, not output frames/,
  );
  assert.match(
    output,
    /ok - verification leads with command rows and folds the raw output/,
  );
  assert.match(
    output,
    /ok - a passed command with unparsed counts still reads as passed/,
  );
  assert.match(
    output,
    /ok - review leads with reviewer and findings, prose one level down/,
  );
  assert.match(
    output,
    /ok - overview keeps the outcome, the audit and the run's assets/,
  );
  assert.match(
    output,
    /ok - overview leads with recent activity and leaves the live state to the header/,
  );
  assert.match(
    output,
    /ok - the operator input gate asks the question next to the answer/,
  );
  // Pass 5 management surfaces.
  assert.match(
    output,
    /ok - the projects view leads with the project, not with its settings form/,
  );
  assert.match(
    output,
    /ok - agent rows are configuration rows with an accessible edit name/,
  );
  assert.match(
    output,
    /ok - history offers quick filters and never prints a raw query string/,
  );
  assert.match(output, /ok - the guided workflow starts at step one of five/);
  assert.match(
    output,
    /ok - settings are device-local, applied, and honest about the service/,
  );
  assert.match(
    output,
    /ok - the shell carries the settings route in its navigation/,
  );
  // Pass 6 polish.
  assert.match(
    output,
    /ok - a failed run leads with the recorded reason, not a record table/,
  );
});
