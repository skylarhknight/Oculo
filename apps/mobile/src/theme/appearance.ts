import type { AppPreferences } from "@oculo/scene-schema";

export type AppearancePreference = AppPreferences["appearance"];
export type ResolvedAppearance = "light" | "dark";

/** Remembered for the first paint, before preferences load from IndexedDB. */
export const APPEARANCE_STORAGE_KEY = "oculo.appearance";

const THEME_COLORS: Record<ResolvedAppearance, string> = {
  light: "#f2f2f7",
  dark: "#000000",
};

const systemQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;

export function resolveAppearance(preference: AppearancePreference): ResolvedAppearance {
  if (preference !== "system") return preference;
  return systemQuery()?.matches ? "light" : "dark";
}

function paint(resolved: ResolvedAppearance): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.removeAttribute("media");
    meta.content = THEME_COLORS[resolved];
  }
}

/**
 * Applies the Appearance setting to the root element (see tokens.css) and, while it
 * matches the system, follows system changes. Returns a cleanup for the listener.
 */
export function applyAppearance(
  preference: AppearancePreference,
  onResolved?: (resolved: ResolvedAppearance) => void,
): () => void {
  if (typeof document === "undefined") return () => undefined;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable; the setting still applies for this session.
  }
  const update = () => {
    const resolved = resolveAppearance(preference);
    paint(resolved);
    onResolved?.(resolved);
  };
  update();
  const query = preference === "system" ? systemQuery() : undefined;
  query?.addEventListener?.("change", update);
  return () => query?.removeEventListener?.("change", update);
}
