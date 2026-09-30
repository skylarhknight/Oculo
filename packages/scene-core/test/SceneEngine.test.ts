import { migrateScene } from "@oculo/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quaternion, Vector3, type PerspectiveCamera, type Vector2 } from "three";
import type * as Three from "three";

import { SceneEngine, type AnimationScheduler } from "../src/SceneEngine.js";
import type { CameraState } from "../src/types.js";

const splats = vi.hoisted(() => ({
  initializers: [] as Promise<unknown>[],
  meshes: [] as {
    initialized: Promise<unknown>;
    dispose: ReturnType<typeof vi.fn>;
    options: { fileBytes: Uint8Array; fileName: string };
  }[],
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  return {
    ...actual,
    WebGLRenderer: class {
      readonly domElement: HTMLCanvasElement;
      readonly info = {
        memory: { geometries: 0, textures: 0 },
        render: { calls: 0, triangles: 0, points: 0, lines: 0 },
      };
      private pixelRatio = 1;
      private size = { width: 0, height: 0 };
      readonly render = vi.fn();
      readonly dispose = vi.fn();
      constructor(options: { canvas: HTMLCanvasElement }) {
        this.domElement = options.canvas;
      }
      setPixelRatio(value: number) {
        this.pixelRatio = value;
      }
      getPixelRatio() {
        return this.pixelRatio;
      }
      getSize(target: Vector2) {
        return target.set(this.size.width, this.size.height);
      }
      setSize(width: number, height: number) {
        this.size = { width, height };
        this.domElement.width = Math.floor(width * this.pixelRatio);
        this.domElement.height = Math.floor(height * this.pixelRatio);
      }
    },
  };
});

vi.mock("@sparkjsdev/spark", async () => {
  const { Object3D, Vector2 } = await import("three");
  return {
    SparkRenderer: class extends Object3D {
      autoUpdate = true;
      minSortIntervalMs = 100;
      sorting = false;
      renderSize = new Vector2(800, 450);
      enableLod = true;
      enableDriveLod = true;
      update = vi.fn().mockResolvedValue(undefined);
    },
    SplatEditSdfType: { BOX: "box" },
    SplatEditRgbaBlendMode: { MULTIPLY: "multiply" },
    SplatEditSdf: class extends Object3D {
      constructor(readonly options: Record<string, unknown>) {
        super();
      }
    },
    SplatEdit: class extends Object3D {
      constructor(readonly options: { name?: string }) {
        super();
        this.name = options.name ?? "";
      }
    },
    SplatMesh: class extends Object3D {
      initialized: Promise<unknown>;
      dispose = vi.fn();
      constructor(readonly options: { fileBytes: Uint8Array; fileName: string }) {
        super();
        this.initialized = (splats.initializers.shift() ?? Promise.resolve()).then(() => this);
        splats.meshes.push(this);
      }
    },
  };
});

interface CaptureCanvas {
  width: number;
  height: number;
  drawImage: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  toDataURL: ReturnType<typeof vi.fn>;
  getContext: ReturnType<typeof vi.fn>;
}

const engines: SceneEngine[] = [];
let captures: CaptureCanvas[];

beforeEach(() => {
  captures = [];
  splats.initializers.length = 0;
  splats.meshes.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }),
    ),
  );
  vi.spyOn(performance, "now").mockReturnValue(1000);
  vi.stubGlobal("document", {
    createElement: () => {
      const drawImage = vi.fn();
      const clearRect = vi.fn();
      const target = {
        width: 0,
        height: 0,
        drawImage,
        clearRect,
        getContext: vi.fn(() => ({ drawImage, clearRect })),
        toDataURL: vi.fn(() => "data:image/jpeg;base64,captured"),
      };
      captures.push(target);
      return target;
    },
  });
});

afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  width = 800,
  height = 450,
  resolveSplatUrl?: ConstructorParameters<typeof SceneEngine>[0]["resolveSplatUrl"],
) {
  const ownerDocument = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    ownerDocument,
    getRootNode: () => ownerDocument,
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  }) as unknown as HTMLCanvasElement;
  let frame: FrameRequestCallback | undefined;
  const scheduler: AnimationScheduler = {
    request: (callback) => {
      frame = callback;
      return 1;
    },
    cancel: () => {
      frame = undefined;
    },
  };
  const engine = new SceneEngine({
    canvas,
    scheduler,
    autoResize: false,
    autoStart: false,
    pixelRatio: 1,
    ...(resolveSplatUrl ? { resolveSplatUrl } : {}),
  });
  engines.push(engine);
  return {
    engine,
    canvas,
    tick: (time: number) => {
      frame?.(time);
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("SceneEngine interrupted scene loading", () => {
  const descriptor = migrateScene({
    id: "garden",
    name: "Small Garden",
    source: "bundled" as const,
    splatUrl: "https://example.com/scenes/garden.spz",
  });

  it("rejects pre-cancelled loads without replacing a working scene or starting network work", async () => {
    const { engine } = setup();
    await engine.loadDescriptor(descriptor);
    const previous = engine.activeSplatMesh;
    vi.mocked(fetch).mockClear();
    const cancellation = new AbortController();
    cancellation.abort(new Error("Scene closed"));
    const source = { load: vi.fn(async () => descriptor) };
    await expect(engine.load(source, { signal: cancellation.signal })).rejects.toThrow(
      "Scene closed",
    );
    await expect(engine.loadDescriptor(descriptor, cancellation.signal)).rejects.toThrow(
      "Scene closed",
    );
    expect(source.load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(engine.activeSplatMesh).toBe(previous);
  });

  it("cancels a source that ignores AbortSignal and never fetches its late result", async () => {
    const { engine } = setup();
    const source = deferred<typeof descriptor>();
    const cancellation = new AbortController();
    const loading = engine.load({ load: () => source.promise }, { signal: cancellation.signal });
    cancellation.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    source.resolve(descriptor);
    await source.promise;
    expect(fetch).not.toHaveBeenCalled();
    expect(engine.activeDescriptor).toBeUndefined();
  });

  it("cancels the actual streaming body and stops progress delivery", async () => {
    const { engine } = setup();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (stream) => stream.enqueue(new Uint8Array([1, 2])),
        cancel,
      }),
      { headers: { "content-length": "10" } },
    );
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const cancellation = new AbortController();
    const progress = vi.fn();
    const loading = engine.loadDescriptor(descriptor, cancellation.signal, progress);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenLastCalledWith({ loadedBytes: 2, totalBytes: 10, fraction: 0.2 }),
    );
    cancellation.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(splats.meshes).toHaveLength(0);
  });

  it("keeps the ready scene through decode failure and permits a clean retry", async () => {
    const { engine } = setup();
    await engine.loadDescriptor(descriptor);
    const previous = engine.activeSplatMesh;
    const failure = deferred();
    splats.initializers.push(failure.promise);
    const replacement = { ...descriptor, id: "replacement" };
    const loading = engine.loadDescriptor(replacement);
    await vi.waitFor(() => expect(splats.meshes).toHaveLength(2));
    expect(engine.activeSplatMesh).toBe(previous);
    failure.reject(new Error("corrupt asset"));
    await expect(loading).rejects.toThrow('Unable to load "Small Garden"');
    expect(engine.activeSplatMesh).toBe(previous);
    expect(splats.meshes[0]?.dispose).not.toHaveBeenCalled();
    expect(splats.meshes[1]?.dispose).toHaveBeenCalledOnce();
    await engine.loadDescriptor(replacement);
    expect(engine.activeDescriptor).toBe(replacement);
    expect(splats.meshes[0]?.dispose).toHaveBeenCalledOnce();
    expect(engine.scene.children).not.toContain(previous);
  });

  it("never activates a superseded decoder, even when it completes after its replacement", async () => {
    const { engine } = setup();
    const late = deferred();
    splats.initializers.push(late.promise);
    const loading = engine.loadDescriptor(descriptor);
    const aborted = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(splats.meshes).toHaveLength(1));
    const replacement = { ...descriptor, id: "replacement" };
    const replacementMesh = await engine.loadDescriptor(replacement);
    await aborted;
    expect(engine.activeDescriptor).toBe(replacement);
    late.resolve();
    await splats.meshes[0]?.initialized;
    expect(engine.activeSplatMesh).toBe(replacementMesh);
    expect(splats.meshes[0]?.dispose).toHaveBeenCalledOnce();
    expect(splats.meshes[1]?.dispose).not.toHaveBeenCalled();
  });

  it("aborts direct descriptor loading on disposal and frees a late decoder's allocations", async () => {
    const { engine } = setup();
    const late = deferred();
    splats.initializers.push(late.promise);
    const loading = engine.loadDescriptor(descriptor);
    await vi.waitFor(() => expect(splats.meshes).toHaveLength(1));
    engine.dispose();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(engine.activeSplatMesh).toBeUndefined();
    late.resolve();
    await splats.meshes[0]?.initialized;
    expect(splats.meshes[0]?.dispose).toHaveBeenCalledOnce();
    expect(engine.activeDescriptor).toBeUndefined();
  });

  it("reports indeterminate downloads without guessing a fraction and retains complete bytes", async () => {
    const { engine } = setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6])));
    const progress = vi.fn();
    await engine.loadDescriptor(
      {
        ...descriptor,
        asset: {
          ...descriptor.asset,
          locator: {
            kind: "remote" as const,
            url: "https://example.com/garden.SPZ?version=2#preview",
          },
        },
      },
      undefined,
      progress,
    );
    expect(progress).toHaveBeenLastCalledWith({ loadedBytes: 3, totalBytes: 0 });
    expect(splats.meshes[0]?.options).toEqual({
      fileBytes: new Uint8Array([4, 5, 6]),
      fileName: "https://example.com/garden.SPZ",
    });
  });

  it("names a downloaded copy (a blob URL without an extension) by its declared format", async () => {
    const { engine } = setup(800, 450, () => "blob:capacitor://localhost/2f6c-41d9");
    await engine.loadDescriptor({
      ...descriptor,
      asset: { ...descriptor.asset, format: { name: "ply", version: null } },
    });
    expect(splats.meshes[0]?.options.fileName).toBe("scene.ply");
  });

  it("decodes imported blob URLs with the persisted format and orientation", async () => {
    const { engine } = setup();
    const quaternion = new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
      .toArray();
    const imported = {
      ...descriptor,
      source: "imported" as const,
      assetToScene: { ...descriptor.assetToScene, rotation: quaternion },
      localAsset: {
        version: 1 as const,
        id: "asset",
        filename: "Studio.spz",
        format: "spz" as const,
        byteLength: 3,
      },
    };
    const mesh = await engine.loadDescriptor(imported);
    expect(splats.meshes[0]?.options.fileName).toBe("scene.spz");
    expect(mesh.quaternion.toArray()).toEqual(quaternion);
    expect(engine.activeDescriptor).toBe(imported);
  });
});

describe("SceneEngine decoder capabilities", () => {
  const descriptor = migrateScene({
    id: "garden",
    name: "Small Garden",
    source: "bundled" as const,
    splatUrl: "https://example.com/scenes/small-garden.sog",
  });

  it("keeps the existing scene when SOG decoding is unsupported and offers saved-sheet recovery", async () => {
    const { engine } = setup();
    const previous = {
      ...descriptor,
      id: "previous",
      asset: {
        ...descriptor.asset,
        locator: { kind: "remote" as const, url: "https://example.com/scene.spz" },
      },
    };
    await engine.loadDescriptor(previous);
    const previousMesh = engine.activeSplatMesh;
    vi.stubGlobal("OffscreenCanvas", undefined);
    await expect(engine.loadDescriptor(descriptor)).rejects.toThrow("iOS/iPadOS 17 or later");
    await expect(engine.loadDescriptor(descriptor)).rejects.toThrow("saved shot sheets");
    expect(engine.activeDescriptor).toBe(previous);
    expect(engine.activeSplatMesh).toBe(previousMesh);
  });

  it.each(["Worker", "createImageBitmap"])(
    "checks the required %s API before loading a SOG",
    async (missing) => {
      const { engine } = setup();
      const probe = vi.fn();
      vi.stubGlobal("OffscreenCanvas", probe);
      vi.stubGlobal("Worker", vi.fn());
      vi.stubGlobal("createImageBitmap", vi.fn());
      vi.stubGlobal(missing, undefined);
      await expect(engine.loadDescriptor(descriptor)).rejects.toThrow("This browser cannot open");
      expect(probe).not.toHaveBeenCalled();
      expect(engine.activeSplatMesh).toBeUndefined();
    },
  );

  it.each([false, true])(
    "handles unavailable or throwing OffscreenCanvas WebGL and releases its buffer (throws=%s)",
    async (throws) => {
      const { engine } = setup();
      const probe = {
        width: 1,
        height: 1,
        getContext: vi.fn(() => {
          if (throws) throw new Error("WebGL is unavailable");
          return null;
        }),
      };
      vi.stubGlobal(
        "OffscreenCanvas",
        class {
          constructor() {
            return probe;
          }
        },
      );
      vi.stubGlobal("Worker", vi.fn());
      vi.stubGlobal("createImageBitmap", vi.fn());
      await expect(engine.loadDescriptor(descriptor)).rejects.toThrow("WebGL 2 in OffscreenCanvas");
      expect(probe.getContext).toHaveBeenCalledWith("webgl2");
      expect([probe.width, probe.height]).toEqual([0, 0]);
      expect(engine.activeSplatMesh).toBeUndefined();
    },
  );

  it("loads supported SOG URLs and releases the temporary graphics context", async () => {
    const { engine } = setup();
    const loseContext = vi.fn();
    const getExtension = vi.fn(() => ({ loseContext }));
    const probe = { width: 1, height: 1, getContext: vi.fn(() => ({ getExtension })) };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor() {
          return probe;
        }
      },
    );
    vi.stubGlobal("Worker", vi.fn());
    vi.stubGlobal("createImageBitmap", vi.fn());
    const scene = {
      ...descriptor,
      asset: {
        ...descriptor.asset,
        locator: {
          kind: "remote" as const,
          url: "https://example.com/scenes/garden.SOG?version=1#preview",
        },
      },
    };
    await engine.loadDescriptor(scene);
    expect(engine.activeDescriptor).toBe(scene);
    expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(loseContext).toHaveBeenCalledOnce();
    expect([probe.width, probe.height]).toEqual([0, 0]);
  });
});

describe("SceneEngine output framing", () => {
  it("keeps the projection and scene landmarks stable across display resizing", () => {
    const { engine } = setup();
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1], aspectRatio: 16 / 9 });
    engine.camera.updateMatrixWorld();
    const landmark = new Vector3(1, 0.5, 0).project(engine.camera);
    const projection = engine.camera.projectionMatrix.clone();

    engine.resize(390, 700);
    expect(engine.getCameraState().aspectRatio).toBe(16 / 9);
    expect(engine.camera.projectionMatrix.equals(projection)).toBe(true);
    expect(new Vector3(1, 0.5, 0).project(engine.camera).toArray()).toEqual(landmark.toArray());

    engine.setCameraState({ aspectRatio: 1 });
    engine.resize(1000, 400);
    expect(engine.getCameraState().aspectRatio).toBe(1);
  });

  it("rejects invalid aspects before changing the current camera", () => {
    const { engine } = setup();
    const before = engine.getCameraState();
    expect(() => engine.setCameraState({ aspectRatio: NaN, position: [10, 0, 0] })).toThrow(
      RangeError,
    );
    expect(engine.getCameraState()).toEqual(before);
  });

  it.each([
    [800, 800, 16 / 9, 480, 270],
    [800, 450, 1, 450, 450],
    [800, 450, 9 / 16, 253, 450],
  ])(
    "captures the full camera frame from a %s×%s buffer at aspect %s",
    (width, height, aspect, outWidth, outHeight) => {
      const { engine, canvas } = setup(width, height);
      engine.setCameraState({ aspectRatio: aspect });
      const shot = engine.captureShot({ maxSize: 480 });
      const target = captures[0]!;
      expect(shot.camera.aspectRatio).toBe(aspect);
      expect([target.width, target.height]).toEqual([outWidth, outHeight]);
      expect(target.drawImage).toHaveBeenCalledWith(canvas, 0, 0, outWidth, outHeight);
    },
  );
});

describe("SceneEngine atomic shot capture", () => {
  it("captures the live camera even when the throttled UI callback still describes the old pose", () => {
    const { engine } = setup();
    const emitted: CameraState[] = [];
    engine.onCameraStateChange((state) => emitted.push(state));
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    engine.enterHandheldMode();
    engine.applyDevicePose({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], timestampMs: 1 });
    engine.applyDevicePose({ position: [2, 0.5, 0], quaternion: [0, 0, 0, 1], timestampMs: 2 });
    expect(emitted).toHaveLength(1);
    const update = vi.spyOn(engine.navigation, "update");
    let renderedPosition: number[] | undefined;
    vi.mocked(engine.renderer.render).mockImplementation((_scene, camera) => {
      renderedPosition = (camera as PerspectiveCamera).position.toArray();
    });

    const shot = engine.captureShot({ maxSize: 480 });
    expect(shot.camera.position).toEqual([2, 0.5, 4]);
    expect(shot.camera.position).toEqual(renderedPosition);
    expect(shot.thumbnailDataUrl).toBe("data:image/jpeg;base64,captured");
    expect(update).not.toHaveBeenCalled();
    engine.camera.position.x = 10;
    expect(shot.camera.position[0]).toBe(2);
  });

  it("captures stills through the same bounded camera frame", () => {
    const { engine } = setup();
    expect(engine.captureStill({ maxSize: 320, mimeType: "image/png" })).toBe(
      "data:image/jpeg;base64,captured",
    );
    expect(captures[0]?.width).toBe(320);
    expect(captures[0]?.height).toBe(180);
    expect(captures[0]?.toDataURL).toHaveBeenCalledWith("image/png", 0.82);
  });

  it.each([0, -1, NaN, Infinity, 4097])("rejects unsafe capture size %s", (maxSize) => {
    const { engine } = setup();
    expect(() => engine.captureShot({ maxSize })).toThrow(RangeError);
    expect(engine.renderer.render).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of returning an incorrectly sized image when 2D capture is unavailable", () => {
    const { engine } = setup();
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(() => engine.captureShot({ maxSize: 480 })).toThrow("2D canvas");
    expect(engine.renderer.render).not.toHaveBeenCalled();
  });
});

describe("SceneEngine deterministic video frames", () => {
  it("prepares the first synchronous shot by awaiting Spark without changing camera or live rendering state", async () => {
    const { engine } = setup();
    engine.setCameraState({ position: [3, 2, 7], aspectRatio: 2.39 });
    engine.start();
    const original = engine.getCameraState();
    const ordered = deferred();
    vi.mocked(engine.sparkRenderer.update).mockReturnValueOnce(ordered.promise);
    const preparation = engine.prepareFrame();
    expect(engine.isRunning).toBe(false);
    expect(engine.renderer.render).not.toHaveBeenCalled();
    ordered.resolve();
    await preparation;
    expect(engine.renderer.render).toHaveBeenCalledOnce();
    expect(engine.getCameraState()).toEqual(original);
    expect(engine.isRunning).toBe(true);
    expect(engine.navigation.enabled).toBe(true);
    const shot = engine.captureShot({ maxSize: 480 });
    expect(shot.camera).toEqual(original);
    expect(engine.renderer.render).toHaveBeenCalledTimes(2);
  });

  it("replaces transparent pixels when consecutive video frames reuse the same output canvas", async () => {
    const { engine } = setup();
    const capture = engine.beginFrameCapture();
    const first = await capture.render(engine.getCameraState(), 640, 360);
    const second = await capture.render(
      { ...engine.getCameraState(), position: [1, 2, 3] },
      640,
      360,
    );
    expect(first).toBe(second);
    const target = captures[0]!;
    expect(target.clearRect).toHaveBeenCalledTimes(2);
    expect(target.clearRect).toHaveBeenLastCalledWith(0, 0, 640, 360);
    target.drawImage.mock.invocationCallOrder.forEach((order, index) => {
      expect(target.clearRect.mock.invocationCallOrder[index]).toBeLessThan(order);
    });
    capture.dispose();
  });

  it("renders stills at saved poses and restores the live camera", async () => {
    const { engine } = setup();
    const live = engine.getCameraState();
    const saved = { ...live, position: [1, 2, 3] as const, aspectRatio: 2.39 };
    const images = await engine.captureStillsAt([saved, { ...live, aspectRatio: 1 }], {
      maxSize: 480,
    });
    expect(images).toEqual(["data:image/jpeg;base64,captured", "data:image/jpeg;base64,captured"]);
    expect(captures[0]?.drawImage).toHaveBeenNthCalledWith(
      1,
      engine.renderer.domElement,
      0,
      0,
      480,
      201,
    );
    expect(captures[0]?.drawImage).toHaveBeenNthCalledWith(
      2,
      engine.renderer.domElement,
      0,
      0,
      480,
      480,
    );
    expect(engine.getCameraState().position).toEqual(live.position);
    // The exclusive capture is released, so another one can start.
    engine.beginFrameCapture().dispose();
    await expect(engine.captureStillsAt([])).resolves.toEqual([]);
  });

  it("honors visibility suspension while capture owns the render loop", async () => {
    const { engine } = setup();
    engine.start();
    const capture = engine.beginFrameCapture();
    await capture.render(engine.getCameraState(), 640, 360);
    engine.stop();
    capture.dispose();
    expect(engine.isRunning).toBe(false);
    engine.start();
    expect(engine.isRunning).toBe(true);
  });

  it("waits for the live renderer's outstanding sort before updating the export camera", async () => {
    const { engine } = setup();
    engine.sparkRenderer.sorting = true;
    const capture = engine.beginFrameCapture();
    const rendering = capture.render(engine.getCameraState(), 640, 360);
    expect(engine.sparkRenderer.update).not.toHaveBeenCalled();
    expect(engine.sparkRenderer.minSortIntervalMs).toBe(0);
    expect(engine.sparkRenderer.enableLod).toBe(false);
    engine.sparkRenderer.sorting = false;
    await rendering;
    expect(engine.sparkRenderer.update).toHaveBeenCalledOnce();
    expect(engine.sparkRenderer.renderSize.toArray()).toEqual([640, 360]);
    capture.dispose();
    expect(engine.sparkRenderer.minSortIntervalMs).toBe(100);
    expect(engine.sparkRenderer.enableLod).toBe(true);
    expect(engine.sparkRenderer.enableDriveLod).toBe(true);
    expect(engine.sparkRenderer.renderSize.toArray()).toEqual([800, 450]);
  });

  it("waits for splat ordering, locks camera ownership, and restores the exact viewport and rolled camera", async () => {
    const { engine } = setup();
    engine.setCameraState({
      position: [2, 3, 4],
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3).toArray(),
      aspectRatio: 2.39,
    });
    engine.renderer.setPixelRatio(2);
    engine.resize(800, 450);
    const before = engine.getCameraState();
    const ordered = deferred();
    vi.mocked(engine.sparkRenderer.update).mockReturnValueOnce(ordered.promise);
    engine.start();
    const capture = engine.beginFrameCapture();
    expect(engine.isRunning).toBe(false);
    expect(engine.navigation.enabled).toBe(false);
    expect(engine.sparkRenderer.autoUpdate).toBe(false);
    const camera = {
      ...before,
      position: [7, 8, 9] as const,
      verticalFovDegrees: 36,
      aspectRatio: 16 / 9,
    };
    const rendering = capture.render(camera, 640, 360);
    expect(engine.getCameraState()).toEqual(camera);
    expect(engine.sparkRenderer.update).toHaveBeenCalledWith({
      scene: engine.scene,
      camera: engine.camera,
    });
    expect(engine.renderer.render).not.toHaveBeenCalled();
    engine.resize(390, 219);
    expect([engine.renderer.domElement.width, engine.renderer.domElement.height]).toEqual([
      640, 360,
    ]);
    ordered.resolve();
    const frame = await rendering;
    expect([frame.width, frame.height]).toEqual([640, 360]);
    expect(captures[0]?.drawImage).toHaveBeenCalledWith(engine.renderer.domElement, 0, 0, 640, 360);
    expect(engine.renderer.render).toHaveBeenCalledOnce();
    capture.dispose();
    capture.dispose();
    expect(engine.getCameraState()).toEqual(before);
    expect(engine.navigation.enabled).toBe(true);
    expect(engine.renderer.getPixelRatio()).toBe(2);
    expect([engine.renderer.domElement.width, engine.renderer.domElement.height]).toEqual([
      780, 438,
    ]);
    expect(engine.sparkRenderer.autoUpdate).toBe(true);
    expect(engine.isRunning).toBe(true);
    expect([frame.width, frame.height]).toEqual([0, 0]);
  });

  it("cancels while GPU preparation is pending and never renders a late frame after restoration", async () => {
    const { engine } = setup();
    const before = engine.getCameraState();
    const ordered = deferred();
    vi.mocked(engine.sparkRenderer.update).mockReturnValueOnce(ordered.promise);
    const capture = engine.beginFrameCapture();
    const cancellation = new AbortController();
    const rendering = capture.render(
      { ...before, position: [1, 2, 3] },
      640,
      360,
      cancellation.signal,
    );
    cancellation.abort();
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    capture.dispose();
    ordered.resolve();
    await ordered.promise;
    expect(engine.renderer.render).not.toHaveBeenCalled();
    expect(engine.getCameraState()).toEqual(before);
    expect(engine.isRunning).toBe(false);
  });

  it("retains playback ownership after capture and rejects parallel frames", async () => {
    const { engine } = setup();
    engine.setPlaybackActive(true);
    const ordered = deferred();
    vi.mocked(engine.sparkRenderer.update).mockReturnValueOnce(ordered.promise);
    const capture = engine.beginFrameCapture();
    const rendering = capture.render(engine.getCameraState(), 640, 360);
    expect(() => engine.beginFrameCapture()).toThrow("already in progress");
    await expect(capture.render(engine.getCameraState(), 640, 360)).rejects.toThrow(
      "previous video frame",
    );
    ordered.resolve();
    await rendering;
    capture.dispose();
    expect(engine.navigation.enabled).toBe(false);
    engine.setPlaybackActive(false);
    expect(engine.navigation.enabled).toBe(true);
  });

  it("releases an unfinished capture on engine disposal without restarting rendering", async () => {
    const { engine } = setup();
    const ordered = deferred();
    vi.mocked(engine.sparkRenderer.update).mockReturnValueOnce(ordered.promise);
    engine.start();
    const capture = engine.beginFrameCapture();
    const rendering = capture.render(engine.getCameraState(), 640, 360);
    engine.dispose();
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    ordered.resolve();
    await ordered.promise;
    capture.dispose();
    expect(engine.renderer.render).not.toHaveBeenCalled();
    expect(engine.isRunning).toBe(false);
    expect([captures[0]?.width, captures[0]?.height]).toEqual([0, 0]);
  });
});

describe("SceneEngine interrupted rendering", () => {
  it("respects stop invoked by a camera listener and restarts without counting background time", () => {
    const { engine, tick } = setup();
    const stopped = engine.onCameraStateChange(() => engine.stop());
    const samples = vi.fn();
    engine.onPerformanceSample(samples);
    engine.start();
    tick(1000);
    expect(engine.isRunning).toBe(false);
    stopped();
    engine.start();
    tick(90_000);
    expect(engine.isRunning).toBe(true);
    expect(samples).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameDurationMs: 0, rollingAverageFps: 0 }),
    );
  });
});

describe("SceneEngine programmatic poses", () => {
  it("keeps a restored rolled pose fixed while no navigation is held", () => {
    const { engine, tick } = setup();
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const desired: CameraState = {
      ...engine.getCameraState(),
      position: [2, 1, 6],
      quaternion: roll.toArray(),
    };
    engine.setCameraState(desired);
    const restored = engine.getCameraState();
    expect(restored.position).toEqual(desired.position);
    expect(Math.abs(new Quaternion(...restored.quaternion).dot(roll))).toBeCloseTo(1, 12);
    engine.start();
    tick(0);
    tick(16);
    tick(32);
    expect(engine.getCameraState()).toEqual(restored);
  });

  it("can suppress programmatic change callbacks without suppressing camera application", () => {
    const { engine } = setup();
    const listener = vi.fn();
    engine.onCameraStateChange(listener);
    engine.setCameraState({ position: [1, 2, 3] }, { emitChange: false });
    expect(listener).not.toHaveBeenCalled();
    expect(engine.getCameraState().position).toEqual([1, 2, 3]);
    engine.setCameraState({ aspectRatio: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("SceneEngine camera ownership", () => {
  const pose = (x: number) => ({
    position: [x, 0, 0] as const,
    quaternion: [0, 0, 0, 1] as const,
    timestampMs: 1,
  });

  it("requires explicit handheld ownership even when navigation is disabled", () => {
    const { engine } = setup();
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    const initial = engine.getCameraState();
    engine.navigation.enabled = false;
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(10));
    expect(engine.getCameraState()).toEqual(initial);
    expect(engine.isHandheldActive).toBe(false);

    engine.enterHandheldMode();
    expect(engine.isHandheldActive).toBe(true);
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(2));
    expect(engine.getCameraState().position).toEqual([2, 0, 4]);
    engine.exitHandheldMode();
    expect(engine.isHandheldActive).toBe(false);
    expect(engine.navigation.enabled).toBe(true);
    engine.applyDevicePose(pose(10));
    expect(engine.getCameraState().position).toEqual([2, 0, 4]);
  });

  it("blocks an ongoing touch drag, held sticks and device samples during playback", () => {
    const { engine, canvas, tick } = setup();
    const touch = (type: string, x: number) => {
      canvas.dispatchEvent(
        Object.assign(new Event(type), { pointerId: 1, clientX: x, clientY: 0 }),
      );
    };
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    engine.start();
    touch("pointerdown", 0);
    touch("pointermove", 20);
    const before = engine.getCameraState();
    expect(before.quaternion).not.toEqual([0, 0, 0, 1]);
    engine.navigation.setInput({ moveZ: 1 });

    engine.setPlaybackActive(true);
    expect(engine.navigation.enabled).toBe(false);
    expect(engine.isHandheldActive).toBe(false);
    touch("pointermove", 200);
    engine.navigation.setInput({ moveZ: 1 });
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(10));
    tick(0);
    tick(16);
    expect(engine.getCameraState()).toEqual(before);
    touch("pointerup", 200);

    engine.setPlaybackActive(false);
    expect(engine.navigation.enabled).toBe(true);
    // The stick held before playback was released rather than resumed.
    tick(32);
    tick(48);
    expect(engine.getCameraState()).toEqual(before);
    touch("pointerdown", 200);
    touch("pointermove", 220);
    expect(engine.getCameraState().quaternion).not.toEqual(before.quaternion);
    touch("pointerup", 220);
  });

  it("preserves the exact rolled camera when playback releases ownership", () => {
    const { engine, tick } = setup();
    engine.setPlaybackActive(true);
    engine.setCameraState({
      position: [2, 1, 6],
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3).toArray(),
      verticalFovDegrees: 39,
      aspectRatio: 2.39,
    });
    const final = engine.getCameraState();
    engine.setPlaybackActive(false);
    engine.setPlaybackActive(false);
    expect(engine.getCameraState()).toEqual(final);
    expect(engine.navigation.enabled).toBe(true);
    engine.start();
    tick(0);
    tick(16);
    expect(engine.getCameraState()).toEqual(final);
  });

  it("keeps playback ownership when handheld tracking exits", () => {
    const { engine, tick } = setup();
    engine.enterHandheldMode();
    engine.setPlaybackActive(true);
    engine.setCameraState({ position: [1, 2, 3], quaternion: [0, 0, 0, 1] });
    const current = engine.getCameraState();
    engine.exitHandheldMode();
    expect(engine.isHandheldActive).toBe(false);
    expect(engine.navigation.enabled).toBe(false);
    expect(engine.getCameraState()).toEqual(current);
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(20));
    engine.start();
    tick(0);
    expect(engine.getCameraState()).toEqual(current);
    engine.setPlaybackActive(false);
    expect(engine.navigation.enabled).toBe(true);
  });

  it.each([false, true])(
    "reanchors resumed handheld input at the final playback camera (frame applied=%s)",
    (applyFrame) => {
      const { engine } = setup();
      engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
      engine.enterHandheldMode();
      engine.applyDevicePose(pose(0));
      engine.applyDevicePose(pose(2));
      engine.setPlaybackActive(true);
      if (applyFrame) engine.setCameraState({ position: [10, 5, 3] });
      const final = engine.getCameraState();
      engine.applyDevicePose(pose(30));
      engine.applyDevicePose(pose(50));
      expect(engine.getCameraState()).toEqual(final);
      engine.setPlaybackActive(false);
      expect(engine.navigation.enabled).toBe(false);
      expect(engine.isHandheldActive).toBe(true);
      expect(engine.getCameraState()).toEqual(final);
      engine.applyDevicePose(pose(100));
      expect(engine.getCameraState()).toEqual(final);
      engine.applyDevicePose(pose(101));
      expect(engine.getCameraState().position).toEqual([
        final.position[0] + 1,
        final.position[1],
        final.position[2],
      ]);
    },
  );

  it("reanchors a shot recalled in handheld mode on the next physical sample", () => {
    const { engine } = setup();
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    engine.enterHandheldMode();
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(2));
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    engine.setCameraState({ position: [7, 8, 9], quaternion: rotation.toArray() });
    const recalled = engine.getCameraState();
    engine.recenterHandheld();
    engine.applyDevicePose(pose(100));
    expect(engine.getCameraState()).toEqual(recalled);
    expect(engine.isHandheldActive).toBe(true);
    engine.applyDevicePose(pose(101));
    engine.getCameraState().position.forEach((value, index) => {
      expect(value).toBeCloseTo([7, 8, 8][index]!, 10);
    });
    expect(new Quaternion(...engine.getCameraState().quaternion).angleTo(rotation)).toBeCloseTo(0);
  });

  it("preserves scaled handheld movement and recentering before returning to touch", () => {
    const { engine } = setup();
    engine.setCameraState({ position: [0, 0, 4], quaternion: [0, 0, 0, 1] });
    engine.enterHandheldMode(2);
    engine.applyDevicePose(pose(0));
    engine.applyDevicePose(pose(2));
    expect(engine.getCameraState().position).toEqual([4, 0, 4]);
    engine.recenterHandheld();
    engine.applyDevicePose(pose(2));
    expect(engine.getCameraState().position).toEqual([4, 0, 4]);
    engine.applyDevicePose(pose(3));
    expect(engine.getCameraState().position).toEqual([6, 0, 4]);
    engine.exitHandheldMode();
    expect(engine.navigation.enabled).toBe(true);
  });

  it("allows cleanup to release playback after the scene engine is disposed", () => {
    const { engine } = setup();
    engine.setPlaybackActive(true);
    engine.dispose();
    expect(() => engine.setPlaybackActive(false)).not.toThrow();
  });
});

describe("SceneEngine plan overlay", () => {
  const style = { markerColor: "#8d8b87", selectedColor: "#d9ff72", pathColor: "#d9ff72" };
  const marker = {
    id: "wide",
    position: [0, 0, -5] as [number, number, number],
    quaternion: [0, 0, 0, 1] as [number, number, number, number],
    verticalFovDegrees: 40,
    aspectRatio: 16 / 9,
  };
  const overlayVisibleDuringRender = (engine: SceneEngine) => {
    const seen: boolean[] = [];
    vi.mocked(engine.renderer.render).mockImplementation((scene) => {
      seen.push(scene.getObjectByName("oculo-plan-overlay")?.visible ?? false);
    });
    return seen;
  };

  it("draws markers and the move, and picks the marker nearest a tap", () => {
    const { engine, canvas } = setup();
    Object.assign(canvas, {
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 450 }),
    });
    engine.setCameraState({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    engine.setPlanOverlay({
      markers: [marker],
      selectedId: "wide",
      path: [
        [0, 0, -5],
        [1, 0, -6],
      ],
      style,
    });
    const group = engine.scene.getObjectByName("oculo-plan-overlay")!;
    expect(group.children.map((child) => child.name)).toEqual(["shot:wide", "move-path"]);
    expect(engine.pickShotMarker(410, 245)).toBeUndefined(); // hidden overlays are not tappable
    engine.setPlanOverlayVisible(true);
    expect(engine.pickShotMarker(410, 245)).toBe("wide");
    expect(engine.pickShotMarker(10, 20)).toBeUndefined();
    engine.setPlanOverlay(undefined);
    expect(group.children).toEqual([]);
  });

  it("never includes the overlay in a captured shot or video frame", async () => {
    const { engine } = setup();
    engine.setPlanOverlay({ markers: [marker], path: [], style });
    engine.setPlanOverlayVisible(true);
    const seen = overlayVisibleDuringRender(engine);
    engine.captureShot({ maxSize: 320 });
    expect(seen).toEqual([false]);
    expect(engine.isPlanOverlayVisible).toBe(true);
    const capture = engine.beginFrameCapture();
    engine.setPlanOverlayVisible(true); // ignored while capture owns the renderer
    await capture.render(engine.getCameraState(), 320, 180);
    expect(seen).toEqual([false, false]);
    capture.dispose();
    expect(engine.isPlanOverlayVisible).toBe(true);
  });
});

describe("SceneEngine navigation", () => {
  const forward = (state: CameraState) =>
    new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...state.quaternion));

  it("walks level, strafes and cranes at the scene's pace for the frame's length", () => {
    const { engine, tick } = setup();
    engine.setCameraState({ position: [0, 1, 0], quaternion: [0, 0, 0, 1] });
    engine.navigation.baseSpeed = 2;
    engine.start();
    tick(0);
    engine.navigation.setInput({ moveZ: 1 });
    for (let time = 100; time <= 500; time += 100) tick(time);
    let position = engine.getCameraState().position;
    expect(position[2]).toBeCloseTo(-1, 6);
    expect(position[1]).toBeCloseTo(1, 6);
    engine.navigation.setInput({ moveZ: 0, moveX: 1, vertical: 1 });
    tick(1000);
    position = engine.getCameraState().position;
    // A stalled frame integrates at most 100 ms.
    expect(position[0]).toBeCloseTo(0.2, 6);
    expect(position[1]).toBeCloseTo(1.2, 6);
    engine.navigation.setInput({ moveX: 0.5, vertical: 0 });
    tick(1100);
    // Half deflection moves at a quarter speed for fine adjustment.
    expect(engine.getCameraState().position[0]).toBeCloseTo(0.25, 6);
  });

  it("pans and tilts without losing the dutch angle and never flips over", () => {
    const { engine, tick } = setup();
    const dutch = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    engine.setCameraState({ position: [0, 0, 0], quaternion: dutch.toArray() });
    engine.start();
    tick(0);
    engine.navigation.setInput({ yawRate: 1, pitchRate: 1 });
    for (let time = 100; time <= 3000; time += 100) tick(time);
    const state = engine.getCameraState();
    const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...state.quaternion));
    const view = forward(state);
    const level = new Vector3(0, 1, 0).addScaledVector(view, -view.y).normalize();
    expect(Math.acos(Math.min(1, level.dot(up)))).toBeCloseTo(0.3, 5);
    expect(Math.asin(view.y)).toBeLessThanOrEqual((85 * Math.PI) / 180 + 1e-6);
  });

  it("looks with a one-finger drag and dollies with a pinch", () => {
    const { engine, canvas } = setup();
    engine.setCameraState({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    const pointer = (type: string, id: number, x: number) =>
      canvas.dispatchEvent(
        Object.assign(new Event(type), { pointerId: id, clientX: x, clientY: 0 }),
      );
    pointer("pointerdown", 1, 100);
    pointer("pointermove", 1, 150);
    // The scene follows the finger: dragging right turns the camera left.
    expect(forward(engine.getCameraState()).x).toBeLessThan(0);
    const turned = engine.getCameraState();
    pointer("pointerdown", 2, 300);
    pointer("pointermove", 2, 400);
    engine.navigation.update(16);
    const moved = engine.getCameraState();
    const travel = new Vector3(...moved.position).sub(new Vector3(...turned.position));
    expect(travel.dot(forward(turned))).toBeGreaterThan(0);
  });

  it("moves with the keyboard while the scene has focus", () => {
    const { engine, canvas, tick } = setup();
    engine.setCameraState({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    engine.start();
    tick(0);
    canvas.dispatchEvent(
      Object.assign(new Event("keydown"), { code: "KeyE", preventDefault: vi.fn() }),
    );
    tick(100);
    expect(engine.getCameraState().position[1]).toBeGreaterThan(0);
    canvas.dispatchEvent(Object.assign(new Event("keyup"), { code: "KeyE" }));
    const stopped = engine.getCameraState();
    tick(200);
    expect(engine.getCameraState()).toEqual(stopped);
  });

  it("ignores input while the app pauses navigation or a capture owns the camera", async () => {
    const { engine, tick } = setup();
    engine.start();
    tick(0);
    engine.setNavigationEnabled(false);
    engine.navigation.setInput({ moveZ: 1 });
    tick(100);
    expect(engine.getCameraState().position).toEqual([0, 0, 0]);
    engine.setNavigationEnabled(true);
    engine.navigation.setInput({ moveZ: 1 });
    const capture = engine.beginFrameCapture();
    expect(engine.navigation.enabled).toBe(false);
    capture.dispose();
    expect(engine.navigation.enabled).toBe(true);
  });

  it("measures focus distance along the view to the surface under a point", async () => {
    const { engine, canvas } = setup();
    await engine.loadDescriptor(
      migrateScene({
        id: "garden",
        name: "Small Garden",
        source: "bundled" as const,
        splatUrl: "https://example.com/scenes/garden.spz",
      }),
    );
    engine.setCameraState({ position: [0, 0, 5], quaternion: [0, 0, 0, 1] });
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450 }) as DOMRect;
    const mesh = engine.activeSplatMesh!;
    mesh.raycast = (raycaster, hits) => {
      hits.push({
        distance: 2,
        point: raycaster.ray.at(2.5, new Vector3()),
        object: mesh,
      });
    };
    expect(engine.pickFocusDistance(400, 225)).toBeCloseTo(2.5, 6);
    mesh.raycast = () => undefined;
    expect(engine.pickFocusDistance(400, 225)).toBeUndefined();
  });
});

describe("SceneEngine map view", () => {
  async function mapSetup() {
    const context = setup();
    const { engine, canvas } = context;
    await engine.loadDescriptor(
      migrateScene({
        id: "garden",
        name: "Small Garden",
        source: "bundled" as const,
        splatUrl: "https://example.com/scenes/garden.spz",
      }),
    );
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 450 }) as DOMRect;
    // The scene is a floor at y = 0.
    const mesh = engine.activeSplatMesh!;
    mesh.raycast = (raycaster, hits) => {
      const { origin, direction } = raycaster.ray;
      if (direction.y >= 0) return;
      const distance = -origin.y / direction.y;
      hits.push({ distance, point: raycaster.ray.at(distance, new Vector3()), object: mesh });
    };
    engine.setCameraState({ position: [0, 1.6, 4], quaternion: [0, 0, 0, 1] });
    return context;
  }

  it("renders through its own camera and never moves or reports the rig", async () => {
    const { engine, tick } = await mapSetup();
    const rig = engine.getCameraState();
    const changes: CameraState[] = [];
    engine.onCameraStateChange((state) => changes.push(state));
    const phases: string[] = [];
    engine.onMapViewChange((event) => phases.push(event.phase));
    engine.start();
    tick(0);
    const entering = engine.enterMapView({ eyeHeight: 1.6 });
    await vi.waitFor(() => expect(engine.isMapViewActive).toBe(true));
    for (let time = 16; time <= 1400; time += 16) tick(time);
    await entering;
    expect(phases.slice(0, 2)).toEqual(["entering", "map"]);
    expect(engine.navigation.enabled).toBe(false);
    const render = vi.mocked(engine.renderer.render);
    expect(render.mock.calls.at(-1)?.[1]).toBe(engine.map!.camera);
    expect(engine.map!.camera.fov).toBeCloseTo(22, 6);
    expect(engine.getCameraState()).toEqual(rig);
    expect(changes).toEqual([]);
    expect(() => engine.captureShot()).toThrow("Close the map");
  });

  it("teleports to the dropped cinematographer at eye level, facing where it was aimed", async () => {
    const { engine } = await mapSetup();
    const changes: CameraState[] = [];
    engine.onCameraStateChange((state) => changes.push(state));
    await engine.enterMapView({ eyeHeight: 1.6, reduceMotion: true });
    const map = engine.map!;
    expect(map.phase).toBe("map");
    expect(map.placeAt(400, 225)).toBe(true);
    expect(map.phase).toBe("placed");
    const ground = map.mannequin.position;
    expect(ground.y).toBeCloseTo(0, 6);
    map.setHeading(1.2);
    const state = await engine.teleportToMannequin();
    expect(state.position[0]).toBeCloseTo(ground.x, 6);
    expect(state.position[1]).toBeCloseTo(1.6, 6);
    expect(state.position[2]).toBeCloseTo(ground.z, 6);
    const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...state.quaternion));
    expect(forward.y).toBeCloseTo(0, 6);
    expect(Math.atan2(-forward.x, -forward.z)).toBeCloseTo(1.2, 6);
    expect(changes).toHaveLength(1);
    expect(engine.isMapViewActive).toBe(false);
    expect(engine.navigation.enabled).toBe(true);
  });

  it("closes without moving the camera, and refuses to open during playback", async () => {
    const { engine } = await mapSetup();
    const rig = engine.getCameraState();
    await engine.enterMapView({ eyeHeight: 1.6, reduceMotion: true });
    // Nothing under the pointer (sky): the figure is not placed.
    engine.activeSplatMesh!.raycast = () => undefined;
    expect(engine.map!.placeAt(400, 225)).toBe(false);
    expect(engine.map!.phase).toBe("map");
    await engine.exitMapView();
    expect(engine.isMapViewActive).toBe(false);
    expect(engine.getCameraState()).toEqual(rig);
    engine.setPlaybackActive(true);
    await expect(engine.enterMapView({ eyeHeight: 1.6 })).rejects.toThrow("Stop playback");
  });

  it("frames a spinning preview at once and re-frames it after another load", async () => {
    const { engine } = await mapSetup();
    await engine.showPreview({ spin: 1 });
    const map = engine.map!;
    expect(map.hasFigure).toBe(false);
    expect(map.phase).toBe("map");
    const start = map.currentAzimuth;
    map.update(500);
    expect(map.currentAzimuth - start).toBeCloseTo(0.5, 5);
    await engine.showPreview();
    expect(engine.isMapViewActive).toBe(true);
    expect(engine.map!.phase).toBe("map");
  });

  it("cuts away a room's ceiling while the map is open, and ignores it when placing", async () => {
    const { engine } = await mapSetup();
    // A 10 × 3 × 10 room: floor, ceiling and four walls.
    const points: [number, number, number][] = [];
    let seed = 3;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    for (let i = 0; i < 4000; i++) points.push([r() * 5, 0, r() * 5], [r() * 5, 3, r() * 5]);
    for (let i = 0; i < 800; i++)
      points.push([5, (r() + 1) * 1.5, r() * 5], [-5, (r() + 1) * 1.5, r() * 5]);
    const mesh = engine.activeSplatMesh! as typeof engine.activeSplatMesh & {
      splats: { numSplats: number };
    };
    Object.assign(mesh, {
      // A SOG scene decodes into the mesh's own splat source, not packedSplats.
      splats: { numSplats: points.length },
      forEachSplat: (visit: (index: number, center: Vector3) => void) =>
        points.forEach((point, index) => visit(index, new Vector3(...point))),
    });
    // Rays from above meet the ceiling first, then the floor.
    mesh.raycast = (raycaster, hits) => {
      const { origin, direction } = raycaster.ray;
      if (direction.y >= 0) return;
      for (const height of [3, 0]) {
        const distance = (height - origin.y) / direction.y;
        if (distance > 0)
          hits.push({ distance, point: raycaster.ray.at(distance, new Vector3()), object: mesh });
      }
    };
    expect(engine.canCutAway).toBe(true);
    await engine.enterMapView({ eyeHeight: 1.6, reduceMotion: true });
    const edit = engine.scene.children.find((child) => child.name === "Oculo cutaway");
    expect(edit).toBeDefined();
    const box = edit!.children[0]!;
    expect(box.position.y + box.scale.y).toBeLessThan(3);
    expect(box.position.y + box.scale.y).toBeGreaterThan(2);
    expect(engine.map!.placeAt(400, 225)).toBe(true);
    expect(engine.map!.mannequin.position.y).toBeCloseTo(0, 6);

    engine.setMapCutaway("off", { reduceMotion: true });
    expect(engine.scene.children).not.toContain(edit);
    engine.setMapCutaway("auto", { reduceMotion: true });
    expect(engine.scene.children.some((child) => child.name === "Oculo cutaway")).toBe(true);
    await engine.exitMapView();
    expect(engine.scene.children.some((child) => child.name === "Oculo cutaway")).toBe(false);
    engine.setMapCutaway("auto");
  });

  it("opens a figure-free overview whose shot markers are projected through the map camera", async () => {
    const { engine } = await mapSetup();
    engine.setPlanOverlay({
      markers: [
        {
          id: "shot-a",
          position: [2, 1.5, 0],
          quaternion: [0, 0, 0, 1],
          verticalFovDegrees: 40,
          aspectRatio: 16 / 9,
        },
      ],
      path: [],
      style: { markerColor: "#ffffff", selectedColor: "#0a84ff", pathColor: "#ff9f0a" },
    });
    engine.setPlanOverlayVisible(true);
    // From the rig at z = 4 looking down −Z, the marker is to the right of centre.
    const fromRig = engine.projectShotMarkers()[0]!;
    await engine.enterMapView({ figure: false, reduceMotion: true });
    const map = engine.map!;
    expect(map.hasFigure).toBe(false);
    expect(engine.scene.children).not.toContain(map.mannequin.group);
    // Nothing to carry or place in the overview.
    expect(map.placeAt(400, 225)).toBe(false);
    map.startCarry();
    expect(map.phase).toBe("map");
    const fromMap = engine.projectShotMarkers()[0]!;
    expect(fromMap.id).toBe("shot-a");
    expect(fromMap.x).not.toBeCloseTo(fromRig.x, 0);
    expect(engine.pickShotMarker(fromMap.x, fromMap.y)).toBe("shot-a");
    await engine.exitMapView();
    expect(engine.isMapViewActive).toBe(false);
  });
});
