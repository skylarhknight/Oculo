import { describe, expect, it } from "vitest";
import type { CinematicCamera } from "@oculo/scene-schema";
import { getCameraFraming } from "../src/sensors.js";

const camera: CinematicCamera = {
  pose: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  focalLengthMm: 50,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" as const },
  near: 0.01,
  far: 1000,
};

describe("getCameraFraming", () => {
  it.each([
    [16 / 9, 20.25],
    [2.39, 36 / 2.39],
    [1, 24],
    [9 / 16, 24],
    [3 / 2, 24],
  ])("center-crops to aspect %s inside the physical sensor", (outputAspectRatio, height) => {
    const framing = getCameraFraming({
      ...camera,
      output: { ...camera.output, aspectRatio: outputAspectRatio },
    });
    expect(framing.aspectRatio).toBe(outputAspectRatio);
    expect(framing.effectiveSensorHeightMm).toBeCloseTo(height);
    // Recover the projected sensor area from the FOV, independent of the implementation.
    const projectedHeight =
      2 * camera.focalLengthMm * Math.tan((framing.verticalFovDegrees * Math.PI) / 360);
    expect(projectedHeight).toBeCloseTo(height);
    expect(projectedHeight * outputAspectRatio).toBeLessThanOrEqual(camera.sensorWidthMm + 1e-10);
    expect(projectedHeight).toBeLessThanOrEqual(camera.sensorHeightMm + 1e-10);
    expect(camera.sensorHeightMm).toBe(24);
  });

  it("changes lens field of view while keeping the output aspect independent", () => {
    const wide = getCameraFraming({ ...camera, focalLengthMm: 24 });
    const telephoto = getCameraFraming({ ...camera, focalLengthMm: 85 });
    expect(wide.verticalFovDegrees).toBeGreaterThan(telephoto.verticalFovDegrees);
    expect(wide.aspectRatio).toBe(telephoto.aspectRatio);
    expect(wide.effectiveSensorHeightMm).toBe(telephoto.effectiveSensorHeightMm);
  });

  it.each([0, -1, Infinity, NaN])("rejects invalid aspect %s", (outputAspectRatio) => {
    expect(() =>
      getCameraFraming({ ...camera, output: { ...camera.output, aspectRatio: outputAspectRatio } }),
    ).toThrow(RangeError);
  });
});
