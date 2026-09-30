import { describe, expect, it } from "vitest";
import type { CameraPath, CinematicCamera } from "@oculo/scene-schema";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";

import { SmoothCameraPathInterpolator } from "../src/interpolation.js";
import { getCameraFraming } from "../src/sensors.js";
import { createSpeedCurvePreset, speedCurveProgress } from "../src/speedCurve.js";

function camera(
  position: CinematicCamera["pose"]["position"],
  quaternion: CinematicCamera["pose"]["quaternion"],
  focalLengthMm: number,
): CinematicCamera {
  return {
    pose: { position, quaternion },
    focalLengthMm,
    sensorWidthMm: 36,
    sensorHeightMm: 24,
    output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" as const },
    near: 0.01,
    far: 1000,
  };
}

const path: CameraPath = {
  sceneId: "scene",
  assetVersionId: "legacy-scene:scene",
  id: "test",
  name: "Test move",
  keyframes: [
    { timeSeconds: 2, camera: camera([0, 1, 2], [0, 0, 0, 2], 35) },
    { timeSeconds: 5, camera: camera([4, 3, -1], [0, 1, 0, 1], 50) },
    { timeSeconds: 10, camera: camera([10, 8, -5], [0, 2, 0, 0], 85) },
  ],
};

function twoShotPath(start: CinematicCamera, end: CinematicCamera): CameraPath {
  return {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    id: "two-shots",
    name: "Two-shot move",
    keyframes: [
      { timeSeconds: 0, camera: start },
      { timeSeconds: 8, camera: end },
    ],
  };
}

function lookingAt(position: Vector3, subject: Vector3, roll = 0): CinematicCamera {
  const view = new PerspectiveCamera();
  view.position.copy(position);
  view.lookAt(subject);
  view.rotateZ(roll);
  return camera(position.toArray(), view.quaternion.toArray(), 35);
}

function projection(camera: CinematicCamera): PerspectiveCamera {
  const framing = getCameraFraming(camera);
  const view = new PerspectiveCamera(
    framing.verticalFovDegrees,
    framing.aspectRatio,
    camera.near,
    camera.far,
  );
  view.position.fromArray(camera.pose.position);
  view.quaternion.fromArray(camera.pose.quaternion);
  view.updateMatrixWorld();
  return view;
}

describe("SmoothCameraPathInterpolator", () => {
  const interpolator = new SmoothCameraPathInterpolator();

  it("returns the exact endpoint positions and endpoint orientations", () => {
    const start = interpolator.interpolate(path, 2);
    const end = interpolator.interpolate(path, 10);

    expect(start.pose.position).toEqual(path.keyframes[0]!.camera.pose.position);
    expect(start.pose.quaternion).toEqual([0, 0, 0, 1]);
    expect(start.focalLengthMm).toBe(35);
    expect(end.pose.position).toEqual(path.keyframes[2]!.camera.pose.position);
    expect(end.pose.quaternion).toEqual([0, 1, 0, 0]);
    expect(end.focalLengthMm).toBe(85);
  });

  it("always returns a normalized quaternion", () => {
    for (const timeSeconds of [2, 2.5, 4, 5, 7.5, 9, 10]) {
      const quaternion = interpolator.interpolate(path, timeSeconds).pose.quaternion;
      const length = Math.hypot(...quaternion);
      expect(length).toBeCloseTo(1, 12);
    }
  });

  it("orbits between shots of the same subject without an unintended push-in or framing drift", () => {
    const subject = new Vector3(2, 1, -3);
    const start = lookingAt(subject.clone().add(new Vector3(0, 0, 4)), subject);
    const end = lookingAt(subject.clone().add(new Vector3(4, 0, 0)), subject);
    const move = twoShotPath(start, end);
    const top = subject.clone().add(new Vector3(0, 0.5, 0));
    const bottom = subject.clone().add(new Vector3(0, -0.5, 0));
    const initialView = projection(start);
    const initialHeight =
      top.clone().project(initialView).y - bottom.clone().project(initialView).y;

    for (const time of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const frame = interpolator.interpolate(move, time);
      const view = projection(frame);
      const projectedSubject = subject.clone().project(view);
      expect(new Vector3(...frame.pose.position).distanceTo(subject)).toBeCloseTo(4, 10);
      expect(projectedSubject.x).toBeCloseTo(0, 10);
      expect(projectedSubject.y).toBeCloseTo(0, 10);
      expect(top.clone().project(view).y - bottom.clone().project(view).y).toBeCloseTo(
        initialHeight,
        10,
      );
      expect(frame.focalLengthMm).toBe(35);
    }

    const midpoint = interpolator.interpolate(move, 4);
    expect(midpoint.pose.position[0]).toBeCloseTo(subject.x + Math.sqrt(8), 10);
    expect(midpoint.pose.position[2]).toBeCloseTo(subject.z + Math.sqrt(8), 10);
    expect(interpolator.interpolate(move, 0)).toEqual(start);
    expect(interpolator.interpolate(move, 8)).toEqual(end);
  });

  it("keeps a shared subject centered between pitched and rolled shots while interpolating distance and lens", () => {
    const subject = new Vector3(-3, 2, 1);
    const start = lookingAt(subject.clone().add(new Vector3(0, 0, 4)), subject, 0.3);
    const end = lookingAt(subject.clone().add(new Vector3(4, 4, 4)), subject, -0.6);
    end.focalLengthMm = 70;
    const move = twoShotPath(start, end);

    for (const time of [0, 2, 4, 6, 8]) {
      const alpha = time / 8;
      const frame = interpolator.interpolate(move, time);
      const projectedSubject = subject.clone().project(projection(frame));
      expect(projectedSubject.x).toBeCloseTo(0, 10);
      expect(projectedSubject.y).toBeCloseTo(0, 10);
      expect(new Vector3(...frame.pose.position).distanceTo(subject)).toBeCloseTo(
        4 + (Math.sqrt(48) - 4) * alpha,
        10,
      );
      const expectedQuaternion = new Quaternion(...start.pose.quaternion).slerp(
        new Quaternion(...end.pose.quaternion),
        alpha,
      );
      expect(
        Math.abs(new Quaternion(...frame.pose.quaternion).dot(expectedQuaternion)),
      ).toBeCloseTo(1, 10);
      expect(frame.focalLengthMm).toBeCloseTo(35 + 35 * alpha);
    }
    expect(interpolator.interpolate(move, 0).pose.position).toEqual(start.pose.position);
    expect(interpolator.interpolate(move, 8).pose.position).toEqual(end.pose.position);
  });

  it.each([
    { name: "truck", from: [0, 0, 4], to: [2, 1, 4], fromYaw: 0, toYaw: 0 },
    { name: "straight dolly", from: [0, 0, 4], to: [0, 0, 2], fromYaw: 0, toYaw: 0 },
    { name: "stationary pan", from: [0, 0, 4], to: [0, 0, 4], fromYaw: 0, toYaw: Math.PI / 2 },
    { name: "nearly parallel rays", from: [0, 0, 4], to: [2, 0, 4], fromYaw: 0, toYaw: 1e-5 },
    { name: "skew rays", from: [0, 0, 4], to: [4, 1, 0], fromYaw: 0, toYaw: Math.PI / 2 },
    { name: "diverging rays", from: [0, 0, 4], to: [4, 0, 0], fromYaw: 0, toYaw: -Math.PI / 2 },
    {
      name: "subject behind cameras",
      from: [0, 0, 4],
      to: [4, 0, 0],
      fromYaw: Math.PI,
      toYaw: -Math.PI / 2,
    },
    { name: "opposing rays", from: [0, 0, 4], to: [0, 0, -4], fromYaw: 0, toYaw: Math.PI },
  ])("retains linear movement for $name", ({ from, to, fromYaw, toYaw }) => {
    const yaw = (angle: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
    const start = camera(new Vector3(...from).toArray(), yaw(fromYaw).toArray(), 35);
    const end = camera(new Vector3(...to).toArray(), yaw(toYaw).toArray(), 35);
    const midpoint = interpolator.interpolate(twoShotPath(start, end), 4);
    expect(midpoint.pose.position).toEqual(
      new Vector3(...from).lerp(new Vector3(...to), 0.5).toArray(),
    );
    expect(
      Math.abs(
        new Quaternion(...midpoint.pose.quaternion).dot(yaw(fromYaw).slerp(yaw(toYaw), 0.5)),
      ),
    ).toBeCloseTo(1, 10);
    expect(midpoint.focalLengthMm).toBe(35);
  });

  it("preserves output framing at endpoints and interpolates mixed-aspect moves", () => {
    const first = {
      ...camera([0, 0, 0], [0, 0, 0, 1], 35),
      output: { aspectRatio: 1, crop: "center-inside-sensor" as const },
    };
    const last = {
      ...camera([1, 0, 0], [0, 0, 0, 1], 35),
      output: { aspectRatio: 2.39, crop: "center-inside-sensor" as const },
    };
    const mixedPath: CameraPath = {
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "mixed",
      name: "Changing crop",
      keyframes: [
        { timeSeconds: 0, camera: first },
        { timeSeconds: 2, camera: last },
      ],
    };
    expect(interpolator.interpolate(mixedPath, 0)).toEqual(first);
    expect(interpolator.interpolate(mixedPath, 2)).toEqual(last);
    const midpoint = interpolator.interpolate(mixedPath, 1);
    expect(midpoint.output.aspectRatio).toBeCloseTo((1 + 2.39) / 2);
    expect(midpoint.sensorWidthMm).toBe(36);
    expect(midpoint.sensorHeightMm).toBe(24);
    expect(interpolator.interpolate(path, 4).output.aspectRatio).toBe(16 / 9);
  });

  it("applies the outgoing speed curve to position, orientation, and every lens property", () => {
    const start = camera([0, 0, 4], [0, 0, 0, 1], 35);
    const end = {
      ...camera(
        [8, 2, 4],
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1).toArray(),
        75,
      ),
      sensorWidthMm: 48,
      sensorHeightMm: 36,
      output: { aspectRatio: 2.39, crop: "center-inside-sensor" as const },
      near: 0.1,
      far: 2000,
    };
    const move = twoShotPath(start, end);
    const curvedMove: CameraPath = {
      ...move,
      keyframes: [
        { ...move.keyframes[0]!, speedCurve: createSpeedCurvePreset("ease-in") },
        move.keyframes[1]!,
      ],
    };
    const alpha = 0.1875;
    const frame = interpolator.interpolate(curvedMove, 4);
    expect(frame).toEqual(interpolator.interpolate(move, alpha * 8));
    expect(frame.pose.position).toEqual([8 * alpha, 2 * alpha, 4]);
    expect(frame.focalLengthMm).toBe(35 + 40 * alpha);
    expect(frame.sensorWidthMm).toBe(36 + 12 * alpha);
    expect(frame.sensorHeightMm).toBe(24 + 12 * alpha);
    expect(frame.output.aspectRatio).toBeCloseTo(16 / 9 + (2.39 - 16 / 9) * alpha, 12);
    expect(frame.near).toBeCloseTo(0.01 + 0.09 * alpha, 12);
    expect(frame.far).toBe(1000 + 1000 * alpha);
    expect(interpolator.interpolate(curvedMove, 0)).toEqual(start);
    expect(interpolator.interpolate(curvedMove, 8)).toEqual(end);
  });

  it("preserves the subject orbit when its timing is curved", () => {
    const subject = new Vector3(2, 1, -3);
    const start = lookingAt(subject.clone().add(new Vector3(0, 0, 4)), subject);
    const end = lookingAt(subject.clone().add(new Vector3(4, 0, 0)), subject);
    const move = twoShotPath(start, end);
    const speedCurve = createSpeedCurvePreset("ease-in-out");
    const curvedMove: CameraPath = {
      ...move,
      keyframes: [{ ...move.keyframes[0]!, speedCurve }, move.keyframes[1]!],
    };
    for (const time of [0, 1, 2, 4, 6, 7, 8]) {
      const frame = interpolator.interpolate(curvedMove, time);
      expect(frame).toEqual(
        interpolator.interpolate(move, speedCurveProgress(speedCurve, time / 8) * 8),
      );
      expect(new Vector3(...frame.pose.position).distanceTo(subject)).toBeCloseTo(4, 10);
      const projectedSubject = subject.clone().project(projection(frame));
      expect(projectedSubject.x).toBeCloseTo(0, 10);
      expect(projectedSubject.y).toBeCloseTo(0, 10);
    }
  });

  it("applies each waypoint's own curve and arrives at every waypoint at its saved time", () => {
    const firstCurve = createSpeedCurvePreset("ease-in");
    const secondCurve = createSpeedCurvePreset("ease-out");
    const curvedPath: CameraPath = {
      ...path,
      keyframes: [
        { ...path.keyframes[0]!, speedCurve: firstCurve },
        { ...path.keyframes[1]!, speedCurve: secondCurve },
        path.keyframes[2]!,
      ],
    };
    expect(interpolator.interpolate(curvedPath, 3.5)).toEqual(
      interpolator.interpolate(path, 2 + speedCurveProgress(firstCurve, 0.5) * 3),
    );
    expect(interpolator.interpolate(curvedPath, 7.5)).toEqual(
      interpolator.interpolate(path, 5 + speedCurveProgress(secondCurve, 0.5) * 5),
    );
    for (const keyframe of path.keyframes) {
      const frame = interpolator.interpolate(curvedPath, keyframe.timeSeconds);
      expect(frame.pose.position).toEqual(keyframe.camera.pose.position);
      expect(frame.focalLengthMm).toBe(keyframe.camera.focalLengthMm);
      expect(frame).toEqual(interpolator.interpolate(path, keyframe.timeSeconds));
    }
  });
});
