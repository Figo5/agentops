/**
 * Device-local display preferences.
 *
 * The point of these tests is that the preference is real: it round-trips
 * through storage, it survives a malformed value, and — most importantly — the
 * resolved "reduced motion" answer is the same one CSS and the imperative
 * evidence-tab scroll read. The settings screen must never be a set of inert
 * controls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCES,
  DENSITY_ATTRIBUTE,
  MOTION_ATTRIBUTE,
  PREFERENCES_STORAGE_KEY,
  applyPreferences,
  readPreferences,
  resolveReducedMotion,
  sanitizePreferences,
  systemReducedMotion,
  writePreferences,
  type PreferenceStorage,
} from "../src/ui/preferences.js";

function memoryStorage(seed: Record<string, string> = {}): PreferenceStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** Minimal document root stand-in: `applyPreferences` only sets attributes. */
function fakeRoot(): {
  attributes: Record<string, string>;
  setAttribute(k: string, v: string): void;
} {
  const attributes: Record<string, string> = {};
  return {
    attributes,
    setAttribute(key: string, value: string) {
      attributes[key] = value;
    },
  };
}

test("preferences default to the documented values when nothing is stored", () => {
  const storage = memoryStorage();
  assert.deepEqual(readPreferences(storage), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
});

test("preferences round-trip through storage and merge on write", () => {
  const storage = memoryStorage();
  const first = writePreferences({ density: "compact" }, storage);
  assert.equal(first.persisted, true);
  assert.equal(first.preferences.density, "compact");
  assert.equal(first.preferences.reducedMotion, "system");

  const second = writePreferences(
    { reducedMotion: "reduce", logWrap: false },
    storage,
  );
  assert.equal(
    second.preferences.density,
    "compact",
    "unrelated keys are kept",
  );
  assert.equal(second.preferences.reducedMotion, "reduce");
  assert.equal(second.preferences.logWrap, false);

  assert.deepEqual(readPreferences(storage), second.preferences);
  assert.match(
    storage.data[PREFERENCES_STORAGE_KEY] ?? "",
    /"density":"compact"/,
  );
});

test("a malformed or hostile stored value falls back per field, never wholesale", () => {
  assert.deepEqual(sanitizePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(sanitizePreferences("nonsense"), DEFAULT_PREFERENCES);
  assert.deepEqual(
    sanitizePreferences({
      density: "tiny",
      reducedMotion: "warp",
      logWrap: "yes",
    }),
    DEFAULT_PREFERENCES,
  );
  const mixed = sanitizePreferences({ density: "compact", logWrap: false });
  assert.equal(mixed.density, "compact");
  assert.equal(mixed.logWrap, false);
  assert.equal(mixed.logTimestamps, true);
  assert.deepEqual(
    readPreferences(memoryStorage({ [PREFERENCES_STORAGE_KEY]: "{not json" })),
    DEFAULT_PREFERENCES,
  );
});

test("storage that refuses to persist is reported instead of silently ignored", () => {
  const refusing: PreferenceStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  const result = writePreferences({ logFollow: false }, refusing);
  assert.equal(result.persisted, false);
  assert.equal(
    result.preferences.logFollow,
    false,
    "the preference still applies",
  );
});

test("reduced motion resolves the device preference first, then the OS", () => {
  const reduceOs = () => ({ matches: true });
  const allowOs = () => ({ matches: false });

  // The default follows the OS.
  assert.equal(
    resolveReducedMotion(
      { ...DEFAULT_PREFERENCES, reducedMotion: "system" },
      reduceOs,
    ),
    true,
  );
  assert.equal(
    resolveReducedMotion(
      { ...DEFAULT_PREFERENCES, reducedMotion: "system" },
      allowOs,
    ),
    false,
  );
  // An explicit device preference wins in both directions.
  assert.equal(
    resolveReducedMotion(
      { ...DEFAULT_PREFERENCES, reducedMotion: "reduce" },
      allowOs,
    ),
    true,
  );
  assert.equal(
    resolveReducedMotion(
      { ...DEFAULT_PREFERENCES, reducedMotion: "full" },
      reduceOs,
    ),
    false,
  );
  // A media-query implementation that throws is not a crash.
  assert.equal(
    systemReducedMotion(() => {
      throw new Error("no matchMedia");
    }),
    false,
  );
  assert.equal(systemReducedMotion(null), false);
});

test("applying preferences writes the attributes CSS and imperative code read", () => {
  const root = fakeRoot();
  applyPreferences(
    { ...DEFAULT_PREFERENCES, density: "compact" },
    root as never,
  );
  assert.equal(root.attributes[DENSITY_ATTRIBUTE], "compact");
  // "system" on a machine that does not ask for reduction resolves to full.
  assert.equal(root.attributes[MOTION_ATTRIBUTE], "full");

  applyPreferences(
    { ...DEFAULT_PREFERENCES, reducedMotion: "system" },
    root as never,
    () => ({ matches: true }),
  );
  assert.equal(root.attributes[MOTION_ATTRIBUTE], "reduce");

  applyPreferences(
    { ...DEFAULT_PREFERENCES, reducedMotion: "full" },
    root as never,
    () => ({ matches: true }),
  );
  assert.equal(root.attributes[MOTION_ATTRIBUTE], "full");

  // Without a document (SSR, tests) this is a no-op rather than a throw.
  applyPreferences({ ...DEFAULT_PREFERENCES }, null);
});
