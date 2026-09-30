import { verifyAssetBytes } from "@oculo/scene-schema";
import { resolveRemoteAsset } from "./assets.js";
import {
  SparkRenderer,
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatMesh,
} from "@sparkjsdev/spark";
import type { Box3 } from "three";
import {
  MathUtils,
  PerspectiveCamera,
  Ray,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type WebGLRendererParameters,
} from "three";

import { estimateCutaway, insideCutaway, type Cutaway } from "./cutaway.js";
import { fitOutputFrame } from "./framing.js";
import { loadMannequinFigure } from "./mannequin.js";
import {
  encloseBounds,
  MAP_ENTER_MS,
  MapView,
  type MapViewEvent,
  type ViewPose,
} from "./mapView.js";
import { FlyController } from "./navigation.js";
import { PlanOverlay, type PlanOverlayState } from "./overlay.js";
import { composeHandheldPose, type DevicePose, type HandheldBaseline } from "./pose.js";
import type { SceneSource } from "./sources.js";
import {
  performanceSampleFromRenderer,
  type CameraState,
  type CameraStateListener,
  type PerformanceSampleListener,
  type QuaternionTuple,
  type SceneDescriptor,
  type SplatUrlResolver,
  type Vector3Tuple,
} from "./types.js";

export interface AnimationScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface LoadProgress {
  /** Bytes downloaded so far, when the transport reports them. */
  readonly loadedBytes: number;
  /** Total bytes, when known (0 while indeterminate). */
  readonly totalBytes: number;
  /** 0..1 when total is known, otherwise undefined. */
  readonly fraction?: number;
}

export type LoadProgressListener = (progress: LoadProgress) => void;

export interface LoadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: LoadProgressListener;
}

export interface CaptureStillOptions {
  /** Longest output edge in pixels, from 1 to 4096; keeps the camera aspect. */
  readonly maxSize?: number;
  readonly mimeType?: "image/jpeg" | "image/png" | "image/webp";
  /** 0..1 encoder quality for lossy formats. */
  readonly quality?: number;
}

export interface CapturedShot {
  readonly camera: CameraState;
  readonly thumbnailDataUrl: string;
}

export interface FrameCaptureSession {
  /** Renders after Spark has finished preparing this camera's splat order. */
  render(
    camera: CameraState,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<HTMLCanvasElement>;
  /** Restores the live viewport and camera; safe to call more than once. */
  dispose(): void;
}

export interface SetCameraStateOptions {
  readonly emitChange?: boolean;
}

export interface SceneEngineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly verticalFovDegrees?: number;
  readonly aspectRatio?: number;
  readonly near?: number;
  readonly far?: number;
  readonly pixelRatio?: number;
  readonly cameraEventIntervalMs?: number;
  readonly performanceSampleIntervalMs?: number;
  readonly autoResize?: boolean;
  readonly autoStart?: boolean;
  readonly renderer?: Omit<WebGLRendererParameters, "canvas">;
  readonly resolveSplatUrl?: SplatUrlResolver;
  readonly scheduler?: AnimationScheduler;
  /** glTF model for the map-view cinematographer; a procedural figure is used without it. */
  readonly mannequinUrl?: string;
}

export interface EnterMapViewOptions {
  /**
   * How long the sky or ceiling takes to lift away. Defaults to the map's flight, or
   * none with `reduceMotion`.
   */
  readonly cutawayRevealMs?: number;
  /**
   * Scene units from the ground to the camera, used to stand the figure and land the dive.
   * When the scene's scale is unknown, omit it: the camera's current height above the
   * surface below it is used, or a share of the scene's size.
   */
  readonly eyeHeight?: number;
  readonly reduceMotion?: boolean;
  /**
   * Output-frame height / canvas height while the map fills the viewport (≤ 1). The map
   * starts and ends with a field of view matched to that frame, so the hand-off between
   * the letterboxed rig view and the full-bleed map is seamless.
   */
  readonly frameHeightFraction?: number;
  /**
   * Show the draggable cinematographer (default). Without it the map is a rotatable
   * overview of the scene and its shot markers, drawn larger so they read from above.
   */
  readonly figure?: boolean;
}

/** A shot marker's position in the viewport (client coordinates). */
export interface ShotMarkerScreenPosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Normalized depth (−1 near … 1 far), for stacking nearer markers on top. */
  readonly depth: number;
}

/**
 * Spark's SOG image decoder uses OffscreenCanvas WebGL 2 inside a worker.
 * This main-thread probe detects missing APIs; worker policy and GPU failures
 * still need to surface through the actual decoder. It is not a compatibility certification.
 */
function assertSceneDecodingSupport(url: string): void {
  if (!/\.sog(?:[?#]|$)/i.test(url)) return;
  const unsupported =
    "This browser cannot open this scene. Use iOS/iPadOS 17 or later, or a browser with " +
    "WebGL 2 in OffscreenCanvas enabled. You can still open your saved shot sheets from the library.";
  let canvas: OffscreenCanvas | undefined;
  let context: WebGL2RenderingContext | null = null;
  try {
    if (
      typeof OffscreenCanvas !== "function" ||
      typeof createImageBitmap !== "function" ||
      typeof Worker !== "function"
    ) {
      throw new Error(unsupported);
    }
    canvas = new OffscreenCanvas(1, 1);
    context = canvas.getContext("webgl2");
    if (!context) throw new Error(unsupported);
  } catch {
    throw new Error(unsupported);
  } finally {
    // Release the temporary context before Spark allocates its decoding context.
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function defaultSplatUrlResolver(descriptor: SceneDescriptor): string | URL {
  if (descriptor.source === "bundled" && descriptor.asset.locator.kind === "local")
    return `/${descriptor.asset.locator.relativePath}`;
  return resolveRemoteAsset(descriptor);
}

function browserScheduler(): AnimationScheduler {
  return {
    request: (callback) => globalThis.requestAnimationFrame(callback),
    cancel: (handle) => globalThis.cancelAnimationFrame(handle),
  };
}

function disposeObject(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof value.dispose === "function"
  ) {
    value.dispose();
  }
}

/** A decoder or source may ignore cancellation; its result must never be installed afterward. */
function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    }
  });
}

async function fetchSplatBytes(
  url: string,
  signal: AbortSignal,
  onProgress?: LoadProgressListener,
): Promise<Uint8Array> {
  const response = await abortable(fetch(url, { signal }), signal);
  if (!response.ok) throw new Error(`Scene download failed (${response.status})`);
  const reportedTotal = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(reportedTotal) && reportedTotal > 0 ? reportedTotal : 0;
  const progress = (loadedBytes: number) => {
    signal.throwIfAborted();
    onProgress?.({
      loadedBytes,
      totalBytes,
      ...(totalBytes > 0 ? { fraction: Math.min(1, loadedBytes / totalBytes) } : {}),
    });
  };
  if (!response.body) {
    const bytes = new Uint8Array(await abortable(response.arrayBuffer(), signal));
    progress(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    progress(0);
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      length += value.length;
      progress(length);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

/** A gentle gallery turntable: one turn in about 25 seconds. */
const PREVIEW_SPIN_RADIANS_PER_SECOND = 0.25;
/** Shot frustum depth in the overview, as a share of the scene radius. */
const OVERVIEW_MARKER_SHARE = 0.06;
/** How long the roof takes to lift off in the gallery preview. */
const PREVIEW_CUTAWAY_MS = 900;
/** The cutaway's soft edge, as a share of the box height. */
const CUTAWAY_SOFT_EDGE = 0.03;

/** Whether the map hides a scene's sky or ceiling ("auto") or shows everything. */
export type CutawayMode = "auto" | "off";

/** World-space bounding sphere of a splat mesh, for fitting the map view. */
function sceneBounds(mesh: SplatMesh): { center: Vector3Tuple; radius: number } {
  try {
    mesh.updateMatrixWorld(true);
    const box: Box3 = mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld);
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    if (Number.isFinite(radius) && radius > 0)
      return { center: [center.x, center.y, center.z], radius };
  } catch {
    // Fall through to a unit scene.
  }
  return { center: [0, 0, 0], radius: 5 };
}

/** At most this many splat centres are sampled to find a scene's core. */
const CORE_SAMPLE_LIMIT = 40_000;
/** The share of splats trimmed from each end of each axis as outliers (sky, floaters). */
const CORE_TRIM = 0.08;

/** Splats in a mesh, whichever store holds them (SOG files decode into extended splats). */
function splatCount(mesh: SplatMesh): number {
  const source = mesh.splats as { numSplats?: number } | undefined;
  return source?.numSplats ?? mesh.packedSplats?.numSplats ?? mesh.extSplats?.numSplats ?? 0;
}

/** Up to `limit` splat centres in world space, as xyz triples; null if unavailable. */
function sampleSplatCenters(mesh: SplatMesh, limit = CORE_SAMPLE_LIMIT): Float32Array | null {
  try {
    const count = splatCount(mesh);
    if (typeof mesh.forEachSplat !== "function" || count < 100) return null;
    mesh.updateMatrixWorld(true);
    const stride = Math.max(1, Math.ceil(count / limit));
    const out = new Float32Array(Math.ceil(count / stride) * 3);
    const world = new Vector3();
    let written = 0;
    mesh.forEachSplat((index, center) => {
      if (index % stride !== 0 || written + 3 > out.length) return;
      world.copy(center).applyMatrix4(mesh.matrixWorld);
      out[written++] = world.x;
      out[written++] = world.y;
      out[written++] = world.z;
    });
    return written >= 300 ? out.subarray(0, written) : null;
  } catch {
    return null;
  }
}

/**
 * The part of the scene where most splats are: per-axis percentiles of sampled centres.
 * Captured scenes often carry a distant sky shell or floaters that stretch the box, so
 * framing the whole box shows the shell instead of the subject.
 */
function sceneCoreBounds(
  mesh: SplatMesh,
  samples = sampleSplatCenters(mesh),
): { center: Vector3Tuple; radius: number } {
  if (!samples) return sceneBounds(mesh);
  const count = samples.length / 3;
  const range = [0, 1, 2].map((axis) => {
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) values[i] = samples[i * 3 + axis]!;
    values.sort();
    const at = (fraction: number) => values[Math.floor(fraction * (count - 1))]!;
    return [at(CORE_TRIM), at(1 - CORE_TRIM)] as const;
  }) as [readonly [number, number], readonly [number, number], readonly [number, number]];
  const [x, y, z] = range;
  const center: Vector3Tuple = [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2];
  const radius = Math.hypot(x[1] - x[0], y[1] - y[0], z[1] - z[0]) / 2;
  return Number.isFinite(radius) && radius > 0 ? { center, radius } : sceneBounds(mesh);
}

/**
 * A walking pace scaled to the scene, since imported scenes rarely know their physical
 * scale: crossing the scene takes about fifteen seconds at full stick.
 */
function walkingSpeedFor(mesh: SplatMesh): number {
  try {
    mesh.updateMatrixWorld(true);
    const box = mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld);
    const size = box.getSize(new Vector3()).length();
    return Number.isFinite(size) && size > 0 ? Math.min(20, Math.max(0.2, size / 15)) : 1.5;
  } catch {
    return 1.5;
  }
}

/**
 * A dollhouse cut on screen: one global Spark edit that fades every splat outside the
 * cutaway box. It animates from the whole scene to the box (the roof lifting off) and
 * back, and removes itself once it has settled back.
 */
class ActiveCutaway {
  readonly edit: SplatEdit;
  private readonly sdf: SplatEditSdf;
  /** 0 shows the whole scene, 1 the cut box. */
  private progress = 0;
  private target = 0;
  private durationMs = 0;

  constructor(
    readonly box: Cutaway,
    private readonly sceneRadius: number,
    private readonly onLowered: () => void,
  ) {
    this.sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, invert: true, opacity: 0 });
    this.edit = new SplatEdit({
      name: "Oculo cutaway",
      rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
      softEdge: Math.max(1e-4, box.halfExtents[1] * 2 * CUTAWAY_SOFT_EDGE),
      sdfs: [this.sdf],
    });
    this.edit.add(this.sdf);
    this.apply();
  }

  /** Cuts away the sky or ceiling over `ms`. */
  raise(ms: number): void {
    this.animateTo(1, ms);
  }

  /** Restores the whole scene over `ms`, then removes the edit. */
  lower(ms: number): void {
    this.animateTo(0, ms);
  }

  update(dtMs: number): void {
    if (this.progress === this.target) return;
    const step = this.durationMs > 0 ? dtMs / this.durationMs : 1;
    this.progress =
      this.target > this.progress
        ? Math.min(this.target, this.progress + step)
        : Math.max(this.target, this.progress - step);
    this.apply();
    if (this.progress === 0 && this.target === 0) this.onLowered();
  }

  private animateTo(target: number, ms: number): void {
    this.target = target;
    this.durationMs = Math.max(0, ms);
    if (ms <= 0) this.update(0);
  }

  private apply(): void {
    // Smoothstep: the roof eases off and settles.
    const t = this.progress * this.progress * (3 - 2 * this.progress);
    const { center, halfExtents, topY } = this.box;
    const low = center[1] - halfExtents[1];
    const high = center[1] + halfExtents[1];
    const open = Math.max(this.sceneRadius * 4, topY - low + 1);
    const bottom = MathUtils.lerp(low - open, low, t);
    const top = MathUtils.lerp(high + open, high, t);
    const reach = (half: number) => MathUtils.lerp(Math.max(half, open), half, t);
    this.sdf.position.set(center[0], (bottom + top) / 2, center[2]);
    this.sdf.scale.set(reach(halfExtents[0]), (top - bottom) / 2, reach(halfExtents[2]));
    this.sdf.updateMatrixWorld();
  }
}

export class SceneEngine {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly sparkRenderer: SparkRenderer;
  /** Walk, crane, pan and tilt input; the engine applies it every frame. */
  readonly navigation: FlyController;

  private readonly canvas: HTMLCanvasElement;
  private readonly scheduler: AnimationScheduler;
  private readonly cameraEventIntervalMs: number;
  private readonly performanceSampleIntervalMs: number;
  private readonly resolveSplatUrl: SplatUrlResolver;
  private readonly cameraListeners = new Set<CameraStateListener>();
  private readonly performanceListeners = new Set<PerformanceSampleListener>();
  private animationFrame: number | undefined;
  private animationGeneration = 0;
  private lastFrameAt: number | undefined;
  private lastCameraEventAt = -Infinity;
  private lastPerformanceSampleAt = -Infinity;
  private lastCameraSignature = "";
  private readonly recentFrameDurationsMs: number[] = [];
  private activeLoadDurationMs: number | undefined;
  private activeSceneReadyAtMs: number | undefined;
  private activeTimeToFirstFrameMs: number | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private removeWindowResizeListener: (() => void) | undefined;
  private loadAbortController: AbortController | undefined;
  private frameCapture: FrameCaptureSession | undefined;
  private resumeAfterCapture = false;
  private deferredResize: { width: number; height: number } | undefined;
  private handheldActive = false;
  private playbackActive = false;
  private handheldBaseline: HandheldBaseline | undefined;
  private handheldTranslationScale = 1;
  private lastDevicePose: DevicePose | undefined;
  private navigationRequested = true;
  private disposed = false;
  private readonly planOverlay = new PlanOverlay();
  private readonly mannequinUrl: string | undefined;
  private mapView: MapView | undefined;
  private mannequinReady: Promise<void> | undefined;
  private readonly mapListeners = new Set<(event: MapViewEvent) => void>();
  private mapFrameFraction = 1;
  private cutawayMode: CutawayMode = "auto";
  private cutawayEstimate: { mesh: SplatMesh; value: Cutaway | null } | undefined;
  private cutaway: ActiveCutaway | undefined;

  activeSplatMesh: SplatMesh | undefined;
  activeDescriptor: SceneDescriptor | undefined;

  constructor(options: SceneEngineOptions) {
    this.canvas = options.canvas;
    this.scheduler = options.scheduler ?? browserScheduler();
    this.cameraEventIntervalMs = Math.max(0, options.cameraEventIntervalMs ?? 100);
    this.performanceSampleIntervalMs = Math.max(0, options.performanceSampleIntervalMs ?? 1000);
    this.resolveSplatUrl = options.resolveSplatUrl ?? defaultSplatUrlResolver;
    this.mannequinUrl = options.mannequinUrl;
    const aspectRatio = options.aspectRatio ?? 16 / 9;
    fitOutputFrame(1, 1, aspectRatio);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(
      options.verticalFovDegrees ?? 50,
      aspectRatio,
      options.near ?? 0.01,
      options.far ?? 1000,
    );
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      ...options.renderer,
      canvas: options.canvas,
    });
    this.renderer.setPixelRatio(
      options.pixelRatio ?? Math.min(globalThis.devicePixelRatio || 1, 2),
    );

    this.sparkRenderer = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.sparkRenderer);
    this.planOverlay.visible = false;
    this.scene.add(this.planOverlay.group);
    this.navigation = new FlyController(this.camera, this.canvas);

    this.resize();
    if (options.autoResize ?? true) this.installResizeHandling();
    if (options.autoStart ?? true) this.start();
  }

  get isRunning(): boolean {
    return this.animationFrame !== undefined;
  }

  start(): void {
    this.assertUsable();
    if (this.frameCapture) {
      this.resumeAfterCapture = true;
      return;
    }
    if (this.animationFrame !== undefined) return;
    this.animationGeneration++;
    this.lastFrameAt = undefined;
    this.animationFrame = this.scheduler.request(this.renderFrame);
  }

  stop(): void {
    if (this.frameCapture) this.resumeAfterCapture = false;
    if (this.animationFrame === undefined) return;
    this.scheduler.cancel(this.animationFrame);
    this.animationGeneration++;
    this.animationFrame = undefined;
    this.lastFrameAt = undefined;
  }

  resize(width = this.canvas.clientWidth, height = this.canvas.clientHeight): void {
    this.assertUsable();
    if (this.frameCapture) {
      this.deferredResize = { width, height };
      return;
    }
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    this.renderer.setSize(safeWidth, safeHeight, false);
  }

  async load(source: SceneSource, options: LoadOptions = {}): Promise<SceneDescriptor> {
    return this.runLoad(options.signal, async (signal) => {
      const descriptor = await abortable(source.load(signal), signal);
      signal.throwIfAborted();
      await this.prepareDescriptor(descriptor, signal, options.onProgress);
      return descriptor;
    });
  }

  private async runLoad<T>(
    signal: AbortSignal | undefined,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    signal?.throwIfAborted();
    const loadStartedAt = performance.now();
    this.loadAbortController?.abort();
    const controller = new AbortController();
    this.loadAbortController = controller;
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const result = await load(controller.signal);
      controller.signal.throwIfAborted();
      this.activeLoadDurationMs = performance.now() - loadStartedAt;
      return result;
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      if (this.loadAbortController === controller) this.loadAbortController = undefined;
    }
  }

  async loadDescriptor(
    descriptor: SceneDescriptor,
    signal?: AbortSignal,
    onProgress?: LoadProgressListener,
  ): Promise<SplatMesh> {
    return this.runLoad(signal, (loadSignal) =>
      this.prepareDescriptor(descriptor, loadSignal, onProgress),
    );
  }

  private async prepareDescriptor(
    descriptor: SceneDescriptor,
    signal: AbortSignal,
    onProgress?: LoadProgressListener,
  ): Promise<SplatMesh> {
    this.assertUsable();
    signal.throwIfAborted();
    const url = String(this.resolveSplatUrl(descriptor));
    // A local copy (a blob: URL) has no extension; the declared format names the file.
    const declared = descriptor.asset.format.name;
    const fileName = descriptor.localAsset
      ? `scene.${descriptor.localAsset.format}`
      : declared !== "unknown" && !/\.[a-z0-9]+(?:[?#]|$)/i.test(url)
        ? `scene.${declared}`
        : (url.split(/[?#]/, 1)[0] ?? url);
    assertSceneDecodingSupport(fileName);
    let mesh: SplatMesh | undefined;
    try {
      // Spark's URL transport cannot accept an AbortSignal. Fetching here lets
      // scene departure cancel the actual network read as well as the UI wait.
      const fileBytes = await fetchSplatBytes(url, signal, onProgress);
      await verifyAssetBytes(descriptor.asset, fileBytes);
      signal.throwIfAborted();
      mesh = new SplatMesh({ fileBytes, fileName });
      mesh.position.fromArray(descriptor.assetToScene.translation);
      mesh.quaternion.fromArray(descriptor.assetToScene.rotation).normalize();
      mesh.scale.fromArray(descriptor.assetToScene.scale);
      await abortable(mesh.initialized, signal);
      signal.throwIfAborted();
      this.assertUsable();
      // A failed replacement must leave the last ready scene usable.
      this.clearActiveSplat();
      this.activeSplatMesh = mesh;
      this.activeDescriptor = descriptor;
      this.scene.add(mesh);
      this.navigation.baseSpeed = walkingSpeedFor(mesh);
      this.activeSceneReadyAtMs = performance.now();
      this.activeTimeToFirstFrameMs = undefined;
      this.recentFrameDurationsMs.length = 0;
      return mesh;
    } catch (error: unknown) {
      if (mesh) {
        // Decoder workers are not cancellable. Dispose after completion too,
        // because they can allocate resources after the caller has departed.
        const abandoned = mesh;
        void Promise.resolve(mesh.initialized).then(
          () => disposeObject(abandoned),
          () => disposeObject(abandoned),
        );
      }
      if (signal.aborted) throw signal.reason;
      throw new Error(
        `Unable to load "${descriptor.name}". The download failed or the asset format is unsupported.`,
        { cause: error },
      );
    }
  }

  clearActiveSplat(): void {
    this.removeCutaway();
    this.cutawayEstimate = undefined;
    if (this.activeSplatMesh) {
      this.scene.remove(this.activeSplatMesh);
      disposeObject(this.activeSplatMesh);
    }
    this.activeSplatMesh = undefined;
    this.activeDescriptor = undefined;
    this.activeLoadDurationMs = undefined;
    this.activeSceneReadyAtMs = undefined;
    this.activeTimeToFirstFrameMs = undefined;
  }

  getCameraState(): CameraState {
    const { position, quaternion } = this.camera;
    return {
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      verticalFovDegrees: this.camera.fov,
      aspectRatio: this.camera.aspect,
      near: this.camera.near,
      far: this.camera.far,
    };
  }

  setCameraState(state: Partial<CameraState>, options: SetCameraStateOptions = {}): void {
    this.assertUsable();
    const next = { ...this.getCameraState(), ...state };
    fitOutputFrame(1, 1, next.aspectRatio);
    this.camera.position.fromArray(next.position as Vector3Tuple);
    this.camera.quaternion.fromArray(next.quaternion as QuaternionTuple).normalize();
    this.camera.fov = next.verticalFovDegrees;
    this.camera.aspect = next.aspectRatio;
    this.camera.near = next.near;
    this.camera.far = next.far;
    this.camera.updateProjectionMatrix();
    if (this.handheldActive) {
      this.handheldBaseline = undefined;
      this.lastDevicePose = undefined;
    }
    if (options.emitChange ?? true) this.emitCameraState(performance.now(), true);
  }

  get isHandheldActive(): boolean {
    return this.handheldActive;
  }

  /** Gives playback exclusive camera ownership until it releases the final pose. */
  setPlaybackActive(active: boolean): void {
    if (!active && this.disposed) return;
    this.assertUsable();
    if (this.playbackActive === active) return;
    this.playbackActive = active;
    this.syncNavigation();
    if (!active && this.handheldActive) {
      // The next physical sample anchors at playback's final camera, even if
      // the device moved while playback owned the camera.
      this.handheldBaseline = undefined;
      this.lastDevicePose = undefined;
    }
  }

  /**
   * Enters Magic Window mode: the current virtual camera pose becomes the
   * anchor, subsequent device poses steer the camera, and touch orbit
   * navigation is suspended until {@link exitHandheldMode}.
   */
  enterHandheldMode(translationScale = 1): void {
    this.assertUsable();
    this.handheldActive = true;
    this.handheldTranslationScale = translationScale;
    this.handheldBaseline = undefined;
    this.lastDevicePose = undefined;
    this.syncNavigation();
  }

  /** Feeds a physical device pose while Magic Window mode is active. */
  applyDevicePose(pose: DevicePose): void {
    this.assertUsable();
    if (!this.handheldActive || this.playbackActive) return;
    this.lastDevicePose = pose;
    this.handheldBaseline ??= this.captureHandheldBaseline(pose);
    const composed = composeHandheldPose(
      this.handheldBaseline,
      pose,
      this.handheldTranslationScale,
    );
    this.camera.position.fromArray(composed.position as [number, number, number]);
    this.camera.quaternion
      .fromArray(composed.quaternion as [number, number, number, number])
      .normalize();
    this.emitCameraState(performance.now());
  }

  /**
   * Re-anchors the virtual camera: the current physical pose becomes the new
   * zero so the user can reposition themselves without moving the frame.
   */
  recenterHandheld(): void {
    this.assertUsable();
    if (!this.handheldActive || this.playbackActive) return;
    if (this.lastDevicePose === undefined) {
      this.handheldBaseline = undefined;
      return;
    }
    this.handheldBaseline = this.captureHandheldBaseline(this.lastDevicePose);
  }

  exitHandheldMode(): void {
    if (this.disposed) return;
    this.handheldActive = false;
    this.handheldBaseline = undefined;
    this.lastDevicePose = undefined;
    this.syncNavigation();
  }

  /** Lets the app pause user navigation, for example while a sheet covers the viewport. */
  setNavigationEnabled(enabled: boolean): void {
    this.navigationRequested = enabled;
    this.syncNavigation();
  }

  /**
   * Distance from the camera to the scene surface under a viewport point, measured along
   * the viewing axis as a focus distance is. Undefined when nothing is hit.
   */
  pickFocusDistance(clientX: number, clientY: number): number | undefined {
    if (this.disposed || !this.activeSplatMesh) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const pointer = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    this.camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, this.camera);
    const hit = this.raycastSplat(raycaster.ray);
    if (!hit) return undefined;
    const forward = this.camera.getWorldDirection(new Vector3());
    const distance = hit.clone().sub(this.camera.position).dot(forward);
    return distance > 0 ? distance : undefined;
  }

  private syncNavigation(): void {
    this.navigation.enabled =
      this.navigationRequested &&
      !this.playbackActive &&
      !this.handheldActive &&
      !this.isMapViewActive;
  }

  // ── Map view ─────────────────────────────────────────────

  get isMapViewActive(): boolean {
    return this.mapView?.active ?? false;
  }

  /** The live map session, for gestures the app drives (tray drag, buttons, keyboard). */
  get map(): MapView | undefined {
    return this.mapView?.active ? this.mapView : undefined;
  }

  onMapViewChange(listener: (event: MapViewEvent) => void): () => void {
    this.mapListeners.add(listener);
    return () => this.mapListeners.delete(listener);
  }

  /**
   * Zooms out to an isometric overview rendered through a separate camera; the rig
   * camera stays where it is. The cinematographer stands where the camera stands.
   */
  async enterMapView(options: EnterMapViewOptions): Promise<void> {
    this.assertUsable();
    if (this.isMapViewActive) return;
    if (this.frameCapture) throw new Error("The map view is unavailable during a capture");
    if (this.handheldActive || this.playbackActive)
      throw new Error("Stop playback and handheld mode before opening the map");
    const mesh = this.activeSplatMesh;
    if (!mesh) throw new Error("Load a scene before opening the map");
    const map = this.ensureMapView();
    const figure = options.figure ?? true;
    if (figure) await this.preloadMapView();
    this.assertUsable();
    const splatBounds = sceneBounds(mesh);
    const cutaway = this.cutawayMode === "auto" ? this.estimateCutaway(mesh) : null;
    // With the sky or ceiling cut away, the map frames what is left; otherwise the
    // overview frames the scene's core and the figure's map frames the whole scene.
    // The overview also keeps every saved camera in view.
    const bounds = figure
      ? (cutaway?.core ?? splatBounds)
      : encloseBounds(cutaway?.core ?? sceneCoreBounds(mesh), this.planOverlay.markerPositions);
    const below = this.raycastSplat(new Ray(this.camera.position.clone(), new Vector3(0, -1, 0)));
    const standing = below ? this.camera.position.y - below.y : undefined;
    const eyeHeight = Math.max(
      1e-3,
      options.eyeHeight ??
        (standing !== undefined &&
        standing > splatBounds.radius * 0.01 &&
        standing < splatBounds.radius * 0.35
          ? standing
          : splatBounds.radius * 0.1),
    );
    const fraction = options.frameHeightFraction ?? 1;
    this.mapFrameFraction = Number.isFinite(fraction) ? Math.min(1, Math.max(0.05, fraction)) : 1;
    const rig = this.rigPose();
    const origin = below && this.camera.position.y - below.y < eyeHeight * 4 ? below : undefined;
    if (figure) this.scene.add(map.mannequin.group);
    else this.planOverlay.setMarkerDepth(splatBounds.radius * OVERVIEW_MARKER_SHARE);
    if (cutaway) {
      const revealMs = options.cutawayRevealMs ?? (options.reduceMotion ? 0 : MAP_ENTER_MS);
      this.showCutaway(cutaway, splatBounds.radius, revealMs);
    }
    const entered = map.enter({
      rig,
      bounds,
      eyeHeight,
      figure,
      reduceMotion: options.reduceMotion ?? false,
      ...(origin ? { origin: [origin.x, origin.y, origin.z] as const } : {}),
    });
    this.syncNavigation();
    await entered;
  }

  /**
   * A figure-free isometric turntable of the loaded scene, for browsing scenes (the
   * gallery preview). It opens at once, without the flight from the rig; after loading
   * another scene, call it again to frame that one. Drag spins, pinch zooms.
   */
  async showPreview(options: { readonly spin?: number } = {}): Promise<void> {
    if (this.isMapViewActive) await this.exitMapView();
    const spin = options.spin ?? PREVIEW_SPIN_RADIANS_PER_SECOND;
    await this.enterMapView({
      figure: false,
      reduceMotion: true,
      cutawayRevealMs: spin > 0 ? PREVIEW_CUTAWAY_MS : 0,
    });
    this.map?.setAutoRotate(spin);
  }

  /** Loads the cinematographer ahead of time so opening the map starts at once. */
  preloadMapView(): Promise<void> {
    const map = this.ensureMapView();
    this.mannequinReady ??= loadMannequinFigure(this.mannequinUrl).then((figure) =>
      map.mannequin.setFigure(figure),
    );
    return this.mannequinReady;
  }

  /** Flies back to the rig and closes the map without moving the camera. */
  async exitMapView(): Promise<void> {
    const map = this.map;
    if (!map) return;
    this.cutaway?.lower(MAP_ENTER_MS);
    await map.exit(this.rigPose());
    this.afterMapView();
  }

  /**
   * Dives into the cinematographer and adopts its eye-level pose as the rig camera (the
   * lens and output are unchanged). Emits one camera change.
   */
  async teleportToMannequin(): Promise<CameraState> {
    const map = this.map;
    if (!map) throw new Error("The map view is not open");
    this.cutaway?.lower(MAP_ENTER_MS);
    const pose = await map.dive();
    this.afterMapView();
    this.setCameraState({ position: pose.position, quaternion: pose.quaternion });
    return this.getCameraState();
  }

  private ensureMapView(): MapView {
    if (this.mapView) return this.mapView;
    const map = new MapView({
      element: this.canvas,
      // Hidden sky and ceiling splats must not catch the figure or a tap.
      raycast: (ray) => this.raycastSplat(ray, true),
    });
    let lodDriven: boolean | undefined;
    map.onChange((event) => {
      // Spark re-maps its level of detail as the view moves; during a long camera flight
      // that re-mapping never settles and the display stays empty. Hold the current
      // detail for the flight and resume once the camera comes to rest.
      const flying =
        event.phase === "entering" || event.phase === "diving" || event.phase === "exiting";
      if (flying && lodDriven === undefined) {
        lodDriven = this.sparkRenderer.enableDriveLod;
        this.sparkRenderer.enableDriveLod = false;
      } else if (!flying && lodDriven !== undefined) {
        this.sparkRenderer.enableDriveLod = lodDriven;
        lodDriven = undefined;
      }
      for (const listener of this.mapListeners) listener(event);
    });
    this.mapView = map;
    return map;
  }

  private afterMapView(): void {
    if (this.mapView) this.scene.remove(this.mapView.mannequin.group);
    this.removeCutaway();
    this.planOverlay.setMarkerDepth(undefined);
    this.syncNavigation();
  }

  /** The rig as seen through the full-bleed canvas: same centre, matched field of view. */
  private rigPose(): ViewPose {
    const { position, quaternion } = this.camera;
    const half = MathUtils.degToRad(this.camera.fov) / 2;
    const fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / this.mapFrameFraction));
    return {
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      fov,
    };
  }

  /** First splat surface along a world-space ray; optionally only splats left visible. */
  private raycastSplat(ray: Ray, visibleOnly = false): Vector3 | undefined {
    const mesh = this.activeSplatMesh;
    if (!mesh || this.disposed) return undefined;
    const raycaster = new Raycaster(ray.origin, ray.direction);
    const box = visibleOnly ? this.cutaway?.box : undefined;
    try {
      const hits = raycaster.intersectObject(mesh, false);
      const hit = box
        ? hits.find(({ point }) => insideCutaway(box, [point.x, point.y, point.z]))
        : hits[0];
      return hit?.point.clone();
    } catch {
      return undefined;
    }
  }

  // ── Cutaway ──────────────────────────────────────────────

  /** Whether the map hides the sky or ceiling. */
  get mapCutaway(): CutawayMode {
    return this.cutawayMode;
  }

  /** Whether the loaded scene has a sky or ceiling the map can cut away. */
  get canCutAway(): boolean {
    const mesh = this.activeSplatMesh;
    return mesh ? this.estimateCutaway(mesh) !== null : false;
  }

  /**
   * Shows ("off") or hides ("auto") the scene's sky or ceiling while the map is open; the
   * roof lifts off or settles back. Applies to every later map too.
   */
  setMapCutaway(mode: CutawayMode, options: { readonly reduceMotion?: boolean } = {}): void {
    this.assertUsable();
    this.cutawayMode = mode;
    const mesh = this.activeSplatMesh;
    if (!this.isMapViewActive || !mesh) return;
    const ms = options.reduceMotion ? 0 : MAP_ENTER_MS;
    if (mode === "off") {
      if (ms === 0) this.removeCutaway();
      else this.cutaway?.lower(ms);
      return;
    }
    const cutaway = this.estimateCutaway(mesh);
    if (cutaway) this.showCutaway(cutaway, sceneBounds(mesh).radius, ms);
  }

  private estimateCutaway(mesh: SplatMesh): Cutaway | null {
    if (this.cutawayEstimate?.mesh !== mesh) {
      const samples = sampleSplatCenters(mesh);
      this.cutawayEstimate = { mesh, value: samples ? estimateCutaway(samples) : null };
    }
    return this.cutawayEstimate.value;
  }

  private showCutaway(box: Cutaway, sceneRadius: number, revealMs: number): void {
    if (this.cutaway) {
      this.cutaway.raise(revealMs);
      return;
    }
    this.cutaway = new ActiveCutaway(box, sceneRadius, () => this.removeCutaway());
    this.scene.add(this.cutaway.edit);
    this.cutaway.raise(revealMs);
  }

  private removeCutaway(): void {
    if (!this.cutaway) return;
    this.scene.remove(this.cutaway.edit);
    this.cutaway = undefined;
  }

  /**
   * Renders one frame and returns it as an encoded data URL. Downscales to
   * `maxSize` on the longest edge so thumbnails stay cheap to persist.
   */
  captureStill(options: CaptureStillOptions = {}): string {
    return this.captureShot(options).thumbnailDataUrl;
  }

  /** Captures the live pose and its rendered image synchronously, without advancing navigation. */
  captureShot(options: CaptureStillOptions = {}): CapturedShot {
    this.assertUsable();
    if (this.isMapViewActive) throw new Error("Close the map before capturing a shot");
    const mimeType = options.mimeType ?? "image/jpeg";
    const quality = options.quality ?? 0.82;
    const source = this.renderer.domElement;
    const maxSize = options.maxSize ?? Math.min(4096, Math.max(source.width, source.height));
    if (!Number.isFinite(maxSize) || maxSize < 1 || maxSize > 4096) {
      throw new RangeError("Capture maxSize must be between 1 and 4096 pixels");
    }
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
      throw new RangeError("Capture quality must be between 0 and 1");
    }
    const camera = this.getCameraState();
    const frame = fitOutputFrame(source.width, source.height, camera.aspectRatio);
    const scale = Math.min(1, Math.floor(maxSize) / Math.max(frame.width, frame.height));
    const target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(frame.width * scale));
    target.height = Math.max(1, Math.round(frame.height * scale));
    const context = target.getContext("2d");
    if (!context) throw new Error("Still capture is unavailable: a 2D canvas could not be created");
    // Orientation aids are never part of a captured shot.
    const overlayShown = this.planOverlay.visible;
    this.planOverlay.visible = false;
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.planOverlay.visible = overlayShown;
    }
    // The projection remains fixed during resize. If the drawing buffer still
    // has the previous viewport shape, rescale its complete image to the output
    // aspect instead of cropping away part of the camera frame.
    context.drawImage(source, 0, 0, target.width, target.height);
    return { camera, thumbnailDataUrl: target.toDataURL(mimeType, quality) };
  }

  /**
   * Renders stills at the given poses, not the live one, for shots that lost or never had
   * an image. Uses the exclusive frame capture, so the live camera is restored afterwards.
   */
  async captureStillsAt(
    cameras: readonly CameraState[],
    options: CaptureStillOptions & { readonly signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const mimeType = options.mimeType ?? "image/jpeg";
    const quality = options.quality ?? 0.82;
    const maxSize = Math.floor(options.maxSize ?? 480);
    if (!Number.isFinite(maxSize) || maxSize < 1 || maxSize > 4096) {
      throw new RangeError("Capture maxSize must be between 1 and 4096 pixels");
    }
    if (cameras.length === 0) return [];
    const capture = this.beginFrameCapture();
    try {
      const images: string[] = [];
      for (const camera of cameras) {
        const frame = fitOutputFrame(maxSize, maxSize, camera.aspectRatio);
        const canvas = await capture.render(
          camera,
          Math.max(1, Math.round(frame.width)),
          Math.max(1, Math.round(frame.height)),
          options.signal,
        );
        images.push(canvas.toDataURL(mimeType, quality));
      }
      return images;
    } finally {
      capture.dispose();
    }
  }

  /** Makes the first synchronous capture usable as soon as the viewer reports ready. */
  async prepareFrame(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const source = this.renderer.domElement;
    const scale = Math.min(1, 4096 / Math.max(source.width, source.height, 1));
    const width = Math.max(1, Math.floor(source.width * scale));
    const height = Math.max(1, Math.floor(source.height * scale));
    const capture = this.beginFrameCapture();
    try {
      await capture.render(this.getCameraState(), width, height, signal);
    } finally {
      capture.dispose();
    }
  }

  /** Exclusive deterministic capture; normal camera rendering resumes on dispose. */
  beginFrameCapture(): FrameCaptureSession {
    this.assertUsable();
    if (this.isMapViewActive) throw new Error("Close the map before capturing frames");
    if (this.frameCapture) throw new Error("A frame capture is already in progress");
    const target = document.createElement("canvas");
    const context = target.getContext("2d");
    if (!context) throw new Error("Video capture is unavailable: a 2D canvas could not be created");
    const original = {
      camera: this.getCameraState(),
      running: this.isRunning,
      playback: this.playbackActive,
      autoUpdate: this.sparkRenderer.autoUpdate,
      minSortIntervalMs: this.sparkRenderer.minSortIntervalMs,
      renderSize: this.sparkRenderer.renderSize.clone(),
      enableLod: this.sparkRenderer.enableLod,
      enableDriveLod: this.sparkRenderer.enableDriveLod,
      pixelRatio: this.renderer.getPixelRatio(),
      size: this.renderer.getSize(new Vector2()),
      overlay: this.planOverlay.visible,
    };
    const lifetime = new AbortController();
    let disposed = false;
    let rendering = false;
    this.stop();
    this.resumeAfterCapture = original.running;
    this.planOverlay.visible = false;
    this.setPlaybackActive(true);
    this.sparkRenderer.autoUpdate = false;
    this.sparkRenderer.minSortIntervalMs = 0;
    // A queued automatic update would otherwise compete with the first capture.
    clearTimeout(this.sparkRenderer.updateTimeoutId);
    this.sparkRenderer.updateTimeoutId = -1;
    clearTimeout(this.sparkRenderer.sortTimeoutId);
    this.sparkRenderer.sortTimeoutId = -1;
    // Use the original splats, avoiding asynchronous LOD selection between frames.
    this.sparkRenderer.enableLod = false;
    this.sparkRenderer.enableDriveLod = false;
    const session: FrameCaptureSession = {
      render: async (camera, width, height, signal) => {
        signal?.throwIfAborted();
        lifetime.signal.throwIfAborted();
        this.assertUsable();
        if (rendering)
          throw new Error("Wait for the previous video frame before rendering another");
        if (![width, height].every((size) => Number.isInteger(size) && size >= 1 && size <= 4096)) {
          throw new RangeError("Video frame dimensions must be whole pixels between 1 and 4096");
        }
        rendering = true;
        const frame = new AbortController();
        const abortFromSession = () => frame.abort(lifetime.signal.reason);
        const abortFromCaller = () => frame.abort(signal?.reason);
        lifetime.signal.addEventListener("abort", abortFromSession, { once: true });
        signal?.addEventListener("abort", abortFromCaller, { once: true });
        try {
          // Spark.update() returns early if a previous sort is still active.
          // Wait for live rendering's final sort before submitting a new camera.
          const deadline = Date.now() + 30_000;
          while (this.sparkRenderer.sorting) {
            if (Date.now() >= deadline)
              throw new Error("Scene preparation timed out. Retry video export.");
            await abortable(new Promise<void>((resolve) => setTimeout(resolve, 4)), frame.signal);
          }
          frame.signal.throwIfAborted();
          this.renderer.setPixelRatio(1);
          this.renderer.setSize(width, height, false);
          this.sparkRenderer.renderSize.set(width, height);
          this.setCameraState(camera, { emitChange: false });
          this.scene.updateMatrixWorld(true);
          this.camera.updateMatrixWorld(true);
          await abortable(
            this.sparkRenderer.update({ scene: this.scene, camera: this.camera }),
            frame.signal,
          );
          frame.signal.throwIfAborted();
          this.assertUsable();
          this.renderer.render(this.scene, this.camera);
          if (target.width !== width) target.width = width;
          if (target.height !== height) target.height = height;
          // The WebGL scene has a transparent background. Reusing the encoder
          // canvas must replace the previous frame, not blend new splats over it.
          context.clearRect(0, 0, width, height);
          context.drawImage(this.renderer.domElement, 0, 0, width, height);
          return target;
        } finally {
          signal?.removeEventListener("abort", abortFromCaller);
          lifetime.signal.removeEventListener("abort", abortFromSession);
          rendering = false;
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        this.frameCapture = undefined;
        target.width = 0;
        target.height = 0;
        if (this.disposed) return;
        this.sparkRenderer.autoUpdate = original.autoUpdate;
        this.sparkRenderer.minSortIntervalMs = original.minSortIntervalMs;
        this.sparkRenderer.renderSize.copy(original.renderSize);
        this.sparkRenderer.enableLod = original.enableLod;
        this.sparkRenderer.enableDriveLod = original.enableDriveLod;
        this.renderer.setPixelRatio(original.pixelRatio);
        const size = this.deferredResize ?? { width: original.size.x, height: original.size.y };
        this.deferredResize = undefined;
        this.resize(size.width, size.height);
        this.setCameraState(original.camera, { emitChange: false });
        this.planOverlay.visible = original.overlay;
        this.setPlaybackActive(original.playback);
        if (this.resumeAfterCapture) this.start();
      },
    };
    this.frameCapture = session;
    return session;
  }

  private captureHandheldBaseline(pose: DevicePose): HandheldBaseline {
    const { position, quaternion } = this.camera;
    return {
      virtualPosition: [position.x, position.y, position.z],
      virtualQuaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      devicePosition: pose.position,
      deviceQuaternion: pose.quaternion,
    };
  }

  /** Replaces the shot markers and move path drawn in the viewport (never captured). */
  setPlanOverlay(state: PlanOverlayState | undefined): void {
    this.assertUsable();
    this.planOverlay.update(state);
  }

  setPlanOverlayVisible(visible: boolean): void {
    this.assertUsable();
    // A capture in progress restores its own visibility on completion.
    if (this.frameCapture) return;
    this.planOverlay.visible = visible;
  }

  get isPlanOverlayVisible(): boolean {
    return this.planOverlay.visible;
  }

  /** The shot marker under a viewport point (client coordinates), if any. */
  pickShotMarker(clientX: number, clientY: number, radiusPx?: number): string | undefined {
    if (this.disposed) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    return this.planOverlay.pick(
      this.viewCamera,
      rect.width,
      rect.height,
      clientX - rect.left,
      clientY - rect.top,
      radiusPx,
    );
  }

  /**
   * Where each shot marker appears in the viewport through the camera being displayed
   * (the map camera while the map is open). Markers off screen are left out.
   */
  projectShotMarkers(): ShotMarkerScreenPosition[] {
    if (this.disposed) return [];
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return this.planOverlay
      .project(this.viewCamera, rect.width, rect.height)
      .map((marker) => ({ ...marker, x: marker.x + rect.left, y: marker.y + rect.top }));
  }

  /** The camera the canvas shows: the map camera while the map is open, else the rig. */
  private get viewCamera(): PerspectiveCamera {
    return this.mapView?.active ? this.mapView.camera : this.camera;
  }

  onCameraStateChange(listener: CameraStateListener): () => void {
    this.cameraListeners.add(listener);
    return () => this.cameraListeners.delete(listener);
  }

  onPerformanceSample(listener: PerformanceSampleListener): () => void {
    this.performanceListeners.add(listener);
    return () => this.performanceListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.frameCapture?.dispose();
    this.loadAbortController?.abort();
    this.resizeObserver?.disconnect();
    this.removeWindowResizeListener?.();
    this.cameraListeners.clear();
    this.performanceListeners.clear();
    this.clearActiveSplat();
    this.scene.remove(this.planOverlay.group);
    this.planOverlay.dispose();
    this.mapView?.dispose();
    this.mapListeners.clear();
    this.navigation.dispose();
    this.scene.remove(this.sparkRenderer);
    disposeObject(this.sparkRenderer);
    this.renderer.dispose();
  }

  private readonly renderFrame = (timestampMs: number): void => {
    if (this.disposed || this.animationFrame === undefined) return;
    const generation = this.animationGeneration;
    const frameDurationMs =
      this.lastFrameAt === undefined ? 0 : Math.max(0, timestampMs - this.lastFrameAt);
    this.lastFrameAt = timestampMs;
    if (frameDurationMs > 0) {
      this.recentFrameDurationsMs.push(frameDurationMs);
      if (this.recentFrameDurationsMs.length > 120) this.recentFrameDurationsMs.shift();
    }

    const map = this.mapView?.active ? this.mapView : undefined;
    this.cutaway?.update(frameDurationMs);
    if (map) {
      // The rig camera is frozen while the map is open; only the view camera moves.
      map.update(frameDurationMs);
    } else if (!this.playbackActive && !this.handheldActive && !this.frameCapture) {
      this.navigation.update(frameDurationMs);
    }
    this.renderer.render(this.scene, map ? map.camera : this.camera);
    if (this.activeTimeToFirstFrameMs === undefined && this.activeSceneReadyAtMs !== undefined) {
      this.activeTimeToFirstFrameMs = Math.max(0, performance.now() - this.activeSceneReadyAtMs);
    }
    if (!map) this.emitCameraState(timestampMs);
    if (timestampMs - this.lastPerformanceSampleAt >= this.performanceSampleIntervalMs) {
      const sample = performanceSampleFromRenderer(this.renderer, timestampMs, frameDurationMs, {
        ...(this.activeDescriptor === undefined ? {} : { sceneId: this.activeDescriptor.id }),
        ...(this.activeLoadDurationMs === undefined
          ? {}
          : { loadDurationMs: this.activeLoadDurationMs }),
        ...(this.activeTimeToFirstFrameMs === undefined
          ? {}
          : { timeToFirstFrameMs: this.activeTimeToFirstFrameMs }),
        frameDurationsMs: this.recentFrameDurationsMs,
      });
      for (const listener of this.performanceListeners) listener(sample);
      this.lastPerformanceSampleAt = timestampMs;
    }
    if (
      !this.disposed &&
      generation === this.animationGeneration &&
      this.animationFrame !== undefined
    ) {
      this.animationFrame = this.scheduler.request(this.renderFrame);
    }
  };

  private emitCameraState(timestampMs: number, force = false): void {
    if (!force && timestampMs - this.lastCameraEventAt < this.cameraEventIntervalMs) return;
    const state = this.getCameraState();
    const signature = JSON.stringify(state);
    if (!force && signature === this.lastCameraSignature) return;
    for (const listener of this.cameraListeners) listener(state);
    this.lastCameraSignature = signature;
    this.lastCameraEventAt = timestampMs;
  }

  private installResizeHandling(): void {
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
      return;
    }
    const listener = () => this.resize();
    globalThis.addEventListener("resize", listener);
    this.removeWindowResizeListener = () => globalThis.removeEventListener("resize", listener);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("SceneEngine has been disposed");
  }
}
