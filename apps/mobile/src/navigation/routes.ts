export type SceneStage = "shots" | "compose" | "export";

export type Route =
  | { name: "gallery" }
  | { name: "settings" }
  | { name: "project"; projectId: string }
  /** The scene gallery: starts a new project, or adds a scene to `projectId`. */
  | { name: "scenes"; projectId?: string }
  | {
      name: "scene";
      projectId: string;
      sceneId: string;
      stage: SceneStage;
      /** A shot to open in the editor on arrival. */
      shotId?: string;
    }
  | { name: "shotplan"; projectId: string; sceneId: string };

export type RouteName = Route["name"];

/**
 * Screens that are never kept mounted underneath another screen. Scene screens own a
 * WebGL renderer (at most one may be alive, and the gallery preview owns one too); the
 * shot plan reloads after scene edits.
 */
export const HEAVY_ROUTES: ReadonlySet<RouteName> = new Set(["scene", "shotplan", "scenes"]);

/** Screens whose content is a full-bleed viewport; edge swipe would fight orbit gestures. */
export const SWIPE_BACK_DISABLED: ReadonlySet<RouteName> = new Set(["scene", "shotplan"]);
