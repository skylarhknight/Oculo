import type { SceneEngine } from "@oculo/scene-core";
import type { Shot } from "@oculo/scene-schema";
import { createMp4Encoder, type VideoEncoderFactory, type VideoEncoderSession } from "./encoder";
import { createVideoTimeline, VIDEO_FRAME_RATE } from "./timeline";
import { videoAttributionText, type VideoAttribution } from "./attribution";

export { createVideoTimeline, MAX_SEQUENCE_DURATION_SECONDS } from "./timeline";

export interface VideoExportProgress {
  phase: "preparing" | "rendering" | "finishing";
  completed: number;
  total: number;
  /** While rendering a sequence: which shot (0-based) the frame belongs to. */
  shotIndex?: number;
}

export interface ExportedVideo {
  blob: Blob;
  name: string;
  width: number;
  height: number;
  frameCount: number;
  durationSeconds: number;
}

export interface VideoExportOptions {
  engine: Pick<SceneEngine, "beginFrameCapture">;
  /** One shot, or several stitched together in this order with hard cuts. */
  shot: Shot | readonly Shot[];
  projectName?: string;
  attribution?: VideoAttribution;
  signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Video export cancelled.", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Video export cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function fileName(name: string, sequence: boolean): string {
  const safe = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} _().-]/gu, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 110)
    .trim();
  return `${safe || "Oculo"}-${sequence ? "shot-sequence" : "camera-move"}.mp4`;
}

/** Offline frame stepping uses saved camera data, never RAF or recording wall time. */
export async function exportShotVideo(
  options: VideoExportOptions,
  dependencies: {
    encoder?: VideoEncoderFactory;
    canvas?: () => HTMLCanvasElement;
    yieldTask?: () => Promise<void>;
  } = {},
): Promise<ExportedVideo> {
  abortIfNeeded(options.signal);
  const timeline = createVideoTimeline(options.shot);
  const shots = Array.isArray(options.shot)
    ? (options.shot as readonly Shot[])
    : [options.shot as Shot];
  const sequence = shots.length > 1;
  const credit = videoAttributionText(options.attribution);
  const metadata = {
    title: `${options.projectName ?? "Oculo"} — ${shots.map((shot) => shot.name).join(" · ")}`,
    ...(credit ? { description: credit, comment: credit } : {}),
  };
  const canvas = (dependencies.canvas ?? (() => document.createElement("canvas")))();
  canvas.width = timeline.width;
  canvas.height = timeline.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A canvas could not be created for video export.");
  let encoder: VideoEncoderSession | undefined;
  let capture: ReturnType<SceneEngine["beginFrameCapture"]> | undefined;
  let complete = false;
  let cancellation: Promise<void> | undefined;
  const cancelEncoder = () => (cancellation ??= encoder?.cancel().catch(() => undefined));
  const onAbort = () => {
    void cancelEncoder();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const progress = (phase: VideoExportProgress["phase"], completed: number, shotIndex?: number) =>
    options.onProgress?.({
      phase,
      completed,
      total: timeline.frameCount,
      ...(sequence && shotIndex !== undefined ? { shotIndex } : {}),
    });
  const cuts = new Set(timeline.shotStarts);
  try {
    progress("preparing", 0);
    abortIfNeeded(options.signal);
    const initialization = (dependencies.encoder ?? createMp4Encoder)(canvas, metadata).then(
      (initialized) => {
        encoder = initialized;
        // Cancellation can already have released the export's canvas while
        // asynchronous codec startup is still pending. Close that late encoder
        // without reacquiring the camera or delaying the caller's cancellation.
        if (options.signal?.aborted) void cancelEncoder();
        return initialized;
      },
    );
    encoder = await abortable(initialization, options.signal);
    abortIfNeeded(options.signal);
    capture = options.engine.beginFrameCapture();
    for (let i = 0; i < timeline.frameCount; i++) {
      abortIfNeeded(options.signal);
      const frame = timeline.frame(i);
      const width = Math.min(timeline.width, timeline.height * frame.camera.aspectRatio);
      const height = width / frame.camera.aspectRatio;
      const rendered = await capture.render(
        frame.camera,
        Math.round(width),
        Math.round(height),
        options.signal,
      );
      abortIfNeeded(options.signal);
      context.fillStyle = "#000";
      context.fillRect(0, 0, timeline.width, timeline.height);
      // Fit the complete camera gate, including changing-aspect paths, in a
      // stable video frame. Never crop or stretch the saved composition.
      context.drawImage(
        rendered,
        (timeline.width - width) / 2,
        (timeline.height - height) / 2,
        width,
        height,
      );
      await abortable(
        encoder.add(
          frame.timestampSeconds,
          frame.durationSeconds,
          // A keyframe every two seconds and at every cut, so players seek to each shot.
          i % (VIDEO_FRAME_RATE * 2) === 0 || cuts.has(i) || i === timeline.frameCount - 1,
        ),
        options.signal,
      );
      progress("rendering", i + 1, frame.shotIndex);
      // Yield to cancellation and UI even if GPU/encoder operations resolved synchronously.
      await (
        dependencies.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      )();
    }
    abortIfNeeded(options.signal);
    progress("finishing", timeline.frameCount);
    const blob = await abortable(encoder.finish(), options.signal);
    abortIfNeeded(options.signal);
    complete = true;
    return {
      blob,
      name: fileName(options.projectName ?? "Oculo", sequence),
      width: timeline.width,
      height: timeline.height,
      frameCount: timeline.frameCount,
      durationSeconds: timeline.durationSeconds,
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!complete) await cancelEncoder();
    capture?.dispose();
    canvas.width = 0;
    canvas.height = 0;
  }
}
