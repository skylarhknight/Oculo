import {
  MAX_SPEED_CURVE_POINTS,
  MAX_SPEED_WEIGHT,
  type CameraSpeedCurve,
  type CameraSpeedPoint,
} from "@oculo/scene-schema";

export type CameraSpeedCurvePreset = "constant" | "ease-in" | "ease-out" | "ease-in-out";

function normalizedTime(time: number): number {
  if (!Number.isFinite(time)) throw new RangeError("Speed curve time must be finite");
  return Math.max(0, Math.min(1, time));
}

/** Runtime callers can bypass persistence validation; malformed curves stay linear. */
function validPoints(curve: CameraSpeedCurve | undefined): CameraSpeedPoint[] | undefined {
  if (
    !curve ||
    curve.version !== 1 ||
    !Array.isArray(curve.points) ||
    curve.points.length < 2 ||
    curve.points.length > MAX_SPEED_CURVE_POINTS
  ) {
    return undefined;
  }

  let hasMotion = false;
  let previousTime = -1;
  for (const point of curve.points) {
    if (
      !point ||
      !Number.isFinite(point.time) ||
      point.time < 0 ||
      point.time > 1 ||
      point.time <= previousTime ||
      !Number.isFinite(point.speed) ||
      point.speed < 0 ||
      point.speed > MAX_SPEED_WEIGHT ||
      !Number.isFinite(point.intensity) ||
      point.intensity < 0 ||
      point.intensity > 1
    ) {
      return undefined;
    }
    previousTime = point.time;
    hasMotion ||= point.speed > 0;
  }

  return hasMotion && curve.points[0]!.time === 0 && curve.points.at(-1)!.time === 1
    ? curve.points
    : undefined;
}

/** Coefficients in segment-local time, with tangents bounded by its speed change. */
function coefficients(from: CameraSpeedPoint, to: CameraSpeedPoint, scale = 1) {
  const startSpeed = from.speed / scale;
  const difference = to.speed / scale - startSpeed;
  return {
    a: -difference * (from.intensity + to.intensity),
    b: difference * (2 * from.intensity + to.intensity),
    c: difference * (1 - from.intensity),
    d: startSpeed,
  };
}

function segmentArea(coeffs: ReturnType<typeof coefficients>, time: number): number {
  const { a, b, c, d } = coeffs;
  return time * (d + time * (c / 2 + time * (b / 3 + (time * a) / 4)));
}

/** Relative speed shown on the editor graph; its area determines motion timing. */
export function sampleSpeedCurve(curve: CameraSpeedCurve, time: number): number {
  const t = normalizedTime(time);
  const points = validPoints(curve);
  if (!points) return 1;
  if (t === 0) return points[0]!.speed;
  if (t === 1) return points.at(-1)!.speed;

  const toIndex = points.findIndex((point) => point.time >= t);
  const from = points[toIndex - 1]!;
  const to = points[toIndex]!;
  const localT = (t - from.time) / (to.time - from.time);
  const { a, b, c, d } = coefficients(from, to);
  const speed = d + localT * (c + localT * (b + localT * a));
  // Guard against floating-point drift at extrema, including zero-speed holds.
  return Math.max(Math.min(from.speed, to.speed), Math.min(Math.max(from.speed, to.speed), speed));
}

/**
 * Integrates relative speed exactly and normalizes the area to reach the next
 * keyframe on time. Missing curves retain the original linear interpolation.
 */
export function speedCurveProgress(curve: CameraSpeedCurve | undefined, time: number): number {
  const t = normalizedTime(time);
  if (t === 0 || t === 1) return t;
  const points = validPoints(curve);
  if (!points) return t;

  // Scaling cancels in the area ratio and keeps arbitrarily small weights usable.
  const scale = Math.max(...points.map((point) => point.speed));
  let totalArea = 0;
  let elapsedArea = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const duration = to.time - from.time;
    const coeffs = coefficients(from, to, scale);
    const fullArea = duration * segmentArea(coeffs, 1);
    totalArea += fullArea;
    if (t >= to.time) {
      elapsedArea += fullArea;
    } else if (t > from.time) {
      elapsedArea += duration * segmentArea(coeffs, (t - from.time) / duration);
    }
  }

  return totalArea > 0 ? Math.max(0, Math.min(1, elapsedArea / totalArea)) : t;
}

/** Every call returns independent points so editing a preset cannot change others. */
export function createSpeedCurvePreset(preset: CameraSpeedCurvePreset): CameraSpeedCurve {
  switch (preset) {
    case "constant":
      return {
        version: 1,
        points: [
          { time: 0, speed: 1, intensity: 0 },
          { time: 1, speed: 1, intensity: 0 },
        ],
      };
    case "ease-in":
      return {
        version: 1,
        points: [
          { time: 0, speed: 0, intensity: 1 },
          { time: 1, speed: 2, intensity: 1 },
        ],
      };
    case "ease-out":
      return {
        version: 1,
        points: [
          { time: 0, speed: 2, intensity: 1 },
          { time: 1, speed: 0, intensity: 1 },
        ],
      };
    case "ease-in-out":
      return {
        version: 1,
        points: [
          { time: 0, speed: 0, intensity: 1 },
          { time: 0.5, speed: 2, intensity: 1 },
          { time: 1, speed: 0, intensity: 1 },
        ],
      };
  }
}
