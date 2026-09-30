import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA } from "../types/project";
import { fromCameraState, toCameraState } from "./cameraState";

describe("cinematic camera state conversion", () => {
  it.each([
    { label: "16:9", aspect: 16 / 9, croppedHeight: 20.25 },
    { label: "4:3", aspect: 4 / 3, croppedHeight: 24 },
    { label: "1:1", aspect: 1, croppedHeight: 24 },
  ])(
    "round trips $label with the centered sensor crop and original focal length",
    ({ aspect, croppedHeight }) => {
      const camera = {
        ...structuredClone(DEFAULT_CAMERA),
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        focalLengthMm: 50,
        output: { aspectRatio: aspect, crop: "center-inside-sensor" as const },
      };
      const state = toCameraState(camera);
      expect(state.aspectRatio).toBe(aspect);
      expect(state.verticalFovDegrees).toBeCloseTo(
        (2 * Math.atan(croppedHeight / (2 * 50)) * 180) / Math.PI,
        10,
      );

      const restored = fromCameraState(state, camera);
      expect(restored.focalLengthMm).toBeCloseTo(50, 10);
      expect(restored.output.aspectRatio).toBe(aspect);
      expect(restored.sensorWidthMm).toBe(36);
      expect(restored.sensorHeightMm).toBe(24);
      expect(restored.pose).toEqual(camera.pose);
    },
  );

  it("uses the live engine pose, projection and clipping even when the displayed camera is stale", () => {
    const displayed = structuredClone(DEFAULT_CAMERA);
    const actual = {
      ...structuredClone(DEFAULT_CAMERA),
      pose: {
        position: [7, 2, -3] as [number, number, number],
        quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
      },
      focalLengthMm: 85,
      output: { aspectRatio: 1, crop: "center-inside-sensor" as const },
      near: 0.1,
      far: 500,
    };
    const snapshot = fromCameraState(toCameraState(actual), displayed);

    expect(snapshot.pose).toEqual(actual.pose);
    expect(snapshot.focalLengthMm).toBeCloseTo(85, 10);
    expect(snapshot.output.aspectRatio).toBe(1);
    expect(snapshot.near).toBe(0.1);
    expect(snapshot.far).toBe(500);
    expect(displayed).toEqual(DEFAULT_CAMERA);
  });

  it("retains the selected sensor dimensions when capturing a different output aspect", () => {
    const sensor = {
      ...structuredClone(DEFAULT_CAMERA),
      sensorWidthMm: 23.5,
      sensorHeightMm: 15.7,
    };
    const live = toCameraState({
      ...sensor,
      focalLengthMm: 70,
      output: { aspectRatio: 4 / 3, crop: "center-inside-sensor" as const },
    });
    const snapshot = fromCameraState(live, sensor);

    expect(snapshot.sensorWidthMm).toBe(23.5);
    expect(snapshot.sensorHeightMm).toBe(15.7);
    expect(snapshot.focalLengthMm).toBeCloseTo(70, 10);
    expect(snapshot.output.aspectRatio).toBe(4 / 3);
  });

  it("copies pose values in both directions so later motion cannot change a saved snapshot", () => {
    const camera = structuredClone(DEFAULT_CAMERA);
    const state = toCameraState(camera);
    const originalPose = structuredClone(camera.pose);
    camera.pose.position[0] = 99;
    camera.pose.quaternion[3] = 0.5;
    expect(state.position).toEqual(originalPose.position);
    expect(state.quaternion).toEqual(originalPose.quaternion);

    const position: [number, number, number] = [...state.position];
    const quaternion: [number, number, number, number] = [...state.quaternion];
    const snapshot = fromCameraState({ ...state, position, quaternion }, camera);
    position[0] = -99;
    quaternion[3] = 0.25;
    camera.sensorWidthMm = 70;
    expect(snapshot.pose).toEqual(originalPose);
    expect(snapshot.sensorWidthMm).toBe(DEFAULT_CAMERA.sensorWidthMm);
  });
});
