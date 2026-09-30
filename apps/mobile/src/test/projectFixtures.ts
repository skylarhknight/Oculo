import {
  applySceneWorkspace,
  migrateSavedShot,
  parseProject,
  shotKeyframeFromCamera,
  shotSetupFromCamera,
  type CameraSpeedCurve,
  type CinematicCamera,
  sceneWorkspace,
  type CameraPath,
  type SavedShot,
} from "@oculo/scene-schema";
import type { Project, SceneWorkspace, Shot } from "../types/project";

/** The single-scene (schema v2) document shape older fixtures and stored rows use. */
export type SingleSceneDocument = Omit<
  SceneWorkspace,
  "projectSceneId" | "projectSceneName" | "shots"
> & {
  schemaVersion: 2;
  durationSeconds: number;
  shots: SavedShot[];
  path: CameraPath;
};

/**
 * Migrates a single-scene fixture exactly as the store migrates a stored v2 row: stills
 * become static shots and a path with two or more keyframes becomes a moving shot.
 */
export const migrated = (document: SingleSceneDocument | Record<string, unknown>): Project =>
  parseProject(structuredClone(document));

/** The editing view of a project's first scene. */
export const firstScene = (project: Project): SceneWorkspace =>
  sceneWorkspace(project, project.scenes[0]!.id);

/** Edits a project's first scene through its workspace view. */
export const editFirstScene = (
  project: Project,
  edit: (workspace: SceneWorkspace) => SceneWorkspace,
): Project => applySceneWorkspace(project, edit(firstScene(project)));

/** A static shot from a camera, written the way a pre-v4 still was. */
export const shotFrom = (still: Omit<SavedShot, "createdAt"> & { createdAt?: string }): Shot =>
  migrateSavedShot({ createdAt: "2026-08-12T08:00:00.000Z", ...still } as SavedShot);

/** A moving shot through these cameras; a changing focal length makes it a zoom lens. */
export function movingShot(
  ref: { sceneId: string; assetVersionId: string },
  frames: {
    timeSeconds: number;
    camera: CinematicCamera;
    speedCurve?: CameraSpeedCurve | undefined;
  }[],
  { id = "move", durationSeconds = frames.at(-1)!.timeSeconds } = {},
): Shot {
  const focals = frames.map((frame) => frame.camera.focalLengthMm);
  const min = Math.min(...focals);
  const max = Math.max(...focals);
  return {
    id,
    sceneId: ref.sceneId,
    assetVersionId: ref.assetVersionId,
    name: "Camera move",
    createdAt: "2026-08-12T08:00:00.000Z",
    durationSeconds,
    setup: shotSetupFromCamera(
      frames[0]!.camera,
      max > min
        ? { kind: "zoom", minFocalLengthMm: min, maxFocalLengthMm: max }
        : { kind: "prime", focalLengthMm: min },
    ),
    keyframes: frames.map((frame, index) => ({
      ...shotKeyframeFromCamera(`${id}-k${index}`, frame.timeSeconds, frame.camera),
      ...(frame.speedCurve ? { speedCurve: frame.speedCurve } : {}),
    })),
  };
}
