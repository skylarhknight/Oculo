import { describe, expect, it } from "vitest";
import type { CameraSpeedCurve } from "@oculo/scene-schema";

import { createSpeedCurvePreset, sampleSpeedCurve, speedCurveProgress } from "../src/speedCurve.js";

function ramp(intensity: number): CameraSpeedCurve {
  return {
    version: 1,
    points: [
      { time: 0, speed: 0, intensity },
      { time: 1, speed: 2, intensity },
    ],
  };
}

describe("camera speed curves", () => {
  it("preserves exact linear timing for absent and constant curves", () => {
    const constant = createSpeedCurvePreset("constant");
    for (const time of [0, 0.1, 0.25, 0.5, 0.8, 0.99, 1]) {
      expect(speedCurveProgress(undefined, time)).toBe(time);
      expect(speedCurveProgress(constant, time)).toBe(time);
      expect(sampleSpeedCurve(constant, time)).toBe(1);
    }
  });

  it("integrates a linear speed ramp instead of mistaking speed for progress", () => {
    for (const time of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      expect(sampleSpeedCurve(ramp(0), time)).toBeCloseTo(2 * time, 12);
      expect(speedCurveProgress(ramp(0), time)).toBeCloseTo(time ** 2, 12);
    }
  });

  it("integrates smooth speed ramps analytically and changes timing with intensity", () => {
    for (const time of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      expect(sampleSpeedCurve(ramp(1), time)).toBeCloseTo(6 * time ** 2 - 4 * time ** 3, 12);
      expect(speedCurveProgress(ramp(1), time)).toBeCloseTo(2 * time ** 3 - time ** 4, 12);
    }
    expect(speedCurveProgress(ramp(0), 0.5)).toBeCloseTo(0.25, 12);
    expect(speedCurveProgress(ramp(0.5), 0.5)).toBeCloseTo(0.21875, 12);
    expect(speedCurveProgress(ramp(1), 0.5)).toBeCloseTo(0.1875, 12);
  });

  it("normalizes area when points have different intensities", () => {
    const curve = ramp(0);
    curve.points[1]!.intensity = 1;
    expect(speedCurveProgress(curve, 0.5)).toBeCloseTo(29 / 112, 12);
    expect(speedCurveProgress(curve, 1)).toBe(1);
  });

  it("integrates unevenly spaced points using their segment duration", () => {
    const curve: CameraSpeedCurve = {
      version: 1,
      points: [
        { time: 0, speed: 0, intensity: 0 },
        { time: 0.25, speed: 2, intensity: 0 },
        { time: 1, speed: 2, intensity: 0 },
      ],
    };
    expect(sampleSpeedCurve(curve, 0.125)).toBe(1);
    expect(speedCurveProgress(curve, 0.125)).toBeCloseTo(1 / 28, 12);
    expect(speedCurveProgress(curve, 0.25)).toBeCloseTo(1 / 7, 12);
    expect(speedCurveProgress(curve, 0.5)).toBeCloseTo(3 / 7, 12);
  });

  it("makes a flat zero-speed interval hold the camera while preserving arrival time", () => {
    const curve: CameraSpeedCurve = {
      version: 1,
      points: [
        { time: 0, speed: 2, intensity: 1 },
        { time: 0.3, speed: 0, intensity: 1 },
        { time: 0.7, speed: 0, intensity: 1 },
        { time: 1, speed: 2, intensity: 1 },
      ],
    };
    for (const time of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      expect(sampleSpeedCurve(curve, time)).toBe(0);
      expect(speedCurveProgress(curve, time)).toBeCloseTo(0.5, 12);
    }
    expect(speedCurveProgress(curve, 0.9)).toBeGreaterThan(0.5);
    expect(speedCurveProgress(curve, 1)).toBe(1);
  });

  it.each([0, 0.25, 0.5, 0.75, 1])(
    "never overshoots a speed interval or reverses with intensity %s",
    (intensity) => {
      const curve: CameraSpeedCurve = {
        version: 1,
        points: [
          { time: 0, speed: 0, intensity },
          { time: 0.17, speed: 4, intensity: 1 - intensity },
          { time: 0.6, speed: 0.2, intensity },
          { time: 0.9, speed: 3, intensity: 1 - intensity },
          { time: 1, speed: 0, intensity },
        ],
      };
      let previousProgress = 0;
      for (let step = 0; step <= 400; step += 1) {
        const time = step / 400;
        const nextIndex = Math.max(
          1,
          curve.points.findIndex((point) => point.time >= time),
        );
        const from = curve.points[nextIndex - 1]!;
        const to = curve.points[nextIndex]!;
        const speed = sampleSpeedCurve(curve, time);
        const progress = speedCurveProgress(curve, time);
        expect(speed).toBeGreaterThanOrEqual(Math.min(from.speed, to.speed));
        expect(speed).toBeLessThanOrEqual(Math.max(from.speed, to.speed));
        expect(progress).toBeGreaterThanOrEqual(previousProgress);
        expect(progress).toBeLessThanOrEqual(1);
        previousProgress = progress;
      }
    },
  );

  it("clamps out-of-range time to exact endpoints", () => {
    const curve = createSpeedCurvePreset("ease-in");
    expect(speedCurveProgress(curve, -5)).toBe(0);
    expect(speedCurveProgress(curve, 3)).toBe(1);
    expect(sampleSpeedCurve(curve, -5)).toBe(0);
    expect(sampleSpeedCurve(curve, 3)).toBe(2);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite time %s", (time) => {
    const curve = createSpeedCurvePreset("constant");
    expect(() => speedCurveProgress(curve, time)).toThrow(RangeError);
    expect(() => speedCurveProgress(undefined, time)).toThrow(RangeError);
    expect(() => sampleSpeedCurve(curve, time)).toThrow(RangeError);
  });

  it("safely falls back to linear timing for malformed runtime curves", () => {
    const valid = createSpeedCurvePreset("constant");
    const invalid: CameraSpeedCurve[] = [
      { version: 2, points: valid.points } as unknown as CameraSpeedCurve,
      { version: 1, points: [] },
      { version: 1, points: [valid.points[0]!] },
      { ...valid, points: valid.points.map((point) => ({ ...point, speed: 0 })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, speed: NaN })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, speed: -1 })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, speed: 5 })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, intensity: Infinity })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, intensity: 2 })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, time: 0 })) },
      { ...valid, points: valid.points.map((point) => ({ ...point, time: point.time + 0.1 })) },
    ];
    for (const curve of invalid) {
      expect(speedCurveProgress(curve, 0.35)).toBe(0.35);
      expect(sampleSpeedCurve(curve, 0.35)).toBe(1);
    }
  });

  it("keeps timing unchanged when all relative weights are scaled", () => {
    const curve = createSpeedCurvePreset("ease-in-out");
    for (const scale of [0.3, 2, Number.MIN_VALUE]) {
      const scaled = {
        ...curve,
        points: curve.points.map((point) => ({ ...point, speed: point.speed * scale })),
      };
      for (const time of [0.1, 0.4, 0.7, 0.9]) {
        expect(speedCurveProgress(scaled, time)).toBeCloseTo(speedCurveProgress(curve, time), 12);
      }
    }
  });

  it("provides independent presets with the expected acceleration and deceleration", () => {
    const easeIn = createSpeedCurvePreset("ease-in");
    const easeOut = createSpeedCurvePreset("ease-out");
    const easeInOut = createSpeedCurvePreset("ease-in-out");
    expect(speedCurveProgress(easeIn, 0.5)).toBeLessThan(0.5);
    expect(speedCurveProgress(easeOut, 0.5)).toBeGreaterThan(0.5);
    expect(speedCurveProgress(easeInOut, 0.25)).toBeLessThan(0.25);
    expect(speedCurveProgress(easeInOut, 0.5)).toBeCloseTo(0.5, 12);
    expect(speedCurveProgress(easeInOut, 0.75)).toBeGreaterThan(0.75);
    easeIn.points[0]!.speed = 4;
    expect(createSpeedCurvePreset("ease-in").points[0]!.speed).toBe(0);
  });
});
