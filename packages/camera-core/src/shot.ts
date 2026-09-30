import {
  MAX_SHOT_KEYFRAMES,
  SHOT_DURATION_RANGE,
  shotKeyframeCamera,
  shotKeyframeFromCamera,
  type CameraPath,
  type CameraSpeedCurve,
  type CinematicCamera,
  type Shot,
  type ShotKeyframe,
  type ShotLens,
} from "@oculo/scene-schema";

import { defaultCameraPathInterpolator } from "./interpolation.js";
import { clampFocal } from "./lens.js";
import { speedCurveProgress } from "./speedCurve.js";

/** Gap given to a keyframe added after the last one. */
export const DEFAULT_KEYFRAME_GAP_SECONDS = 2;
/** Closest two keyframes may sit, so each segment stays selectable and playable. */
export const MIN_KEYFRAME_GAP_SECONDS = 0.05;
/** A playhead this close to a keyframe is on it. */
export const KEYFRAME_TIME_TOLERANCE = 0.02;

export class ShotEditError extends Error {}

export function clampShotDuration(seconds: number): number {
  if (!Number.isFinite(seconds))
    throw new ShotEditError(
      `Enter a length between ${SHOT_DURATION_RANGE.min} and ${SHOT_DURATION_RANGE.max} seconds.`,
    );
  return Math.min(SHOT_DURATION_RANGE.max, Math.max(SHOT_DURATION_RANGE.min, seconds));
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/** The shot as a camera path: what speed-curve editing and path sampling consume. */
export function shotAsPath(shot: Shot): CameraPath {
  return {
    id: shot.id,
    sceneId: shot.sceneId,
    assetVersionId: shot.assetVersionId,
    name: shot.name,
    keyframes: shot.keyframes.map((keyframe) => ({
      timeSeconds: keyframe.timeSeconds,
      camera: shotKeyframeCamera(shot.setup, keyframe),
      ...(keyframe.speedCurve ? { speedCurve: keyframe.speedCurve } : {}),
    })),
  };
}

/** The segment containing `t`: the keyframe it starts at and its eased progress. */
export function shotSegmentAt(
  shot: Shot,
  timeSeconds: number,
): { index: number; progress: number } {
  const frames = shot.keyframes;
  const t = Math.max(0, timeSeconds);
  const next = frames.findIndex((frame) => frame.timeSeconds > t);
  if (next <= 0) return { index: next === 0 ? 0 : frames.length - 1, progress: 0 };
  const from = frames[next - 1]!;
  const to = frames[next]!;
  return {
    index: next - 1,
    progress: speedCurveProgress(
      from.speedCurve,
      (t - from.timeSeconds) / (to.timeSeconds - from.timeSeconds),
    ),
  };
}

/**
 * The camera `t` seconds into a shot. Position and rotation follow the existing smooth
 * path; zoom stays inside the lens; focus eases in diopters like a focus pull and the
 * aperture in stops like an iris pull. After the last keyframe the camera holds.
 */
export function shotCameraAt(shot: Shot, timeSeconds: number): CinematicCamera {
  const t = Math.min(shot.durationSeconds, Math.max(0, timeSeconds));
  const camera = defaultCameraPathInterpolator.interpolate(shotAsPath(shot), t);
  const { index, progress } = shotSegmentAt(shot, t);
  const from = shot.keyframes[index]!;
  const to = shot.keyframes[index + 1] ?? from;
  return {
    ...camera,
    // Every keyframe in a shot shares its setup; don't let lerp drift the gate.
    sensorWidthMm: shot.setup.sensorWidthMm,
    sensorHeightMm: shot.setup.sensorHeightMm,
    output: { ...shot.setup.output },
    near: shot.setup.near,
    far: shot.setup.far,
    focalLengthMm: clampFocal(shot.setup.lens, camera.focalLengthMm),
    focusDistanceM: 1 / lerp(1 / from.focusDistanceM, 1 / to.focusDistanceM, progress),
    apertureFStop: 2 ** lerp(Math.log2(from.apertureFStop), Math.log2(to.apertureFStop), progress),
  };
}

export function keyframeIndexAt(
  shot: Shot,
  timeSeconds: number,
  tolerance = KEYFRAME_TIME_TOLERANCE,
): number {
  return shot.keyframes.findIndex(
    (frame) => Math.abs(frame.timeSeconds - timeSeconds) <= tolerance,
  );
}

/** A keyframe recording what the rig is doing now, within this shot's lens. */
export function keyframeFromRig(
  shot: Pick<Shot, "setup">,
  id: string,
  timeSeconds: number,
  rig: CinematicCamera,
): ShotKeyframe {
  const keyframe = shotKeyframeFromCamera(id, timeSeconds, rig);
  return { ...keyframe, focalLengthMm: clampFocal(shot.setup.lens, keyframe.focalLengthMm) };
}

function withoutSpeedCurve(frame: ShotKeyframe): ShotKeyframe {
  const copy = { ...frame };
  delete copy.speedCurve;
  return copy;
}

function assertRoom(shot: Shot): void {
  if (shot.keyframes.length >= MAX_SHOT_KEYFRAMES)
    throw new ShotEditError(`A shot supports up to ${MAX_SHOT_KEYFRAMES} keyframes.`);
}

/**
 * Adds a keyframe after the last one. A static shot's second keyframe lands at the end of
 * its length; later keyframes extend the shot by the default gap.
 */
export function appendKeyframe(shot: Shot, id: string, rig: CinematicCamera): Shot {
  assertRoom(shot);
  const last = shot.keyframes.at(-1)!;
  let time =
    shot.keyframes.length === 1
      ? Math.max(shot.durationSeconds, DEFAULT_KEYFRAME_GAP_SECONDS)
      : last.timeSeconds < shot.durationSeconds - MIN_KEYFRAME_GAP_SECONDS
        ? shot.durationSeconds
        : last.timeSeconds + DEFAULT_KEYFRAME_GAP_SECONDS;
  if (time > SHOT_DURATION_RANGE.max) {
    if (last.timeSeconds + MIN_KEYFRAME_GAP_SECONDS > SHOT_DURATION_RANGE.max)
      throw new ShotEditError(
        `Shots can be up to ${SHOT_DURATION_RANGE.max} seconds. Shorten a segment first.`,
      );
    time = SHOT_DURATION_RANGE.max;
  }
  return {
    ...shot,
    durationSeconds: Math.max(shot.durationSeconds, time),
    keyframes: [...shot.keyframes, keyframeFromRig(shot, id, time, rig)],
  };
}

/**
 * Records the rig at `t`: replaces a keyframe already there, otherwise inserts one.
 * The curve of a split segment is dropped, since it described the original pair.
 */
export function setKeyframeAt(
  shot: Shot,
  timeSeconds: number,
  id: string,
  rig: CinematicCamera,
): Shot {
  const t = Math.min(shot.durationSeconds, Math.max(0, timeSeconds));
  const existing = keyframeIndexAt(shot, t);
  if (existing >= 0) return updateKeyframe(shot, shot.keyframes[existing]!.id, rig);
  assertRoom(shot);
  const next = shot.keyframes.findIndex((frame) => frame.timeSeconds > t);
  const before = next === -1 ? shot.keyframes.at(-1)! : shot.keyframes[next - 1]!;
  const after = next === -1 ? undefined : shot.keyframes[next];
  if (
    t - before.timeSeconds < MIN_KEYFRAME_GAP_SECONDS ||
    (after && after.timeSeconds - t < MIN_KEYFRAME_GAP_SECONDS)
  )
    throw new ShotEditError("Move the playhead further from the nearest keyframe.");
  const frame = keyframeFromRig(shot, id, t, rig);
  const keyframes = shot.keyframes.map((k) => (k === before && after ? withoutSpeedCurve(k) : k));
  keyframes.splice(next === -1 ? keyframes.length : next, 0, frame);
  return { ...shot, keyframes };
}

/** Replaces what a keyframe records; its time and outgoing speed are kept. */
export function updateKeyframe(shot: Shot, id: string, rig: CinematicCamera): Shot {
  const index = shot.keyframes.findIndex((frame) => frame.id === id);
  if (index < 0) throw new ShotEditError("That keyframe is no longer part of the shot.");
  const current = shot.keyframes[index]!;
  const replacement = keyframeFromRig(shot, id, current.timeSeconds, rig);
  return {
    ...shot,
    keyframes: shot.keyframes.map((frame, i) =>
      i === index
        ? { ...replacement, ...(current.speedCurve ? { speedCurve: current.speedCurve } : {}) }
        : frame,
    ),
  };
}

/**
 * Removes a keyframe; the only keyframe of a static shot stays. Removing the first
 * keyframe starts the shot at the next one.
 */
export function removeKeyframe(shot: Shot, id: string): Shot {
  const index = shot.keyframes.findIndex((frame) => frame.id === id);
  if (index < 0 || shot.keyframes.length === 1) return shot;
  if (index === 0) {
    const shift = shot.keyframes[1]!.timeSeconds;
    return {
      ...shot,
      durationSeconds: clampShotDuration(shot.durationSeconds - shift),
      keyframes: shot.keyframes
        .slice(1)
        .map((frame) => ({ ...frame, timeSeconds: frame.timeSeconds - shift })),
    };
  }
  return {
    ...shot,
    keyframes: shot.keyframes
      .filter((_, i) => i !== index)
      .map((frame, i) =>
        i === index - 1 && index < shot.keyframes.length - 1 ? withoutSpeedCurve(frame) : frame,
      ),
  };
}

/** Moves a keyframe in time between its neighbours. The first keyframe stays at 0. */
export function setKeyframeTime(shot: Shot, id: string, timeSeconds: number): Shot {
  const index = shot.keyframes.findIndex((frame) => frame.id === id);
  if (index <= 0 || !Number.isFinite(timeSeconds)) return shot;
  const before = shot.keyframes[index - 1]!.timeSeconds + MIN_KEYFRAME_GAP_SECONDS;
  const after = shot.keyframes[index + 1]?.timeSeconds;
  const upper = after === undefined ? SHOT_DURATION_RANGE.max : after - MIN_KEYFRAME_GAP_SECONDS;
  const time = Math.min(upper, Math.max(before, timeSeconds));
  return {
    ...shot,
    durationSeconds: Math.max(shot.durationSeconds, time),
    keyframes: shot.keyframes.map((frame, i) =>
      i === index ? { ...frame, timeSeconds: time } : frame,
    ),
  };
}

/** Changes a shot's length, keeping each keyframe at the same fraction of it. */
export function retimeShot(shot: Shot, durationSeconds: number): Shot {
  const duration = clampShotDuration(durationSeconds);
  const scale = duration / shot.durationSeconds;
  const keyframes = shot.keyframes.map((frame) => ({
    ...frame,
    timeSeconds: frame.timeSeconds * scale,
  }));
  if (
    keyframes.some((frame, i) => i > 0 && frame.timeSeconds - keyframes[i - 1]!.timeSeconds < 1e-3)
  )
    throw new ShotEditError("That length is too short for this many keyframes.");
  return { ...shot, durationSeconds: duration, keyframes };
}

/** Sets the speed through the segment that starts at a keyframe; undefined is constant. */
export function setSegmentSpeed(
  shot: Shot,
  keyframeId: string,
  curve: CameraSpeedCurve | undefined,
): Shot {
  return {
    ...shot,
    keyframes: shot.keyframes.map((frame) =>
      frame.id !== keyframeId
        ? frame
        : curve
          ? { ...frame, speedCurve: curve }
          : withoutSpeedCurve(frame),
    ),
  };
}

/** Changes the lens; keyframes outside the new range are pulled inside it. */
export function setShotLens(shot: Shot, lens: ShotLens): { shot: Shot; clamped: boolean } {
  let clamped = false;
  const keyframes = shot.keyframes.map((frame) => {
    const focalLengthMm = clampFocal(lens, frame.focalLengthMm);
    if (Math.abs(focalLengthMm - frame.focalLengthMm) > 1e-6) clamped = true;
    return { ...frame, focalLengthMm };
  });
  return { shot: { ...shot, setup: { ...shot.setup, lens }, keyframes }, clamped };
}
