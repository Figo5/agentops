/**
 * UI source integrity test.
 *
 * This is not a browser test and does not pretend to be one. It verifies the
 * things that can be checked without a DOM or React types installed:
 *
 *  1. Every file under src/ui transforms with esbuild in JSX-automatic mode, so
 *     syntax errors and broken JSX fail here rather than at build time.
 *  2. Every relative import resolves to a real file, using the same
 *     .js -> .ts/.tsx substitution that Vite and tsx perform.
 *  3. Bare imports are limited to react / react-dom, so the UI cannot quietly
 *     acquire a runtime dependency outside the ones the root installs.
 *  4. No alert/confirm/prompt dialogs are used anywhere in the UI sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(root, "src", "ui");
const ALLOWED_BARE = new Set([
  "react",
  "react-dom/client",
  "react/jsx-runtime",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
  ];
  for (const candidate of candidates) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile())
      return candidate;
  }
  return null;
}

/** Strips comments so prose about dialogs cannot be mistaken for a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Import specifiers only. Anchored to line starts so a JSX attribute such as
 * `label="Created from"` cannot be mistaken for an import.
 */
function importSpecifiers(source: string): string[] {
  const cleaned = stripComments(source);
  const patterns = [
    /^[ \t]*(?:import|export)\b[^'"\n]*?from[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*(?:import|export)[ \t]*['"]([^'"]+)['"]/gm,
    /^[ \t]*\}[ \t]*from[ \t]*['"]([^'"]+)['"]/gm,
    /import\([ \t]*['"]([^'"]+)['"][ \t]*\)/g,
  ];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

const files = walk(uiDir);

test("every UI source transforms and resolves its imports", () => {
  assert.ok(
    files.length >= 12,
    `expected the full UI surface, found ${files.length} files`,
  );
  const failures: string[] = [];
  let importCount = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    try {
      transformSync(source, {
        loader: path.extname(file) === ".tsx" ? "tsx" : "ts",
        jsx: "automatic",
        target: "es2022",
      });
    } catch (error) {
      failures.push(
        `${path.relative(root, file)}: syntax error: ${(error as Error).message}`,
      );
      continue;
    }
    for (const specifier of importSpecifiers(source)) {
      importCount += 1;
      if (specifier.startsWith(".")) {
        if (!resolveSpecifier(file, specifier))
          failures.push(
            `${path.relative(root, file)}: unresolved import "${specifier}"`,
          );
      } else if (!ALLOWED_BARE.has(specifier)) {
        failures.push(
          `${path.relative(root, file)}: unexpected bare import "${specifier}"`,
        );
      }
    }
  }

  assert.deepEqual(failures, []);
  assert.ok(
    importCount > 40,
    `expected a connected import graph, saw ${importCount} specifiers`,
  );
});

test("the UI never uses blocking browser dialogs", () => {
  const offenders = files.filter((file) =>
    /\b(window\.)?(alert|confirm|prompt)\s*\(/.test(
      stripComments(readFileSync(file, "utf8")),
    ),
  );
  assert.deepEqual(
    offenders.map((file) => path.relative(root, file)),
    [],
  );
});

test("the UI contains no hard-coded sample runs, agents or fixture data", () => {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Sample-data smells: literals that would fabricate persisted records.
    if (/const\s+(SAMPLE|FAKE|MOCK)_(RUNS|AGENTS|PROJECTS)/i.test(source))
      offenders.push(path.relative(root, file));
    if (/example\.com|placeholder\.invalid|sample-run/i.test(source))
      offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
