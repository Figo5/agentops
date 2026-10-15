/**
 * Motion preference.
 *
 * The field is the only animated surface in this app, so this is the only
 * preference it has. It is read from the operating system rather than stored:
 * there is no settings screen to disagree with, and nothing to sync.
 */

/** True when the operator has asked for reduced motion. Defaults to false. */
export function reducedMotionNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // A browser that cannot answer is treated as "no reduction": the field
    // still renders, it simply animates.
    return false;
  }
}

/** Calls `listener` whenever the OS motion preference changes. */
export function subscribeSystemMotion(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => {};
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
