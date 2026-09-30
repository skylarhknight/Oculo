import { shotCameraAt } from "@oculo/camera-core";
import type { CinematicCamera, Shot } from "../../types/project";

export const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export const formatSeconds = (seconds: number) => `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;

/** "Static · 3.0s" or "Moving · 3 keyframes · 8.0s". */
export function shotKindLabel(shot: Shot): string {
  const length = formatSeconds(shot.durationSeconds);
  return shot.keyframes.length > 1
    ? `Moving · ${shot.keyframes.length} keyframes · ${length}`
    : `Static · ${length}`;
}

/** The camera `t` into the shot being edited, or the rig in free camera mode. */
export function cameraAt(shot: Shot | null, timeSeconds: number, fallback: CinematicCamera) {
  return shot ? shotCameraAt(shot, timeSeconds) : fallback;
}

export const ASPECT_CHOICES = [
  ["16:9", 16 / 9],
  ["2.39:1", 2.39],
  ["4:3", 4 / 3],
  ["1:1", 1],
  ["9:16", 9 / 16],
] as const;

/** Playback and scrubbing state the stage panels read and drive. */
export interface Transport {
  isPlaying: boolean;
  isScrubbing: boolean;
  playheadRef: React.MutableRefObject<number>;
  /** The progress bar over the scene, which reads `--playhead` from this element. */
  progressRef: React.RefObject<HTMLDivElement | null>;
  progressTrackRef: React.RefObject<HTMLDivElement | null>;
  progressTimeRef: React.RefObject<HTMLOutputElement | null>;
  play: () => void;
  stop: (commit?: boolean) => void;
  /** Stops playback, then moves the camera to a time (keyboard seeking). */
  scrubTo: (time: number) => void;
  /** Moves the camera to a time while a scrub already owns the engine. */
  commitPlayhead: (time: number) => void;
  beginScrub: (element: HTMLDivElement, pointerId: number) => void;
  finishScrub: () => void;
  isScrubPointer: (pointerId: number) => boolean;
  setPlayhead: (time: number) => CinematicCamera;
}
