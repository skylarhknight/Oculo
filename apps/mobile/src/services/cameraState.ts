import { getCameraFraming } from "@oculo/camera-core";
import type { CameraState } from "@oculo/scene-core";
import type { CinematicCamera } from "@oculo/scene-schema";

export function toCameraState(camera: CinematicCamera): CameraState {
  const framing = getCameraFraming(camera);
  return {
    position: [...camera.pose.position],
    quaternion: [...camera.pose.quaternion],
    verticalFovDegrees: framing.verticalFovDegrees,
    aspectRatio: framing.aspectRatio,
    near: camera.near,
    far: camera.far,
  };
}

export function fromCameraState(state: CameraState, current: CinematicCamera): CinematicCamera {
  const camera = {
    ...current,
    output: { aspectRatio: state.aspectRatio, crop: "center-inside-sensor" as const },
  };
  return {
    ...camera,
    pose: { position: [...state.position], quaternion: [...state.quaternion] },
    focalLengthMm:
      getCameraFraming(camera).effectiveSensorHeightMm /
      (2 * Math.tan((state.verticalFovDegrees * Math.PI) / 360)),
    near: state.near,
    far: state.far,
  };
}

export function aspectLabel(aspect: number): string {
  for (const [label, value] of [
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["9:16", 9 / 16],
  ] as const) {
    if (Math.abs(aspect - value) < 0.001) return label;
  }
  return `${Number(aspect.toFixed(2))}:1`;
}
