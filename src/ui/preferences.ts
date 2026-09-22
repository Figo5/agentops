/**
 * Device-local display preferences.
 *
 * AgentOps has no accounts, no cloud sync and no server-side settings: these
 * preferences belong to this browser on this machine and are stored in
 * `localStorage` only. Nothing here is sent to the server, and nothing here
 * invents a backend setting that does not exist.
 *
 * The module is deliberately DOM-light and dependency-free so it can be unit
 * tested under `node --test`: the storage and the media-query function are
 * injectable, and the *imperative* consumer (`revealRunTabs`) reads the same
 * resolved value the CSS uses, so "reduced motion" can never mean two different
 * things in two places.
 */

export type ReducedMotionMode = "system" | "reduce" | "full";
export type DisplayDensity = "comfortable" | "compact";

export interface DisplayPreferences {
  /** Comfortable spacing, or a denser list/row scale. */
  density: DisplayDensity;
  /** `system` follows the OS; `reduce`/`full` are explicit overrides. */
  reducedMotion: ReducedMotionMode;
  /** Wrap long raw-log lines instead of letting them run off. */
  logWrap: boolean;
  /** Show the per-line timestamp column in the raw log. */
  logTimestamps: boolean;
  /** Start the raw log in follow mode. */
  logFollow: boolean;
}

export const DEFAULT_PREFERENCES: DisplayPreferences = {
  density: "comfortable",
  reducedMotion: "system",
  logWrap: true,
  logTimestamps: true,
  logFollow: true,
};

export const PREFERENCES_STORAGE_KEY = "agentops.display.v1";
/** Broadcast to every mounted view after a preference is written. */
export const PREFERENCES_CHANGED_EVENT = "agentops:display-preferences";

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the persisted JSON, tolerating anything a user may have written. */
export function sanitizePreferences(value: unknown): DisplayPreferences {
  const raw = (value ?? {}) as Partial<
    Record<keyof DisplayPreferences, unknown>
  >;
  const density: DisplayDensity =
    raw.density === "compact" || raw.density === "comfortable"
      ? raw.density
      : DEFAULT_PREFERENCES.density;
  const reducedMotion: ReducedMotionMode =
    raw.reducedMotion === "reduce" ||
    raw.reducedMotion === "full" ||
    raw.reducedMotion === "system"
      ? raw.reducedMotion
      : DEFAULT_PREFERENCES.reducedMotion;
  const bool = (input: unknown, fallback: boolean): boolean =>
    typeof input === "boolean" ? input : fallback;
  return {
    density,
    reducedMotion,
    logWrap: bool(raw.logWrap, DEFAULT_PREFERENCES.logWrap),
    logTimestamps: bool(raw.logTimestamps, DEFAULT_PREFERENCES.logTimestamps),
    logFollow: bool(raw.logFollow, DEFAULT_PREFERENCES.logFollow),
  };
}

function defaultStorage(): PreferenceStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    /* Storage blocked (private mode, disabled): preferences stay in memory. */
    return null;
  }
}

export function readPreferences(
  storage: PreferenceStorage | null = defaultStorage(),
): DisplayPreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const stored = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PREFERENCES };
    return sanitizePreferences(JSON.parse(stored));
  } catch {
    /* Unreadable or malformed: fall back to the documented defaults. */
    return { ...DEFAULT_PREFERENCES };
  }
}

export interface PreferenceWriteResult {
  preferences: DisplayPreferences;
  /** `false` when the browser refused to persist (storage unavailable). */
  persisted: boolean;
}

/**
 * Merges a patch into the stored preferences, persists it and broadcasts the
 * change. A storage failure is reported instead of silently pretending the
 * preference was saved.
 */
export function writePreferences(
  patch: Partial<DisplayPreferences>,
  storage: PreferenceStorage | null = defaultStorage(),
): PreferenceWriteResult {
  const preferences = sanitizePreferences({
    ...readPreferences(storage),
    ...patch,
  });
  let persisted = false;
  if (storage) {
    try {
      storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
      persisted = true;
    } catch {
      persisted = false;
    }
  }
  return { preferences, persisted };
}

/** OS-level motion preference. Defaults to "no reduction" when unknown. */
export function systemReducedMotion(
  matchMediaFn:
    | ((query: string) => { matches: boolean })
    | null = typeof window !== "undefined"
    ? (query: string) => window.matchMedia(query)
    : null,
): boolean {
  if (!matchMediaFn) return false;
  try {
    return matchMediaFn("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The one answer every surface uses: an explicit device preference wins, and
 * `system` (the default) defers to the operating system.
 */
export function resolveReducedMotion(
  preferences: DisplayPreferences = readPreferences(),
  matchMediaFn?: ((query: string) => { matches: boolean }) | null,
): boolean {
  if (preferences.reducedMotion === "reduce") return true;
  if (preferences.reducedMotion === "full") return false;
  return systemReducedMotion(matchMediaFn);
}

/**
 * Imperative reader for code that runs outside React (the evidence-tab scroll):
 * prefers the applied DOM attribute, then the stored preference, then the OS.
 */
export function reducedMotionNow(): boolean {
  if (typeof document !== "undefined") {
    const applied = document.documentElement?.dataset?.["reducedMotion"];
    if (applied === "reduce") return true;
    if (applied === "full") return false;
  }
  return resolveReducedMotion();
}

export const DENSITY_ATTRIBUTE = "data-density";
export const MOTION_ATTRIBUTE = "data-reduced-motion";

/**
 * Applies the preferences to the document so CSS and imperative code agree.
 * Called on mount and on every change; safe to run without a DOM (SSR/tests).
 */
export function applyPreferences(
  preferences: DisplayPreferences,
  root: HTMLElement | null = typeof document !== "undefined"
    ? document.documentElement
    : null,
  matchMediaFn?: ((query: string) => { matches: boolean }) | null,
): void {
  if (!root) return;
  const motion = resolveReducedMotion(preferences, matchMediaFn)
    ? "reduce"
    : "full";
  root.setAttribute(DENSITY_ATTRIBUTE, preferences.density);
  root.setAttribute(MOTION_ATTRIBUTE, motion);
}

/** Notifies every mounted view that the preferences changed. */
export function broadcastPreferences(preferences: DisplayPreferences): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DisplayPreferences>(PREFERENCES_CHANGED_EVENT, {
      detail: preferences,
    }),
  );
}

/** Subscribes to cross-view preference changes. Returns an unsubscribe. */
export function subscribePreferences(
  listener: (preferences: DisplayPreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<DisplayPreferences>).detail;
    listener(sanitizePreferences(detail ?? readPreferences()));
  };
  window.addEventListener(PREFERENCES_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, handler);
}

/** Subscribes to OS motion changes, so `system` keeps tracking the OS. */
export function subscribeSystemMotion(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (typeof query.addEventListener !== "function") return () => undefined;
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
