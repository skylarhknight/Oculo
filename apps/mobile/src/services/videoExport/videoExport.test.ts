import { describe, expect, it, vi } from "vitest";
import { createSpeedCurvePreset, shotCameraAt } from "@oculo/camera-core";
import { shotKeyframeCamera, type Shot } from "@oculo/scene-schema";
import type { CameraState } from "@oculo/scene-core";
import { DEFAULT_CAMERA } from "../../types/project";
import { toCameraState } from "../cameraState";
import { createVideoTimeline, exportShotVideo, type VideoExportOptions } from ".";
import { videoDimensions } from "./timeline";
import type { VideoEncoderSession } from "./encoder";
import { videoAttributionText } from "./attribution";

function move(duration = 5): Shot {
  return {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    id: "move",
    name: "Move",
    createdAt: "2026-09-25T00:00:00.000Z",
    durationSeconds: duration,
    setup: {
      lens: { kind: "zoom", minFocalLengthMm: 24, maxFocalLengthMm: 85 },
      sensorWidthMm: DEFAULT_CAMERA.sensorWidthMm,
      sensorHeightMm: DEFAULT_CAMERA.sensorHeightMm,
      output: { aspectRatio: 1, crop: "center-inside-sensor" },
      near: DEFAULT_CAMERA.near,
      far: DEFAULT_CAMERA.far,
    },
    keyframes: [
      {
        id: "start",
        timeSeconds: 0,
        pose: structuredClone(DEFAULT_CAMERA.pose),
        focalLengthMm: DEFAULT_CAMERA.focalLengthMm,
        focusDistanceM: 3,
        apertureFStop: 2.8,
        speedCurve: createSpeedCurvePreset("ease-in-out"),
      },
      {
        id: "end",
        timeSeconds: duration,
        pose: { position: [4, 2, 5], quaternion: [0, 0, Math.sin(0.2), Math.cos(0.2)] },
        focalLengthMm: 85,
        focusDistanceM: 1,
        apertureFStop: 5.6,
      },
    ],
  };
}

const endpoint = (shot: Shot, index: number) =>
  shotKeyframeCamera(shot.setup, shot.keyframes[index]!);

function harness() {
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const capture = {
    render: vi
      .fn<
        (
          _camera: CameraState,
          _width: number,
          _height: number,
          _signal?: AbortSignal,
        ) => Promise<HTMLCanvasElement>
      >()
      .mockResolvedValue(canvas),
    dispose: vi.fn(),
  };
  const engine = {
    beginFrameCapture: vi.fn(() => capture),
  } as unknown as VideoExportOptions["engine"];
  const encoder: VideoEncoderSession = {
    add: vi.fn(async () => undefined),
    finish: vi.fn(async () => new Blob(["mp4"], { type: "video/mp4" })),
    cancel: vi.fn(async () => undefined),
  };
  return {
    canvas,
    context,
    capture,
    engine,
    encoder,
    dependencies: {
      encoder: vi.fn(async () => encoder),
      canvas: () => canvas,
      yieldTask: async () => undefined,
    },
  };
}

describe("deterministic video timeline", () => {
  it("preserves the exact saved camera endpoints, lens, duration and speed-curve samples", () => {
    const path = move();
    const timeline = createVideoTimeline(path);
    expect(timeline.frameCount).toBe(150);
    expect(timeline.frame(0).camera).toEqual(toCameraState(endpoint(path, 0)));
    expect(timeline.frame(149).camera).toEqual(toCameraState(endpoint(path, 1)));
    expect(timeline.frame(149).timestampSeconds + timeline.frame(149).durationSeconds).toBe(5);
    for (const i of [1, 37, 75, 100, 148]) {
      const frame = timeline.frame(i);
      expect(frame.camera).toEqual(toCameraState(shotCameraAt(path, frame.timestampSeconds)));
    }
    expect(timeline.frame(37).camera).not.toEqual(
      toCameraState(
        shotCameraAt(
          {
            ...path,
            keyframes: path.keyframes.map((frame) => {
              const linear = { ...frame };
              delete linear.speedCurve;
              return linear;
            }),
          },
          timeline.frame(37).timestampSeconds,
        ),
      ),
    );
  });

  it("keeps fractional durations contiguous to microsecond precision and freezes the input", () => {
    const path = move(5.123);
    const timeline = createVideoTimeline(path);
    path.keyframes[0]!.focalLengthMm = 999;
    let end = 0;
    for (let i = 0; i < timeline.frameCount; i++) {
      const frame = timeline.frame(i);
      expect(frame.timestampSeconds).toBeCloseTo(end, 6);
      expect(frame.durationSeconds).toBeGreaterThan(0);
      end = frame.timestampSeconds + frame.durationSeconds;
    }
    expect(end).toBeCloseTo(5.123, 6);
    expect(timeline.frame(0).camera).toEqual(toCameraState(endpoint(move(5.123), 0)));
  });

  it("rejects malformed and over-long shots without trimming them, and holds a static shot", () => {
    expect(() => createVideoTimeline(move(61))).toThrow(/invalid/);
    expect(() => createVideoTimeline({ ...move(), durationSeconds: 3 })).toThrow(/invalid/);
    expect(() => createVideoTimeline({ ...move(), keyframes: [] })).toThrow(/invalid/);
    const path = move();
    path.keyframes[1]!.pose.quaternion = [0, 0, 0, 0];
    expect(() => createVideoTimeline(path)).toThrow(/invalid/);
    const still = { ...move(), durationSeconds: 3, keyframes: move().keyframes.slice(0, 1) };
    const held = createVideoTimeline(still);
    expect(held.frameCount).toBe(90);
    expect(held.frame(89).camera).toEqual(held.frame(0).camera);
  });

  it("plays several shots back to back with hard cuts and no gaps", () => {
    const first = move(1);
    const second = { ...move(2), id: "second", name: "Second" };
    second.setup = {
      ...second.setup,
      output: { aspectRatio: 16 / 9, crop: "center-inside-sensor" },
    };
    const timeline = createVideoTimeline([first, second]);
    // The sequence takes the first shot's frame.
    expect({ width: timeline.width, height: timeline.height }).toEqual({ width: 720, height: 720 });
    expect(timeline.frameCount).toBe(30 + 60);
    expect(timeline.shotStarts).toEqual([0, 30]);
    expect(timeline.durationSeconds).toBe(3);
    // The cut: the first shot ends on its last keyframe, the second starts on its first.
    expect(timeline.frame(29).camera).toEqual(toCameraState(endpoint(first, 1)));
    expect(timeline.frame(30).camera).toEqual(toCameraState(endpoint(second, 0)));
    expect(timeline.frame(30).shotIndex).toBe(1);
    let end = 0;
    for (let i = 0; i < timeline.frameCount; i++) {
      const frame = timeline.frame(i);
      expect(frame.timestampSeconds).toBeCloseTo(end, 6);
      end = frame.timestampSeconds + frame.durationSeconds;
    }
    expect(end).toBeCloseTo(3, 6);
  });

  it("caps a sequence at two minutes and refuses an empty one", () => {
    expect(() => createVideoTimeline([move(50), move(50), move(50)])).toThrow(/120 seconds/);
    expect(() => createVideoTimeline([])).toThrow(/at least one/);
  });

  it("bounds landscape and portrait video size using even codec dimensions", () => {
    expect(videoDimensions(16 / 9)).toEqual({ width: 1280, height: 720 });
    expect(videoDimensions(9 / 16)).toEqual({ width: 720, height: 1280 });
    expect(videoDimensions(1)).toEqual({ width: 720, height: 720 });
    expect(() => videoDimensions(Infinity)).toThrow();
  });
});

describe("video export lifecycle", () => {
  it("retains full source attribution in the encoded file metadata", async () => {
    const h = harness();
    const attribution = {
      text: "Scene by Creator",
      url: "https://example.com/scene",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    };
    const pending = exportShotVideo(
      {
        engine: h.engine,
        shot: move(0.5),
        projectName: "Camera test",
        attribution,
      },
      h.dependencies,
    );
    attribution.text = "Changed after export started";
    await pending;
    expect(h.dependencies.encoder).toHaveBeenCalledWith(h.canvas, {
      title: "Camera test — Move",
      description:
        "Scene by Creator\nSource: https://example.com/scene\nLicense: CC BY 4.0\nLicense URL: https://creativecommons.org/licenses/by/4.0/\nChanges: Camera framing, lens settings, and animated motion rendered in Oculo.",
      comment:
        "Scene by Creator\nSource: https://example.com/scene\nLicense: CC BY 4.0\nLicense URL: https://creativecommons.org/licenses/by/4.0/\nChanges: Camera framing, lens settings, and animated motion rendered in Oculo.",
    });
    expect(videoAttributionText(undefined)).toBeUndefined();
  });
  it("renders all saved camera samples in order at the shot aspect, and releases capture", async () => {
    const h = harness();
    const progress = vi.fn();
    const path = move(0.5);
    const result = await exportShotVideo(
      {
        engine: h.engine,
        shot: path,
        projectName: "../Scene/camera",
        onProgress: progress,
      },
      h.dependencies,
    );
    expect(h.capture.render).toHaveBeenCalledTimes(15);
    expect(h.capture.render.mock.calls[0]![0]).toEqual(toCameraState(endpoint(path, 0)));
    expect(h.capture.render.mock.calls[14]![0]).toEqual(toCameraState(endpoint(path, 1)));
    expect(h.context.drawImage).toHaveBeenLastCalledWith(h.canvas, 0, 0, 720, 720);
    expect(h.encoder.add).toHaveBeenLastCalledWith(0.466667, 0.033333, true);
    expect(progress).toHaveBeenLastCalledWith({ phase: "finishing", completed: 15, total: 15 });
    expect(result.name).toBe("Scenecamera-camera-move.mp4");
    expect(h.capture.dispose).toHaveBeenCalledOnce();
    expect(h.canvas.width).toBe(0);
    expect(h.encoder.cancel).not.toHaveBeenCalled();
  });

  it("stitches shots into one MP4 with a keyframe at every cut", async () => {
    const h = harness();
    const progress = vi.fn();
    const result = await exportShotVideo(
      {
        engine: h.engine,
        shot: [move(0.5), { ...move(0.5), id: "b", name: "B" }],
        projectName: "Plan",
        onProgress: progress,
      },
      h.dependencies,
    );
    expect(h.capture.render).toHaveBeenCalledTimes(30);
    expect(h.capture.dispose).toHaveBeenCalledOnce();
    const adds = vi.mocked(h.encoder.add).mock.calls;
    expect(adds[15]![2]).toBe(true);
    expect(adds[14]![2]).toBe(false);
    expect(progress).toHaveBeenCalledWith({
      phase: "rendering",
      completed: 16,
      total: 30,
      shotIndex: 1,
    });
    expect(result.name).toBe("Plan-shot-sequence.mp4");
    expect(result.durationSeconds).toBe(1);
  });

  it("cancels before the next frame and releases encoder, canvas, and camera", async () => {
    const h = harness();
    const controller = new AbortController();
    await expect(
      exportShotVideo(
        {
          engine: h.engine,
          shot: move(0.5),
          signal: controller.signal,
          onProgress: ({ completed }) => {
            if (completed === 2) controller.abort();
          },
        },
        h.dependencies,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.capture.render).toHaveBeenCalledTimes(2);
    expect(h.encoder.cancel).toHaveBeenCalledOnce();
    expect(h.capture.dispose).toHaveBeenCalledOnce();
    expect(h.canvas.height).toBe(0);
  });

  it("cleans up failed encoders and permits a successful fresh attempt", async () => {
    const h = harness();
    vi.mocked(h.encoder.add).mockRejectedValueOnce(new Error("Encoder failed"));
    await expect(
      exportShotVideo({ engine: h.engine, shot: move(0.5) }, h.dependencies),
    ).rejects.toThrow("Encoder failed");
    expect(h.encoder.cancel).toHaveBeenCalledOnce();
    expect(h.capture.dispose).toHaveBeenCalledOnce();
    await expect(
      exportShotVideo({ engine: h.engine, shot: move(0.5) }, h.dependencies),
    ).resolves.toMatchObject({ frameCount: 15 });
  });

  it("releases a capture promptly when cancellation interrupts a stalled encoder", async () => {
    const h = harness();
    const controller = new AbortController();
    vi.mocked(h.encoder.add).mockImplementationOnce(() => {
      controller.abort();
      return new Promise(() => undefined);
    });
    await expect(
      exportShotVideo(
        { engine: h.engine, shot: move(0.5), signal: controller.signal },
        h.dependencies,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.encoder.cancel).toHaveBeenCalledOnce();
    expect(h.capture.dispose).toHaveBeenCalledOnce();
    expect(h.canvas.width).toBe(0);
  });

  it("rejects unsupported encoding before taking camera ownership", async () => {
    const h = harness();
    h.dependencies.encoder.mockRejectedValueOnce(new Error("MP4 unavailable"));
    await expect(
      exportShotVideo({ engine: h.engine, shot: move() }, h.dependencies),
    ).rejects.toThrow("unavailable");
    expect(h.engine.beginFrameCapture).not.toHaveBeenCalled();
    expect(h.canvas.width).toBe(0);
  });

  it.each(["success", "failure"] as const)(
    "cancels stalled initialization promptly and safely handles its late %s",
    async (outcome) => {
      const h = harness();
      const controller = new AbortController();
      let resolveInitialization!: (encoder: VideoEncoderSession) => void;
      let rejectInitialization!: (error: Error) => void;
      h.dependencies.encoder.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveInitialization = resolve;
          rejectInitialization = reject;
        }),
      );
      let failure: unknown;
      const pending = exportShotVideo(
        { engine: h.engine, shot: move(0.5), signal: controller.signal },
        h.dependencies,
      ).catch((error: unknown) => {
        failure = error;
      });
      controller.abort();
      // The caller must return before the initialization promise settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        expect(failure).toMatchObject({ name: "AbortError" });
        expect(h.engine.beginFrameCapture).not.toHaveBeenCalled();
        expect(h.canvas.width).toBe(0);
      } finally {
        if (outcome === "success") resolveInitialization(h.encoder);
        else rejectInitialization(new Error("Late codec startup failure"));
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(h.encoder.cancel).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(h.engine.beginFrameCapture).not.toHaveBeenCalled();
    },
  );
});
