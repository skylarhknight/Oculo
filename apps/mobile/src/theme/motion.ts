/**
 * Motion values live in tokens.css. JavaScript reads them from the document so
 * timing is never duplicated, and reduced motion applies everywhere at once.
 */
export type DurationToken =
  "--dur-instant" | "--dur-fast" | "--dur-base" | "--dur-slow" | "--dur-sheet" | "--dur-reveal";

export function durationMs(token: DurationToken): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith("ms") ? value : value * 1000;
}

export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Reflects the in-app accessibility preference onto the token layer. */
export function setReducedMotionPreference(reduce: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.reduceMotion = String(reduce);
}
