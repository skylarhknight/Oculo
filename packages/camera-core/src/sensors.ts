export interface SensorPreset {
  readonly id: string;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export const SENSOR_PRESETS = {
  fullFrame: {
    id: "full-frame",
    label: "Full Frame 35mm",
    widthMm: 36,
    heightMm: 24,
  },
  super35: {
    id: "super-35",
    label: "Super 35",
    widthMm: 24.89,
    heightMm: 18.66,
  },
  apsc: {
    id: "aps-c",
    label: "APS-C",
    widthMm: 23.6,
    heightMm: 15.7,
  },
  microFourThirds: {
    id: "micro-four-thirds",
    label: "Micro Four Thirds",
    widthMm: 17.3,
    heightMm: 13,
  },
  oneInch: {
    id: "one-inch",
    label: '1" Type',
    widthMm: 13.2,
    heightMm: 8.8,
  },
} as const satisfies Record<string, SensorPreset>;

export type SensorPresetName = keyof typeof SENSOR_PRESETS;

export interface CameraFraming {
  aspectRatio: number;
  verticalFovDegrees: number;
  effectiveSensorHeightMm: number;
}

/** Center-crop the sensor to the requested output aspect without stretching. */
export function getCameraFraming(camera: CinematicCamera): CameraFraming {
  for (const value of [camera.sensorWidthMm, camera.sensorHeightMm, camera.output.aspectRatio]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError("Sensor dimensions and output aspect must be finite and positive");
  }
  const effectiveSensorHeightMm = Math.min(
    camera.sensorHeightMm,
    camera.sensorWidthMm / camera.output.aspectRatio,
  );
  return {
    aspectRatio: camera.output.aspectRatio,
    verticalFovDegrees: focalLengthToVerticalFov(camera.focalLengthMm, effectiveSensorHeightMm),
    effectiveSensorHeightMm,
  };
}

export function focalLengthToVerticalFov(focalLengthMm: number, sensorHeightMm: number): number {
  if (!Number.isFinite(focalLengthMm) || focalLengthMm <= 0) {
    throw new RangeError("focalLengthMm must be a finite value greater than zero");
  }
  if (!Number.isFinite(sensorHeightMm) || sensorHeightMm <= 0) {
    throw new RangeError("sensorHeightMm must be a finite value greater than zero");
  }

  return (2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)) * 180) / Math.PI;
}
import { CinematicCameraSchema, type CinematicCamera } from "@oculo/scene-schema";

/** Largest centered sensor rectangle with the requested output aspect ratio. */
export function cameraProjection(value: CinematicCamera): {
  sensorWidthMm: number;
  sensorHeightMm: number;
  aspectRatio: number;
  verticalFovDegrees: number;
} {
  const camera = CinematicCameraSchema.parse(value);
  const aspectRatio = camera.output.aspectRatio;
  const sensorWidthMm = Math.min(camera.sensorWidthMm, camera.sensorHeightMm * aspectRatio);
  const sensorHeightMm = sensorWidthMm / aspectRatio;
  return {
    sensorWidthMm,
    sensorHeightMm,
    aspectRatio,
    verticalFovDegrees: focalLengthToVerticalFov(camera.focalLengthMm, sensorHeightMm),
  };
}

/** Fit the whole output frame into a viewport, never change the lens to fill it. */
export function fitComposition(width: number, height: number, aspectRatio: number) {
  const frameWidth = Math.min(Math.max(1, width), Math.max(1, height) * aspectRatio);
  return { width: frameWidth, height: frameWidth / aspectRatio };
}
