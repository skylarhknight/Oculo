import type { PlanOverlayState } from "@oculo/scene-core";
import { toCameraState } from "../../services/cameraState";
import { readToken } from "../../theme/tokens";
import { shotStartCamera } from "@oculo/scene-schema";
import { shotCameraAt } from "@oculo/camera-core";
import type { SceneWorkspace, Shot } from "../../types/project";

const PATH_SAMPLES = 48;

/**
 * A frustum at the start of every shot, and the sampled path of the moving shot being
 * edited (or else the selected one).
 */
export function planOverlayState(
  project: Pick<SceneWorkspace, "shots">,
  selectedId: string | undefined,
  activeShot?: Shot | null,
): PlanOverlayState {
  const moving = activeShot ?? project.shots.find((shot) => shot.id === selectedId) ?? undefined;
  const path =
    moving && moving.keyframes.length > 1
      ? Array.from({ length: PATH_SAMPLES + 1 }, (_, index) => {
          const time = (index / PATH_SAMPLES) * moving.durationSeconds;
          return [...shotCameraAt(moving, time).pose.position] as [number, number, number];
        })
      : [];
  return {
    markers: project.shots.map((shot) => {
      const state = toCameraState(shotStartCamera(shot));
      return {
        id: shot.id,
        position: state.position,
        quaternion: state.quaternion,
        verticalFovDegrees: state.verticalFovDegrees,
        aspectRatio: state.aspectRatio,
      };
    }),
    ...(selectedId ? { selectedId } : {}),
    path,
    style: {
      markerColor: readToken("--color-overlay-marker", "#ffffff"),
      selectedColor: readToken("--color-accent", "#0a84ff"),
      pathColor: readToken("--color-overlay-path", "#ff9f0a"),
    },
  };
}
