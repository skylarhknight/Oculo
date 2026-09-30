import type {
  CinematicCamera,
  SceneDescriptor,
  Shot,
  ShotKeyframe,
  ShotLens,
  ShotSetup,
} from "@oculo/scene-schema";

export type { CinematicCamera, SceneDescriptor, Shot, ShotKeyframe, ShotLens, ShotSetup };

export type {
  Project,
  ProjectScene,
  ProjectSettings,
  SceneWorkspace,
} from "@oculo/scene-schema";

export const DEFAULT_CAMERA: CinematicCamera = {
  pose: {
    position: [0, 1.4, 4.2],
    quaternion: [0, 0, 0, 1],
  },
  focalLengthMm: 35,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" as const },
  near: 0.01,
  far: 1000,
};

export function cloneCamera(camera: CinematicCamera): CinematicCamera {
  return {
    ...camera,
    output: { ...camera.output },
    pose: {
      position: [...camera.pose.position],
      quaternion: [...camera.pose.quaternion],
    },
  };
}
