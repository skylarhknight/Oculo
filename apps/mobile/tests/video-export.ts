import { migrateScene } from "@oculo/scene-schema";
import { SceneEngine } from "@oculo/scene-core";
import { defaultCameraPathInterpolator, createSpeedCurvePreset } from "@oculo/camera-core";
import type { CameraPath, CinematicCamera } from "@oculo/scene-schema";
import { DEFAULT_CAMERA } from "../src/types/project";
import { toCameraState } from "../src/services/cameraState";
import { exportCameraPathVideo } from "../src/services/videoExport";
import { videoAttributionText } from "../src/services/videoExport/attribution";

const status = document.querySelector("#status")!;
const dataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
function camera(
  position: [number, number, number],
  focalLengthMm: number,
  outputAspectRatio: number,
  roll = 0,
): CinematicCamera {
  return {
    ...DEFAULT_CAMERA,
    focalLengthMm,
    output: { aspectRatio: outputAspectRatio, crop: "center-inside-sensor" },
    pose: { position, quaternion: [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)] },
  };
}

async function run() {
  const engine = new SceneEngine({
    canvas: document.querySelector("#scene")!,
    autoStart: false,
    autoResize: false,
    pixelRatio: 1,
    resolveSplatUrl: () => "/test-fixtures/colored-wall.spz",
  });
  try {
    await engine.loadDescriptor(
      migrateScene({
        id: "test-wall",
        name: "Colored wall",
        source: "imported",
        splatUrl: "/test-fixtures/colored-wall.spz",
      }),
    );
    const original = engine.getCameraState();
    const path: CameraPath = {
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "fixture-path",
      name: "Lens and speed fixture",
      keyframes: [
        {
          timeSeconds: 0,
          camera: camera([-0.4, 0, 3.5], 35, 16 / 9),
          speedCurve: createSpeedCurvePreset("ease-in"),
        },
        {
          timeSeconds: 2,
          camera: camera([0, 0.3, 3.2], 50, 4 / 3, 0.15),
          speedCurve: createSpeedCurvePreset("ease-out"),
        },
        { timeSeconds: 5, camera: camera([0.5, 0.1, 3.3], 28, 1, -0.1) },
      ],
    };
    const result = await exportCameraPathVideo({
      engine,
      path,
      durationSeconds: 5,
      projectName: "Video verification",
      attribution: {
        text: "Synthetic fixture credit for metadata verification",
        url: "https://example.com/oculo/colored-wall",
        license: "Test fixture license",
        licenseUrl: "https://example.com/oculo/fixture-license",
      },
      onProgress: (progress) => {
        status.textContent = `${progress.phase}: ${progress.completed}/${progress.total}`;
      },
    });
    if (JSON.stringify(engine.getCameraState()) !== JSON.stringify(original))
      throw new Error("Export changed the live camera");
    const references: { index: number; timestampSeconds: number; png: string }[] = [];
    const capture = engine.beginFrameCapture();
    try {
      // Independent reference schedule: saved first/last endpoints and actual
      // presentation timestamps, including the middle saved waypoint at t=2.
      for (const index of [0, 30, 60, 100, 149]) {
        const timestampSeconds = Math.round((index * 5_000_000) / 150) / 1_000_000;
        const state = toCameraState(
          defaultCameraPathInterpolator.interpolate(path, index === 149 ? 5 : timestampSeconds),
        );
        const width = Math.min(1280, 720 * state.aspectRatio);
        const height = width / state.aspectRatio;
        const frame = await capture.render(state, Math.round(width), Math.round(height));
        const output = document.createElement("canvas");
        output.width = 1280;
        output.height = 720;
        const context = output.getContext("2d")!;
        context.fillStyle = "#000";
        context.fillRect(0, 0, 1280, 720);
        context.drawImage(frame, (1280 - width) / 2, (720 - height) / 2, width, height);
        references.push({
          index,
          timestampSeconds,
          png: output.toDataURL("image/png").split(",")[1]!,
        });
        output.width = 0;
      }
    } finally {
      capture.dispose();
    }
    const controller = new AbortController();
    let cancellation = false;
    try {
      await exportCameraPathVideo({
        engine,
        path,
        durationSeconds: 5,
        signal: controller.signal,
        onProgress: ({ completed }) => {
          if (completed === 3) controller.abort();
        },
      });
    } catch (error) {
      cancellation = error instanceof DOMException && error.name === "AbortError";
    }
    if (!cancellation || JSON.stringify(engine.getCameraState()) !== JSON.stringify(original))
      throw new Error("Cancellation failed to release and restore the camera");
    const retryCapture = engine.beginFrameCapture();
    await retryCapture.render(toCameraState(path.keyframes[0]!.camera), 960, 540);
    retryCapture.dispose();
    const report = {
      video: await dataUrl(result.blob),
      references,
      frameCount: result.frameCount,
      durationSeconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      cancellation,
      restored: true,
      splatCount: engine.activeSplatMesh?.numSplats,
      expectedAttribution: videoAttributionText({
        text: "Synthetic fixture credit for metadata verification",
        url: "https://example.com/oculo/colored-wall",
        license: "Test fixture license",
        licenseUrl: "https://example.com/oculo/fixture-license",
      }),
    };
    status.textContent =
      "Complete: real Spark frames encoded to MP4; cancellation restored the camera.";
    return report;
  } finally {
    engine.dispose();
  }
}

const state = window as unknown as { videoVerification: Promise<unknown> };
state.videoVerification = run().catch((error) => {
  status.textContent = String(error?.stack ?? error);
  return { error: String(error?.stack ?? error) };
});
