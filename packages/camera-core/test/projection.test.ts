import { describe, expect, it } from "vitest";
import { migrateCamera } from "@oculo/scene-schema";
import { cameraProjection, fitComposition } from "../src/sensors";
const camera = migrateCamera({
  pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  focalLengthMm: 50,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  near: 0.1,
  far: 100,
});
describe("output framing", () => {
  it("center-crops a wide output without changing sensor size or focal length", () => {
    const p = cameraProjection({ ...camera, output: { ...camera.output, aspectRatio: 16 / 9 } });
    expect(p.sensorWidthMm).toBe(36);
    expect(p.sensorHeightMm).toBe(20.25);
    expect(p.verticalFovDegrees).toBeCloseTo((2 * Math.atan(20.25 / 100) * 180) / Math.PI);
    expect(camera.sensorHeightMm).toBe(24);
  });
  it("crops the sensor width for square output and fits consistently in both orientations", () => {
    expect(
      cameraProjection({ ...camera, output: { ...camera.output, aspectRatio: 1 } }).sensorWidthMm,
    ).toBe(24);
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [1024, 768],
    ]) {
      const frame = fitComposition(w!, h!, 2.39);
      expect(frame.width / frame.height).toBeCloseTo(2.39);
      expect(frame.width).toBeLessThanOrEqual(w!);
      expect(frame.height).toBeLessThanOrEqual(h!);
    }
  });
});
