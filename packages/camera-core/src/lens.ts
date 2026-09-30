import { lensFocalRange, type CameraPose, type ShotLens } from "@oculo/scene-schema";
import { Quaternion, Vector3 } from "three";

/** Standard full stops, as marked on a cine lens barrel. */
export const APERTURE_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22] as const;

export function clampFocal(lens: ShotLens, focalLengthMm: number): number {
  const { min, max } = lensFocalRange(lens);
  return Math.min(max, Math.max(min, focalLengthMm));
}

export const lensAllowsZoom = (lens: ShotLens): boolean => lens.kind === "zoom";

const mm = (value: number) => `${Math.round(value * 10) / 10}mm`;

export function lensLabel(lens: ShotLens): string {
  return lens.kind === "prime"
    ? `${mm(lens.focalLengthMm)} prime`
    : `${Math.round(lens.minFocalLengthMm * 10) / 10}–${mm(lens.maxFocalLengthMm)} zoom`;
}

export const formatFStop = (fStop: number): string => `f/${Math.round(fStop * 10) / 10}`;

/** The nearest full stop, measured in stops rather than f-number. */
export function nearestStop(fStop: number): number {
  let best: number = APERTURE_STOPS[0];
  for (const stop of APERTURE_STOPS) {
    if (Math.abs(Math.log2(stop / fStop)) < Math.abs(Math.log2(best / fStop))) best = stop;
  }
  return best;
}

const FORWARD = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Dutch angle in degrees: how far the camera's up axis is turned about its viewing axis
 * from level. Positive tilts the horizon clockwise as seen through the camera. Looking
 * straight up or down has no horizon and reports 0.
 */
export function rollDegrees(quaternionTuple: CameraPose["quaternion"]): number {
  const q = new Quaternion(...quaternionTuple).normalize();
  const forward = FORWARD.clone().applyQuaternion(q);
  const level = WORLD_UP.clone().addScaledVector(forward, -WORLD_UP.dot(forward));
  if (level.lengthSq() < 1e-8) return 0;
  level.normalize();
  const up = UP.clone().applyQuaternion(q);
  const angle = Math.atan2(forward.dot(new Vector3().crossVectors(level, up)), level.dot(up));
  return (-angle * 180) / Math.PI;
}

/** Sets the dutch angle while keeping the viewing direction. */
export function withRoll(
  quaternionTuple: CameraPose["quaternion"],
  degrees: number,
): CameraPose["quaternion"] {
  const q = new Quaternion(...quaternionTuple).normalize();
  const forward = FORWARD.clone().applyQuaternion(q);
  const delta = ((rollDegrees(quaternionTuple) - degrees) * Math.PI) / 180;
  const next = new Quaternion().setFromAxisAngle(forward, delta).multiply(q).normalize();
  return [next.x, next.y, next.z, next.w];
}
