/** Reads a design token for code that cannot use CSS directly (for example WebGL materials). */
export function readToken(name: `--${string}`, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
