import { shotCameraAt } from "@oculo/camera-core";
import { ShotSchema, type Shot } from "@oculo/scene-schema";
import { toCameraState } from "../cameraState";

export const VIDEO_FRAME_RATE = 30;
export const MAX_VIDEO_DURATION_SECONDS = 60;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

export function videoDimensions(aspect: number): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect < 0.25 || aspect > 4) {
    throw new RangeError("Video aspect ratio must be between 1:4 and 4:1.");
  }
  const width = aspect >= 1 ? Math.min(1280, 720 * aspect) : Math.min(720, 1280 * aspect);
  return {
    width: Math.max(2, 2 * Math.round(width / 2)),
    height: Math.max(2, 2 * Math.round(width / aspect / 2)),
  };
}

/** A sequence stays under the 64 MB limit at the export bitrate (4 Mbit/s). */
export const MAX_SEQUENCE_DURATION_SECONDS = 120;

/** One shot's frames, from a snapshot taken before any asynchronous render work. */
function shotFrames(input: Shot) {
  const parsed = ShotSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(`“${input.name}” contains invalid settings. Edit it before exporting.`);
  const shot = parsed.data as Shot;
  const durationSeconds = shot.durationSeconds;
  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS)
    throw new RangeError(`Shots up to ${MAX_VIDEO_DURATION_SECONDS} seconds can be exported.`);
  videoDimensions(shot.setup.output.aspectRatio);
  const durationUs = Math.round(durationSeconds * 1_000_000);
  const frameCount = Math.max(2, Math.ceil(durationSeconds * VIDEO_FRAME_RATE));
  return {
    shot,
    durationUs,
    frameCount,
    frame(index: number) {
      const timestampUs = Math.round((index * durationUs) / frameCount);
      const endUs = Math.round(((index + 1) * durationUs) / frameCount);
      // A finite clip holds its endpoint in its final frame. All other samples
      // use their presentation timestamp; no global retiming of speed curves.
      const cameraTimeSeconds =
        index === frameCount - 1 ? durationSeconds : timestampUs / 1_000_000;
      return {
        timestampUs,
        endUs,
        cameraTimeSeconds,
        camera: toCameraState(shotCameraAt(shot, cameraTimeSeconds)),
      };
    },
  };
}

/**
 * Snapshot one shot, or several shots played back to back with hard cuts, before any
 * asynchronous render work. Never trim or retime saves. A sequence takes the frame of
 * its first shot; other aspect ratios fit inside it with black bars.
 */
export function createVideoTimeline(input: Shot | readonly Shot[]) {
  const shots = Array.isArray(input) ? (input as readonly Shot[]) : [input as Shot];
  if (shots.length === 0) throw new Error("Choose at least one shot to export.");
  const clips = shots.map(shotFrames);
  const totalUs = clips.reduce((sum, clip) => sum + clip.durationUs, 0);
  if (clips.length > 1 && totalUs > MAX_SEQUENCE_DURATION_SECONDS * 1_000_000)
    throw new RangeError(
      `Sequences up to ${MAX_SEQUENCE_DURATION_SECONDS} seconds can be exported. Leave out a shot and retry.`,
    );
  const dimensions = videoDimensions(clips[0]!.shot.setup.output.aspectRatio);
  // Where each clip starts, in frames and in microseconds.
  const starts: { frame: number; us: number }[] = [];
  let frames = 0;
  let offsetUs = 0;
  for (const clip of clips) {
    starts.push({ frame: frames, us: offsetUs });
    frames += clip.frameCount;
    offsetUs += clip.durationUs;
  }
  return {
    ...dimensions,
    durationSeconds: totalUs / 1_000_000,
    frameCount: frames,
    /** Frame index where each shot begins, for keyframes at cuts and progress text. */
    shotStarts: starts.map((start) => start.frame),
    frame(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= frames)
        throw new RangeError("Invalid video frame.");
      let clipIndex = starts.length - 1;
      while (starts[clipIndex]!.frame > index) clipIndex--;
      const start = starts[clipIndex]!;
      const sample = clips[clipIndex]!.frame(index - start.frame);
      return {
        shotIndex: clipIndex,
        timestampSeconds: (start.us + sample.timestampUs) / 1_000_000,
        durationSeconds: (sample.endUs - sample.timestampUs) / 1_000_000,
        cameraTimeSeconds: sample.cameraTimeSeconds,
        camera: sample.camera,
      };
    },
  };
}

export type VideoTimeline = ReturnType<typeof createVideoTimeline>;
