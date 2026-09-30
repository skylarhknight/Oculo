import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { LoadProgress, SceneEngine } from "@oculo/scene-core";
import type { CinematicCamera, SceneDescriptor } from "@oculo/scene-schema";
import { aspectLabel, fromCameraState, toCameraState } from "../services/cameraState";

interface SceneViewerProps {
  descriptor: SceneDescriptor;
  camera: CinematicCamera;
  liveCameraRef: MutableRefObject<CinematicCamera>;
  showGrid: boolean;
  showSafeFrame: boolean;
  onReady?: () => void;
  onError?: (message: string) => void;
  onProgress?: (progress: LoadProgress) => void;
  onCameraChange: (camera: CinematicCamera) => void;
  engineRef: MutableRefObject<SceneEngine | null>;
  /**
   * Map view: the canvas fills the stage. `letterbox` "closed" clips it back to the output
   * frame (animated), so the map can open out of, and land back into, the composed frame.
   */
  fullBleed?: boolean;
  letterbox?: "open" | "closed";
  /** Output-frame height / stage height, reported for the map view's matched hand-off. */
  onFrameFraction?: (fraction: number) => void;
  /** Resolves durable local assets to temporary URLs owned by this viewer. */
  resolveScene?: (
    scene: SceneDescriptor,
    signal: AbortSignal,
  ) => Promise<{ scene: SceneDescriptor; url?: string; release: () => void }>;
}

export function SceneViewer({
  descriptor,
  camera,
  liveCameraRef,
  showGrid,
  showSafeFrame,
  onReady,
  onError,
  onProgress,
  onCameraChange,
  engineRef,
  resolveScene,
  fullBleed = false,
  letterbox = "closed",
  onFrameFraction,
}: SceneViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [fitFrame, setFitFrame] = useState<
    | ((
        width: number,
        height: number,
        aspect: number,
      ) => { x: number; y: number; width: number; height: number })
    | null
  >(null);
  const callbacksRef = useRef({ onReady, onError, onProgress, onCameraChange, onFrameFraction });
  callbacksRef.current = { onReady, onError, onProgress, onCameraChange, onFrameFraction };

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame || !fitFrame) return;
    const resize = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const bounds = fitFrame(width, height, camera.output.aspectRatio);
      if (height > 0) callbacksRef.current.onFrameFraction?.(bounds.height / height);
      const inset = `inset(${bounds.y}px ${width - bounds.x - bounds.width}px ${
        height - bounds.y - bounds.height
      }px ${bounds.x}px)`;
      frame.style.setProperty("--letterbox", inset);
      const area = fullBleed ? { x: 0, y: 0, width, height } : bounds;
      Object.assign(frame.style, {
        left: `${area.x}px`,
        top: `${area.y}px`,
        width: `${area.width}px`,
        height: `${area.height}px`,
      });
      engineRef.current?.resize(area.width, area.height);
    };
    resize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(resize);
      observer.observe(stage);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [camera.output.aspectRatio, engineRef, fitFrame, fullBleed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: SceneEngine | undefined;
    let stopCameraListener: (() => void) | undefined;
    let releaseAsset: (() => void) | undefined;
    const load = new AbortController();
    let disposed = false;
    let failed = false;
    const releaseScene = () => {
      stopCameraListener?.();
      stopCameraListener = undefined;
      engine?.dispose();
      if (engineRef.current === engine) engineRef.current = null;
      engine = undefined;
      const release = releaseAsset;
      releaseAsset = undefined;
      release?.();
    };
    const suspend = () => {
      if (!engine || disposed) return;
      engine.stop();
      // Discard navigation inertia at the last visible frame.
      engine.setCameraState(engine.getCameraState(), { emitChange: false });
    };
    const resume = () => {
      if (!disposed && !failed && document.visibilityState !== "hidden") engine?.start();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") suspend();
      else resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);

    void (async () => {
      try {
        const {
          BundledSceneSource,
          SceneEngine: SceneEngineImplementation,
          fitOutputFrame,
        } = await import("@oculo/scene-core");
        if (disposed) return;
        const asset = resolveScene
          ? await resolveScene(descriptor, load.signal)
          : { scene: descriptor, release: () => undefined };
        if (disposed) {
          asset.release();
          return;
        }
        releaseAsset = asset.release;
        setFitFrame(() => fitOutputFrame);

        engine = new SceneEngineImplementation({
          canvas,
          ...("url" in asset && typeof asset.url === "string"
            ? { resolveSplatUrl: () => String(asset.url) }
            : {}),
          cameraEventIntervalMs: 100,
          autoStart: false,
          autoResize: false,
          mannequinUrl: `${import.meta.env.BASE_URL}models/cinematographer.glb`,
        });
        engineRef.current = engine;
        stopCameraListener = engine.onCameraStateChange((state) => {
          if (disposed) return;
          const current = fromCameraState(state, liveCameraRef.current);
          liveCameraRef.current = current;
          callbacksRef.current.onCameraChange(current);
        });

        engine.setCameraState(toCameraState(liveCameraRef.current), { emitChange: false });
        resume();
        await engine.load(new BundledSceneSource(asset.scene), {
          signal: load.signal,
          onProgress: (progress) => {
            if (!disposed) callbacksRef.current.onProgress?.(progress);
          },
        });
        if (disposed) return;
        // Decoding completes before Spark's first sort. Wait for a prepared
        // frame so Save shot cannot capture an empty renderer after Ready.
        await engine.prepareFrame(load.signal);
        if (!disposed) callbacksRef.current.onReady?.();
      } catch (error: unknown) {
        if (!disposed) {
          failed = true;
          releaseScene();
          callbacksRef.current.onError?.(
            error instanceof Error ? error.message : "The scene could not be loaded.",
          );
        }
      }
    })();

    return () => {
      disposed = true;
      load.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
      releaseScene();
    };
  }, [descriptor, engineRef, liveCameraRef, resolveScene]);

  return (
    <div ref={stageRef} className="scene-stage">
      <div
        ref={frameRef}
        className="output-frame"
        data-bleed={fullBleed}
        data-letterbox={fullBleed ? letterbox : undefined}
      >
        <canvas ref={canvasRef} className="scene-canvas" aria-label="Interactive scene viewer" />
        {showGrid && <div className="composition-grid" aria-hidden="true" />}
        {showSafeFrame && (
          <div className="safe-frame" aria-hidden="true">
            <span>{aspectLabel(camera.output.aspectRatio)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
