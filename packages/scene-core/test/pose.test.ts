import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";

import { composeHandheldPose, type HandheldBaseline } from "../src/pose.js";

const IDENTITY: readonly [number, number, number, number] = [0, 0, 0, 1];

function quaternionTuple(quaternion: Quaternion): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function baseline(overrides: Partial<HandheldBaseline> = {}): HandheldBaseline {
  return {
    virtualPosition: [0, 0, 0],
    virtualQuaternion: IDENTITY,
    devicePosition: [0, 0, 0],
    deviceQuaternion: IDENTITY,
    ...overrides,
  };
}

describe("composeHandheldPose", () => {
  it("returns the baseline virtual pose when the device has not moved", () => {
    const result = composeHandheldPose(
      baseline({ virtualPosition: [3, 1.4, -2] }),
      { position: [0, 0, 0], quaternion: IDENTITY, timestampMs: 0 },
    );
    expect(result.position).toEqual([3, 1.4, -2]);
    expect(result.quaternion[3]).toBeCloseTo(1);
  });

  it("translates the virtual camera by the physical displacement", () => {
    const result = composeHandheldPose(
      baseline({ virtualPosition: [10, 2, 5] }),
      { position: [0.5, 0.25, -1], quaternion: IDENTITY, timestampMs: 0 },
    );
    expect(result.position[0]).toBeCloseTo(10.5);
    expect(result.position[1]).toBeCloseTo(2.25);
    expect(result.position[2]).toBeCloseTo(4);
  });

  it("scales physical meters into scene units", () => {
    const result = composeHandheldPose(
      baseline(),
      { position: [1, 0, 0], quaternion: IDENTITY, timestampMs: 0 },
      2.5,
    );
    expect(result.position[0]).toBeCloseTo(2.5);
  });

  it("applies device rotation deltas relative to the virtual baseline", () => {
    const yaw90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const result = composeHandheldPose(
      baseline(),
      { position: [0, 0, 0], quaternion: quaternionTuple(yaw90), timestampMs: 0 },
    );
    const resultQuat = new Quaternion(...result.quaternion);
    expect(Math.abs(resultQuat.dot(yaw90))).toBeCloseTo(1, 5);
  });

  it("rotates displacement into the virtual frame when baselines differ", () => {
    // Virtual camera faces +X (yaw -90deg); device faces -Z (identity).
    // Walking physically forward (-Z) should move the virtual camera along its
    // own forward axis (+X).
    const virtualYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    const result = composeHandheldPose(
      baseline({ virtualQuaternion: quaternionTuple(virtualYaw) }),
      { position: [0, 0, -1], quaternion: IDENTITY, timestampMs: 0 },
    );
    expect(result.position[0]).toBeCloseTo(1, 5);
    expect(result.position[2]).toBeCloseTo(0, 5);
  });

  it("keeps orientation deltas anchored when the device baseline is rotated", () => {
    const yaw45 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    const yaw90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const result = composeHandheldPose(
      baseline({ deviceQuaternion: quaternionTuple(yaw45) }),
      { position: [0, 0, 0], quaternion: quaternionTuple(yaw90), timestampMs: 0 },
    );
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    const resultQuat = new Quaternion(...result.quaternion);
    expect(Math.abs(resultQuat.dot(expected))).toBeCloseTo(1, 5);
  });
});
