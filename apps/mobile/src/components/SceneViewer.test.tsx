import { migrateScene } from "@oculo/scene-schema";
// @vitest-environment jsdom
import { createRef, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CameraState,
  LoadOptions,
  SceneEngine,
  SceneEngineOptions,
  SceneSource,
} from "@oculo/scene-core";
import type * as SceneCore from "@oculo/scene-core";
import type { SceneDescriptor } from "@oculo/scene-schema";
import { cloneCamera, DEFAULT_CAMERA } from "../types/project";
import { toCameraState } from "../services/cameraState";
import { SceneViewer } from "./SceneViewer";

interface EngineDouble {
  load: ReturnType<typeof vi.fn<(source: SceneSource, options: LoadOptions) => Promise<void>>>;
  prepareFrame: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<void>>>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  setCameraState: ReturnType<typeof vi.fn>;
  getCameraState: ReturnType<typeof vi.fn<() => CameraState>>;
  options: SceneEngineOptions;
  listeners: Set<(state: CameraState) => void>;
}
const harness = vi.hoisted(() => ({
  engines: [] as EngineDouble[],
  loads: [] as Promise<void>[],
  preparations: [] as Promise<void>[],
  resizeObservers: [] as { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[],
}));

vi.mock("@oculo/scene-core", async (importOriginal) => {
  const { fitOutputFrame } = await importOriginal<typeof SceneCore>();
  return {
    fitOutputFrame,
    BundledSceneSource: class {
      constructor(readonly descriptor: SceneDescriptor) {}
      async load() {
        return this.descriptor;
      }
    },
    SceneEngine: class {
      listeners = new Set<(state: CameraState) => void>();
      state!: CameraState;
      load = vi.fn<(source: SceneSource, options: LoadOptions) => Promise<void>>(async () => {
        await (harness.loads.shift() ?? Promise.resolve());
      });
      prepareFrame = vi.fn<(signal?: AbortSignal) => Promise<void>>(async () => {
        await (harness.preparations.shift() ?? Promise.resolve());
      });
      start = vi.fn();
      stop = vi.fn();
      dispose = vi.fn();
      resize = vi.fn();
      setCameraState = vi.fn((state: CameraState) => {
        this.state = state;
      });
      getCameraState = vi.fn(() => this.state);
      onCameraStateChange(listener: (state: CameraState) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      constructor(readonly options: SceneEngineOptions) {
        harness.engines.push(this);
      }
    },
  };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ComponentProps<typeof SceneViewer>> = {}) {
  const camera = cloneCamera(DEFAULT_CAMERA);
  const props: ComponentProps<typeof SceneViewer> = {
    descriptor: migrateScene({
      id: "garden",
      name: "Garden",
      source: "bundled",
      splatUrl: "/garden.spz",
    }),
    camera,
    liveCameraRef: { current: camera },
    engineRef: createRef<SceneEngine>(),
    onReady: vi.fn(),
    onError: vi.fn(),
    onProgress: vi.fn(),
    onCameraChange: vi.fn(),
    showGrid: false,
    showSafeFrame: true,
    ...overrides,
  };
  return { ...render(<SceneViewer {...props} />), props };
}

beforeEach(() => {
  harness.engines.length = 0;
  harness.loads.length = 0;
  harness.preparations.length = 0;
  harness.resizeObservers.length = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(readonly callback: () => void) {
        harness.resizeObservers.push(this);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SceneViewer scene lifecycle", () => {
  it("waits for Spark's prepared first frame before enabling synchronous shot capture", async () => {
    const preparation = deferred();
    harness.preparations.push(preparation.promise);
    const { props } = setup();
    await waitFor(() => expect(harness.engines[0]?.prepareFrame).toHaveBeenCalledOnce());
    const engine = harness.engines[0]!;
    expect(props.onReady).not.toHaveBeenCalled();
    expect(engine.prepareFrame).toHaveBeenCalledWith(engine.load.mock.calls[0]![1].signal);
    await act(async () => {
      preparation.resolve();
      await preparation.promise;
    });
    expect(props.onReady).toHaveBeenCalledOnce();
  });

  it("installs the saved camera before loading and fits the output independently of viewport shape", async () => {
    const { props, container } = setup();
    await waitFor(() => expect(props.onReady).toHaveBeenCalledOnce());
    const engine = harness.engines[0]!;
    expect(engine.options).toMatchObject({ autoStart: false, autoResize: false });
    expect(engine.setCameraState).toHaveBeenCalledWith(toCameraState(props.camera), {
      emitChange: false,
    });
    expect(engine.setCameraState.mock.invocationCallOrder[0]).toBeLessThan(
      engine.load.mock.invocationCallOrder[0]!,
    );
    expect(engine.resize).toHaveBeenLastCalledWith(390, 219.375);
    expect((container.querySelector(".output-frame") as HTMLElement).style.width).toBe("390px");
    expect((container.querySelector(".output-frame") as HTMLElement).style.height).toBe(
      "219.375px",
    );
    expect(engine.start).toHaveBeenCalledOnce();
    expect(engine.load.mock.calls[0]?.[1].signal?.aborted).toBe(false);
  });

  it("aborts a departing scene and ignores its late progress, camera, and readiness events", async () => {
    const loading = deferred();
    harness.loads.push(loading.promise);
    const { props, unmount } = setup();
    await waitFor(() => expect(harness.engines).toHaveLength(1));
    const engine = harness.engines[0]!;
    const callbacks = [...engine.listeners];
    const options = engine.load.mock.calls[0]![1];
    const replacement = {} as SceneEngine;
    props.engineRef.current = replacement;
    unmount();
    expect(options.signal?.aborted).toBe(true);
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(props.engineRef.current).toBe(replacement);
    expect(engine.listeners.size).toBe(0);
    await act(async () => {
      options.onProgress?.({ loadedBytes: 20, totalBytes: 20, fraction: 1 });
      callbacks.forEach((callback) =>
        callback({ ...toCameraState(props.camera), position: [5, 6, 7] }),
      );
      loading.resolve();
      await loading.promise;
    });
    expect(props.onReady).not.toHaveBeenCalled();
    expect(props.onProgress).not.toHaveBeenCalled();
    expect(props.onCameraChange).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("pauses rendering on background and page departure without advancing the saved camera", async () => {
    const { props } = setup();
    await waitFor(() => expect(props.onReady).toHaveBeenCalledOnce());
    const engine = harness.engines[0]!;
    const current = { ...toCameraState(props.camera), position: [3, 2, 1] as const };
    engine.getCameraState.mockReturnValue(current);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(engine.stop).toHaveBeenCalledOnce();
    expect(engine.setCameraState).toHaveBeenLastCalledWith(current, { emitChange: false });
    fireEvent(window, new Event("pageshow"));
    expect(engine.start).toHaveBeenCalledOnce();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(engine.start).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("pagehide"));
    expect(engine.stop).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event("pageshow"));
    expect(engine.start).toHaveBeenCalledTimes(3);
    expect(props.onCameraChange).not.toHaveBeenCalled();
  });

  it("does not start a hidden viewer until it becomes visible", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { props } = setup();
    await waitFor(() => expect(props.onReady).toHaveBeenCalledOnce());
    const engine = harness.engines[0]!;
    expect(engine.start).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(engine.start).toHaveBeenCalledOnce();
  });

  it("surfaces a load failure and starts a clean engine with the latest camera on retry", async () => {
    const loading = deferred();
    harness.loads.push(loading.promise);
    const first = setup();
    await waitFor(() => expect(harness.engines).toHaveLength(1));
    await act(async () => {
      loading.reject(new Error("Download interrupted"));
    });
    expect(first.props.onError).toHaveBeenCalledWith("Download interrupted");
    const engine = harness.engines[0]!;
    fireEvent(window, new Event("pageshow"));
    expect(engine.start).toHaveBeenCalledOnce();
    first.unmount();
    expect(first.props.engineRef.current).toBeNull();
    const camera = { ...first.props.camera, focalLengthMm: 50 };
    const retry = setup({ ...first.props, camera, liveCameraRef: { current: camera } });
    await waitFor(() => expect(retry.props.onReady).toHaveBeenCalledOnce());
    expect(harness.engines[1]?.setCameraState).toHaveBeenCalledWith(toCameraState(camera), {
      emitChange: false,
    });
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it("releases local asset URLs only after disposal and uses resolved assets for loading", async () => {
    const release = vi.fn();
    const resolved: SceneDescriptor = migrateScene({
      id: "imported",
      name: "My location",
      source: "imported",
      splatUrl: "blob:local-asset",
    });
    const resolveScene = vi.fn(async () => ({ scene: resolved, release }));
    const { props, unmount } = setup({ resolveScene });
    await waitFor(() => expect(props.onReady).toHaveBeenCalledOnce());
    const engine = harness.engines[0]!;
    expect(resolveScene).toHaveBeenCalledWith(props.descriptor, expect.any(AbortSignal));
    expect(await engine.load.mock.calls[0]![0].load()).toBe(resolved);
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledOnce();
    expect(engine.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
  });

  it("immediately releases a failed local scene before offering retry and cleans up only once", async () => {
    const loading = deferred();
    harness.loads.push(loading.promise);
    const release = vi.fn();
    const resolveScene = vi.fn(async (scene: SceneDescriptor) => ({
      scene: { ...scene, splatUrl: "blob:failed-asset" },
      release,
    }));
    const { props, unmount } = setup({ resolveScene });
    await waitFor(() => expect(harness.engines).toHaveLength(1));
    const engine = harness.engines[0]!;
    await act(async () => {
      loading.reject(new Error("Scene decoding failed"));
    });
    expect(props.onError).toHaveBeenCalledWith("Scene decoding failed");
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(engine.listeners.size).toBe(0);
    expect(props.engineRef.current).toBeNull();
    expect(release).toHaveBeenCalledOnce();
    expect(engine.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(props.onError!).mock.invocationCallOrder[0]!,
    );
    unmount();
    expect(release).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up an asset resolver that finishes after unmount without creating a renderer", async () => {
    const resolved = deferred<{ scene: SceneDescriptor; release: () => void }>();
    const resolveScene = vi.fn(() => resolved.promise);
    const { props, unmount } = setup({ resolveScene });
    await waitFor(() => expect(resolveScene).toHaveBeenCalledOnce());
    unmount();
    const release = vi.fn();
    await act(async () => {
      resolved.resolve({ scene: props.descriptor, release });
      await resolved.promise;
    });
    expect(release).toHaveBeenCalledOnce();
    expect(harness.engines).toHaveLength(0);
    expect(props.onReady).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("keeps fitting on window resize when ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { props } = setup();
    await waitFor(() => expect(props.onReady).toHaveBeenCalledOnce());
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(768);
    fireEvent(window, new Event("resize"));
    expect(harness.engines[0]?.resize).toHaveBeenLastCalledWith(1024, 576);
  });
});
