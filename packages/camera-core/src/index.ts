export {
  defaultCameraPathInterpolator,
  SmoothCameraPathInterpolator,
  type CameraPathInterpolator,
} from "./interpolation.js";
export {
  focalLengthToVerticalFov,
  getCameraFraming,
  cameraProjection,
  fitComposition,
  SENSOR_PRESETS,
  type SensorPreset,
  type CameraFraming,
  type SensorPresetName,
} from "./sensors.js";
export {
  createSpeedCurvePreset,
  sampleSpeedCurve,
  speedCurveProgress,
  type CameraSpeedCurvePreset,
} from "./speedCurve.js";
export {
  APERTURE_STOPS,
  clampFocal,
  formatFStop,
  lensAllowsZoom,
  lensLabel,
  nearestStop,
  rollDegrees,
  withRoll,
} from "./lens.js";
export {
  appendKeyframe,
  clampShotDuration,
  DEFAULT_KEYFRAME_GAP_SECONDS,
  KEYFRAME_TIME_TOLERANCE,
  keyframeFromRig,
  keyframeIndexAt,
  MIN_KEYFRAME_GAP_SECONDS,
  removeKeyframe,
  retimeShot,
  setKeyframeAt,
  setKeyframeTime,
  setSegmentSpeed,
  setShotLens,
  shotAsPath,
  shotCameraAt,
  shotSegmentAt,
  ShotEditError,
  updateKeyframe,
} from "./shot.js";
export type {
  CameraPath,
  CameraPathKeyframe,
  CameraPose,
  CameraSpeedCurve,
  CameraSpeedPoint,
  CinematicCamera,
} from "@oculo/scene-schema";
