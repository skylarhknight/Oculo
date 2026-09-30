import { useEffect, useRef } from "react";
import { RotateCcw, RotateCw } from "lucide-react";
import type { SceneEngine } from "@oculo/scene-core";
import type { SceneDescriptor } from "@oculo/scene-schema";
import { prefersReducedMotion } from "../theme/motion";

export type PreviewStatus = "idle" | "loading" | "ready" | "error";

interface ScenePreviewProps {
  /** The scene to show; null keeps the canvas empty. */
  descriptor: SceneDescriptor | null;
  /** A local URL for the scene's bytes (a downloaded gallery scene). */
  url?: string | undefined;
  label: string;
  onStatus: (status: PreviewStatus, message?: string) => void;
}

const QUARTER_TURN = Math.PI / 4;

/**
 * A spinning isometric preview of a scene for the scene gallery: one engine for the
 * life of the screen, re-framed for each scene. Drag spins, pinch zooms; the rotate
 * buttons serve VoiceOver and keyboards. The engine is disposed when the screen goes.
 */
export function ScenePreview({ descriptor, url, label, onStatus }: ScenePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Promise<SceneEngine> | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  // One engine per screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: SceneEngine | undefined;
    const created = import("@oculo/scene-core").then(({ SceneEngine }) => {
      engine = new SceneEngine({
        canvas,
        autoStart: false,
        cameraEventIntervalMs: 1000,
        resolveSplatUrl: (scene) => {
          if (urlRef.current) return urlRef.current;
          const locator = scene.asset.locator;
          if (locator.kind === "local") return `${import.meta.env.BASE_URL}${locator.relativePath}`;
          if (locator.kind === "remote") return locator.url;
          throw new Error("This scene isn't available in this build.");
        },
      });
      if (disposed) engine.dispose();
      else if (document.visibilityState !== "hidden") engine.start();
      return engine;
    });
    engineRef.current = created;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") engine?.stop();
      else engine?.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Load and frame each scene; a newer choice cancels the previous load.
  useEffect(() => {
    if (!descriptor) {
      statusRef.current("idle");
      return;
    }
    const load = new AbortController();
    statusRef.current("loading");
    void (async () => {
      try {
        const engine = await engineRef.current;
        if (!engine || load.signal.aborted) return;
        const { BundledSceneSource } = await import("@oculo/scene-core");
        // Close the previous scene's preview; frames can't be prepared while it is open.
        if (engine.isMapViewActive) await engine.exitMapView();
        if (load.signal.aborted) return;
        await engine.load(new BundledSceneSource(descriptor), { signal: load.signal });
        if (load.signal.aborted) return;
        // Start the turntable from the creator's view of the scene.
        if (descriptor.initialCameraPose)
          engine.setCameraState(descriptor.initialCameraPose, { emitChange: false });
        await engine.prepareFrame(load.signal);
        await engine.showPreview(prefersReducedMotion() ? { spin: 0 } : {});
        if (!load.signal.aborted) statusRef.current("ready");
      } catch (reason) {
        if (load.signal.aborted) return;
        statusRef.current(
          "error",
          reason instanceof Error ? reason.message : "The preview couldn't load.",
        );
      }
    })();
    return () => load.abort();
  }, [descriptor, url]);

  const rotate = (step: number) =>
    void engineRef.current?.then((engine) => engine.map?.rotateBy(step));

  return (
    <div className="scene-preview">
      <canvas
        ref={canvasRef}
        className="scene-preview__canvas"
        role="img"
        aria-label={`${label}. Drag to spin, pinch to zoom.`}
      />
      <div className="scene-preview__rotate">
        <button
          className="scene-preview__turn"
          aria-label="Turn left"
          disabled={!descriptor}
          onClick={() => rotate(-QUARTER_TURN)}
        >
          <RotateCcw size={16} />
        </button>
        <button
          className="scene-preview__turn"
          aria-label="Turn right"
          disabled={!descriptor}
          onClick={() => rotate(QUARTER_TURN)}
        >
          <RotateCw size={16} />
        </button>
      </div>
    </div>
  );
}
