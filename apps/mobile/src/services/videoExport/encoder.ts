import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeVideo,
} from "mediabunny";
import { MAX_VIDEO_BYTES, VIDEO_FRAME_RATE } from "./timeline";

export interface VideoEncoderSession {
  add(timestampSeconds: number, durationSeconds: number, keyFrame: boolean): Promise<void>;
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
}

export interface VideoExportMetadata {
  title: string;
  description?: string;
  comment?: string;
}

export type VideoEncoderFactory = (
  canvas: HTMLCanvasElement,
  metadata?: VideoExportMetadata,
) => Promise<VideoEncoderSession>;

/** In-memory MP4: cancellation leaves no partial files or object URLs behind. */
export const createMp4Encoder: VideoEncoderFactory = async (canvas, metadata) => {
  const config = { codec: "avc" as const, quality: new Quality({ bitrate: 4_000_000 }) };
  if (
    !(await canEncodeVideo("avc", {
      width: canvas.width,
      height: canvas.height,
      quality: config.quality,
    }))
  ) {
    throw new Error(
      "MP4 export is unavailable on this device. You can still share PNG shot sheets.",
    );
  }
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory", metadataFormat: "mdta" }),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, config);
  output.addVideoTrack(source, { frameRate: VIDEO_FRAME_RATE });
  if (metadata) output.setMetadataTags(metadata);
  try {
    await output.start();
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }
  let finished = false;
  let cancelled = false;
  return {
    add: (timestamp, duration, keyFrame) => source.add(timestamp, duration, { keyFrame }),
    finish: async () => {
      await output.finalize();
      finished = true;
      const buffer = output.target.buffer;
      if (!buffer || buffer.byteLength === 0)
        throw new Error("The video encoder returned an empty file. Try exporting again.");
      if (buffer.byteLength > MAX_VIDEO_BYTES)
        throw new Error(
          "The preview exceeds the 64 MB export limit. Choose a shorter move and retry.",
        );
      return new Blob([buffer], { type: "video/mp4" });
    },
    cancel: async () => {
      if (!finished && !cancelled) {
        cancelled = true;
        await output.cancel();
      }
    },
  };
};
