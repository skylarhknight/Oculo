import { createWorkspaceStore } from "../store/WorkspaceStore";
import { firstScene, migrated } from "./projectFixtures";
import { migrateScene, shotKeyframeCamera } from "@oculo/scene-schema";
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SceneEngine,
  type CameraPoseSource,
  type DevicePoseListener,
  type PoseTrackingQuality,
  type PoseTrackingQualityListener,
} from "@oculo/scene-core";
import { MagicWindowControls } from "../components/MagicWindowControls";
import { ProjectSaveCoordinator } from "../services/ProjectSaveCoordinator";
import { fromCameraState, toCameraState } from "../services/cameraState";
import { IndexedDBProjectStore } from "../store/ProjectStore";
import { DEFAULT_CAMERA, type SceneWorkspace } from "../types/project";

// Mock only the GPU boundary; retain SceneEngine, OrbitControls, Three camera
// math, tracking-quality handling, the save coordinator and IndexedDB storage.
vi.mock(
  "../../../../packages/scene-core/node_modules/three/build/three.module.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    WebGLRenderer: class {
      readonly domElement: HTMLCanvasElement;
      render = vi.fn();
      dispose = vi.fn();
      constructor(options: { canvas: HTMLCanvasElement }) {
        this.domElement = options.canvas;
      }
      setPixelRatio() {}
      setSize(width: number, height: number) {
        this.domElement.width = width;
        this.domElement.height = height;
      }
    },
  }),
);
vi.mock(
  "../../../../packages/scene-core/node_modules/@sparkjsdev/spark/dist/spark.module.js",
  async () => {
    const { Object3D } = await vi.importActual<{ Object3D: new () => object }>(
      "../../../../packages/scene-core/node_modules/three/build/three.module.js",
    );
    return { SparkRenderer: class extends Object3D {}, SplatMesh: class extends Object3D {} };
  },
);
const source = vi.hoisted(() => ({
  isAvailable: vi.fn<CameraPoseSource["isAvailable"]>(),
  start: vi.fn<CameraPoseSource["start"]>(),
  stop: vi.fn<CameraPoseSource["stop"]>(),
  onPose: vi.fn<CameraPoseSource["onPose"]>(),
  onTrackingQuality: vi.fn<CameraPoseSource["onTrackingQuality"]>(),
  poses: new Set<DevicePoseListener>(),
  qualities: new Set<PoseTrackingQualityListener>(),
}));
vi.mock("../services/DevicePoseService", () => ({ createDevicePoseSource: () => source }));
vi.mock("../services/haptics", () => ({
  confirmHaptic: vi.fn(),
  tapHaptic: vi.fn(),
  warnHaptic: vi.fn(),
}));

const engines: SceneEngine[] = [];
const databaseNames: string[] = [];
function engine() {
  const canvas = document.createElement("canvas");
  const result = new SceneEngine({
    canvas,
    autoResize: false,
    autoStart: false,
    pixelRatio: 1,
    cameraEventIntervalMs: 0,
  });
  engines.push(result);
  return result;
}
function emitQuality(quality: PoseTrackingQuality) {
  source.qualities.forEach((listener) => listener(quality));
}
function emitPose(x: number, yaw = 0) {
  source.poses.forEach((listener) =>
    listener({
      position: [x, 0, 0],
      quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      timestampMs: performance.now(),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  source.poses.clear();
  source.qualities.clear();
  source.isAvailable.mockResolvedValue(true);
  source.start.mockResolvedValue(undefined);
  source.stop.mockResolvedValue(undefined);
  source.onPose.mockImplementation((listener) => {
    source.poses.add(listener);
    return () => source.poses.delete(listener);
  });
  source.onTrackingQuality.mockImplementation((listener) => {
    source.qualities.add(listener);
    return () => source.qualities.delete(listener);
  });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(async () => {
  cleanup();
  engines.splice(0).forEach((value) => value.dispose());
  databaseNames.splice(0).forEach((name) => indexedDB.deleteDatabase(name));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tracking loss through durable project recovery", () => {
  it("holds an exact rolled endpoint through lost/relocalized poses, saves offline, and reopens with its speed curve", async () => {
    const activeEngine = engine();
    const camera = structuredClone(DEFAULT_CAMERA);
    camera.pose = { position: [3, 2, 7], quaternion: [0, 0, Math.sin(0.3 / 2), Math.cos(0.3 / 2)] };
    camera.focalLengthMm = 47;
    const legacy = {
      schemaVersion: 2 as const,
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "tracked-project",
      name: "Location",
      updatedAt: 1,
      durationSeconds: 8,
      scene: migrateScene({
        id: "scene",
        name: "Location",
        source: "bundled",
        splatUrl: "/location.spz",
      }),
      camera,
      shots: [],
      settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
      path: {
        sceneId: "scene",
        assetVersionId: "legacy-scene:scene",
        id: "move",
        name: "Move",
        keyframes: [
          {
            timeSeconds: 0,
            camera: structuredClone(DEFAULT_CAMERA),
            speedCurve: {
              version: 1,
              points: [
                { time: 0, speed: 0, intensity: 1 },
                { time: 0.3, speed: 2, intensity: 0.4 },
                { time: 1, speed: 1, intensity: 0.2 },
              ],
            },
          },
          { timeSeconds: 8, camera: structuredClone(camera) },
        ],
      },
    };
    let project: SceneWorkspace = firstScene(migrated(legacy));
    activeEngine.setCameraState(toCameraState(camera), { emitChange: false });
    const endpoint = activeEngine.getCameraState();
    const databaseName = `oculo-tracking-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const store = new IndexedDBProjectStore(databaseName);
    await store.put(migrated(legacy));
    const saves = new ProjectSaveCoordinator(createWorkspaceStore(store));
    const removeCameraListener = activeEngine.onCameraStateChange((state) => {
      project = {
        ...project,
        camera: fromCameraState(state, project.camera),
        updatedAt: Date.now(),
      };
      saves.schedule(project);
    });
    const engineRef = createRef<SceneEngine>();
    engineRef.current = activeEngine;
    const view = render(<MagicWindowControls engineRef={engineRef} />);
    fireEvent.click(await screen.findByRole("button", { name: "Magic Window" }));
    await screen.findByRole("button", { name: "Exit Magic Window" });
    act(() => {
      emitQuality("normal");
      emitPose(10);
    });
    expect(activeEngine.getCameraState()).toEqual(endpoint);
    act(() => emitPose(12, 0.4));
    expect(activeEngine.getCameraState()).not.toEqual(endpoint);
    // Recall the planned endpoint after healthy tracking has already queued a
    // different live pose, so the save barrier must retain the newer camera.
    activeEngine.setCameraState(endpoint);
    expect(activeEngine.getCameraState()).toEqual(endpoint);

    for (const quality of ["limited", "unavailable", "initializing"] as const) {
      act(() => {
        emitQuality(quality);
        emitPose(500, Math.PI);
      });
      expect(activeEngine.getCameraState()).toEqual(endpoint);
    }
    // A completely new tracking origin and orientation anchors at the held
    // camera instead of applying the discontinuity to the planned shot.
    act(() => {
      emitQuality("normal");
      emitPose(1000, Math.PI / 2);
    });
    expect(activeEngine.getCameraState()).toEqual(endpoint);
    activeEngine.resize(390, 844);
    expect(activeEngine.getCameraState()).toEqual(endpoint);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Offline"))),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(activeEngine.isHandheldActive).toBe(false);
    expect(activeEngine.getCameraState()).toEqual(endpoint);
    // Same commit barrier as App's background handler, with actual IndexedDB.
    project = {
      ...project,
      camera: fromCameraState(activeEngine.getCameraState(), project.camera),
    };
    await saves.flush(project);
    expect(saves.getState().status).toBe("saved");
    const expected = structuredClone(project);
    view.unmount();
    removeCameraListener();
    activeEngine.dispose();
    project.camera.pose.position[0] = 999;

    const reopened = firstScene((await new IndexedDBProjectStore(databaseName).get(expected.id))!);
    expect(reopened).toEqual(expected);
    const end = shotKeyframeCamera(
      reopened.shots.at(-1)!.setup,
      reopened.shots.at(-1)!.keyframes.at(-1)!,
    );
    expect(end.pose).toEqual(camera.pose);
    expect(end.focalLengthMm).toBe(camera.focalLengthMm);
    expect(reopened.shots.at(-1)!.keyframes[0]!.speedCurve?.points).toHaveLength(3);
    const restartedEngine = engine();
    restartedEngine.setCameraState(toCameraState(reopened.camera), { emitChange: false });
    expect(restartedEngine.getCameraState()).toEqual(endpoint);
    expect(fetch).not.toHaveBeenCalled();
  });
});
