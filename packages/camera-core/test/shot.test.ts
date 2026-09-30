import { describe, expect, it } from "vitest";
import {
  ShotSchema,
  shotKeyframeCamera,
  type CinematicCamera,
  type Shot,
} from "@oculo/scene-schema";
import { Quaternion, Vector3 } from "three";

import {
  appendKeyframe,
  clampFocal,
  createSpeedCurvePreset,
  lensLabel,
  nearestStop,
  removeKeyframe,
  retimeShot,
  rollDegrees,
  setKeyframeAt,
  setKeyframeTime,
  setSegmentSpeed,
  setShotLens,
  shotCameraAt,
  SmoothCameraPathInterpolator,
  updateKeyframe,
  withRoll,
} from "../src/index.js";

function rig(overrides: Partial<CinematicCamera> = {}): CinematicCamera {
  return {
    pose: { position: [0, 1, 5], quaternion: [0, 0, 0, 1] },
    focalLengthMm: 35,
    sensorWidthMm: 36,
    sensorHeightMm: 24,
    output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" },
    near: 0.01,
    far: 1000,
    focusDistanceM: 4,
    apertureFStop: 2.8,
    ...overrides,
  };
}

function staticShot(lens: Shot["setup"]["lens"] = { kind: "prime", focalLengthMm: 35 }): Shot {
  return ShotSchema.parse({
    id: "shot",
    sceneId: "scene",
    assetVersionId: "v1",
    name: "Shot 01",
    createdAt: "2026-09-25T00:00:00.000Z",
    durationSeconds: 3,
    setup: {
      lens,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" },
      near: 0.01,
      far: 1000,
    },
    keyframes: [
      {
        id: "k0",
        timeSeconds: 0,
        pose: { position: [0, 1, 5], quaternion: [0, 0, 0, 1] },
        focalLengthMm: 35,
        focusDistanceM: 4,
        apertureFStop: 2.8,
      },
    ],
  });
}

const zoom = { kind: "zoom" as const, minFocalLengthMm: 24, maxFocalLengthMm: 70 };

describe("lens", () => {
  it("labels and clamps primes and zooms", () => {
    expect(lensLabel({ kind: "prime", focalLengthMm: 35 })).toBe("35mm prime");
    expect(lensLabel(zoom)).toBe("24–70mm zoom");
    expect(clampFocal({ kind: "prime", focalLengthMm: 35 }, 85)).toBe(35);
    expect(clampFocal(zoom, 100)).toBe(70);
    expect(clampFocal(zoom, 10)).toBe(24);
    expect(nearestStop(3.2)).toBe(2.8);
    expect(nearestStop(6)).toBe(5.6);
  });

  it("sets a dutch angle without changing where the camera looks", () => {
    const look = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.6);
    const tuple = [look.x, look.y, look.z, look.w] as const;
    expect(rollDegrees([...tuple])).toBeCloseTo(0, 6);
    const rolled = withRoll([...tuple], 20);
    expect(rollDegrees(rolled)).toBeCloseTo(20, 6);
    const forward = (q: readonly number[]) =>
      new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q[0], q[1], q[2], q[3]));
    expect(forward(rolled).distanceTo(forward(tuple))).toBeLessThan(1e-9);
    expect(rollDegrees(withRoll(rolled, -45))).toBeCloseTo(-45, 6);
    expect(rollDegrees(withRoll(rolled, 0))).toBeCloseTo(0, 6);
  });
});

describe("shots", () => {
  it("holds a static shot for its whole length", () => {
    const shot = staticShot();
    const at = shotCameraAt(shot, 2);
    expect(at.pose.position).toEqual([0, 1, 5]);
    expect(at.focusDistanceM).toBeCloseTo(4);
    expect(at.apertureFStop).toBeCloseTo(2.8);
  });

  it("turns a static shot into a move by appending keyframes", () => {
    let shot = staticShot(zoom);
    shot = appendKeyframe(
      shot,
      "k1",
      rig({ pose: { position: [4, 1, 5], quaternion: [0, 0, 0, 1] }, focalLengthMm: 200 }),
    );
    expect(shot.keyframes.map((k) => k.timeSeconds)).toEqual([0, 3]);
    expect(shot.keyframes[1]!.focalLengthMm).toBe(70);
    shot = appendKeyframe(shot, "k2", rig());
    expect(shot.keyframes.map((k) => k.timeSeconds)).toEqual([0, 3, 5]);
    expect(shot.durationSeconds).toBe(5);
    expect(ShotSchema.parse(shot)).toEqual(shot);
  });

  it("pulls focus in diopters and the iris in stops", () => {
    let shot = staticShot();
    shot = appendKeyframe(shot, "k1", rig({ focusDistanceM: 1, apertureFStop: 11.2 }));
    const middle = shotCameraAt(shot, 1.5);
    // Halfway between 1/4 and 1/1 diopters is 0.625, or 1.6 m.
    expect(middle.focusDistanceM).toBeCloseTo(1.6, 6);
    // Halfway between f/2.8 and f/11.2 in stops is f/5.6.
    expect(middle.apertureFStop).toBeCloseTo(5.6, 6);
  });

  it("matches the path interpolator for position, rotation and zoom", () => {
    let shot = staticShot(zoom);
    shot = appendKeyframe(
      shot,
      "k1",
      rig({ pose: { position: [3, 2, 1], quaternion: [0, 0.38, 0, 0.92] }, focalLengthMm: 50 }),
    );
    shot = appendKeyframe(
      shot,
      "k2",
      rig({ pose: { position: [6, 1, -2], quaternion: [0, 0.7, 0, 0.7] }, focalLengthMm: 24 }),
    );
    const path = {
      id: "p",
      sceneId: "scene",
      assetVersionId: "v1",
      name: "p",
      keyframes: shot.keyframes.map((k) => ({
        timeSeconds: k.timeSeconds,
        camera: shotKeyframeCamera(shot.setup, k),
      })),
    };
    for (const t of [0.4, 2.2, 4.1]) {
      const expected = new SmoothCameraPathInterpolator().interpolate(path, t);
      const actual = shotCameraAt(shot, t);
      expect(actual.pose).toEqual(expected.pose);
      expect(actual.focalLengthMm).toBeCloseTo(expected.focalLengthMm, 9);
    }
  });

  it("inserts, updates, moves and removes keyframes while keeping speed where it applies", () => {
    let shot = appendKeyframe(staticShot(), "k1", rig());
    shot = setSegmentSpeed(shot, "k0", createSpeedCurvePreset("ease-in"));
    const moved = rig({ pose: { position: [1, 1, 1], quaternion: [0, 0, 0, 1] } });
    const updated = updateKeyframe(shot, "k0", moved);
    expect(updated.keyframes[0]!.pose.position).toEqual([1, 1, 1]);
    expect(updated.keyframes[0]!.speedCurve).toBeDefined();
    // Recording at an existing keyframe's time replaces it rather than adding one.
    expect(setKeyframeAt(shot, 0.01, "dup", moved).keyframes).toHaveLength(2);
    const inserted = setKeyframeAt(shot, 1, "mid", moved);
    expect(inserted.keyframes.map((k) => k.id)).toEqual(["k0", "mid", "k1"]);
    expect(inserted.keyframes[0]!.speedCurve).toBeUndefined();
    expect(setKeyframeTime(inserted, "mid", 10).keyframes[1]!.timeSeconds).toBeCloseTo(2.95);
    expect(setKeyframeTime(inserted, "k0", 1)).toBe(inserted);
    const removed = removeKeyframe(inserted, "mid");
    expect(removed.keyframes.map((k) => k.id)).toEqual(["k0", "k1"]);
    const first = removeKeyframe(inserted, "k0");
    expect(first.keyframes.map((k) => [k.id, k.timeSeconds])).toEqual([
      ["mid", 0],
      ["k1", 2],
    ]);
    expect(first.durationSeconds).toBe(2);
    expect(removeKeyframe(staticShot(), "k0").keyframes).toHaveLength(1);
  });

  it("changes a shot's length and lens", () => {
    const shot = appendKeyframe(staticShot(zoom), "k1", rig({ focalLengthMm: 70 }));
    const longer = retimeShot(shot, 6);
    expect(longer.keyframes.map((k) => k.timeSeconds)).toEqual([0, 6]);
    expect(retimeShot(shot, 100).durationSeconds).toBe(60);
    const { shot: prime, clamped } = setShotLens(shot, { kind: "prime", focalLengthMm: 35 });
    expect(clamped).toBe(true);
    expect(prime.keyframes.map((k) => k.focalLengthMm)).toEqual([35, 35]);
    expect(ShotSchema.parse(prime)).toEqual(prime);
  });
});
