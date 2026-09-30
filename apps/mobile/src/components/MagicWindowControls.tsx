import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Crosshair, ScanEye, X } from "lucide-react";
import type { CameraPoseSource, PoseTrackingQuality, SceneEngine } from "@oculo/scene-core";
import { createDevicePoseSource } from "../services/DevicePoseService";
import { confirmHaptic, tapHaptic, warnHaptic } from "../services/haptics";

interface MagicWindowControlsProps {
  engineRef: MutableRefObject<SceneEngine | null>;
  /** Navigation gain in scene units per device meter; not a metric-scale claim. */
  translationScale?: number;
  onActiveChange?: (active: boolean) => void;
  /** Playback and scene departure have exclusive ownership of the camera. */
  disabled?: boolean;
}

const QUALITY_LABEL: Record<PoseTrackingQuality, string> = {
  initializing: "Finding space · Frame held",
  normal: "Tracking",
  limited: "Move slowly · Frame held",
  unavailable: "Tracking lost · Frame held",
};

interface TrackingSession {
  engine: SceneEngine;
  quality: PoseTrackingQuality;
  needsBaseline: boolean;
  removeListeners: (() => void)[];
}

/**
 * Magic Window mode: physical 6DoF phone movement drives the virtual camera.
 * Renders nothing when the platform cannot deliver device poses.
 */
export function MagicWindowControls({
  engineRef,
  translationScale = 1,
  onActiveChange,
  disabled = false,
}: MagicWindowControlsProps) {
  const source = useMemo<CameraPoseSource>(() => createDevicePoseSource(), []);
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [quality, setQuality] = useState<PoseTrackingQuality>("initializing");
  const [error, setError] = useState("");
  const sessionRef = useRef<TrackingSession | null>(null);
  const mountedRef = useRef(false);
  const disabledRef = useRef(disabled);
  const onActiveChangeRef = useRef(onActiveChange);
  disabledRef.current = disabled;
  onActiveChangeRef.current = onActiveChange;

  const stopSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.removeListeners.forEach((remove) => remove());
    // Release the engine captured by this session, never a replacement viewer.
    session.engine.exitHandheldMode();
    onActiveChangeRef.current?.(false);
    if (mountedRef.current) {
      setActive(false);
      setStarting(false);
    }
    try {
      await source.stop();
    } catch {
      if (mountedRef.current && !sessionRef.current) {
        setError("Motion tracking could not stop. Reopen the scene to retry.");
      }
    }
  }, [source]);

  useEffect(() => {
    let cancelled = false;
    void source.isAvailable().then(
      (result) => {
        if (!cancelled) setAvailable(result);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void stopSession();
    };
    const onPageHide = () => {
      void stopSession();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void stopSession();
    };
  }, [stopSession]);

  useEffect(() => {
    if (disabled) void stopSession();
  }, [disabled, stopSession]);

  if (!available) return null;

  const enable = async () => {
    const engine = engineRef.current;
    if (
      !engine ||
      disabledRef.current ||
      sessionRef.current ||
      !mountedRef.current ||
      document.visibilityState === "hidden"
    )
      return;
    const session: TrackingSession = {
      engine,
      quality: "initializing",
      needsBaseline: true,
      removeListeners: [],
    };
    sessionRef.current = session;
    const isCurrent = () =>
      mountedRef.current &&
      sessionRef.current === session &&
      !disabledRef.current &&
      document.visibilityState !== "hidden";
    setStarting(true);
    setError("");
    try {
      engine.enterHandheldMode(translationScale);
      setQuality("initializing");
      // Subscribe before start: native tracking may become normal before its
      // start promise resolves. Ignore all uncertain poses and re-anchor on the
      // first good pose after loss, relocalization or recentering.
      session.removeListeners.push(
        source.onTrackingQuality((next) => {
          if (!isCurrent()) return;
          session.quality = next;
          if (next !== "normal") session.needsBaseline = true;
          setQuality(next);
        }),
      );
      session.removeListeners.push(
        source.onPose((pose) => {
          if (!isCurrent() || session.quality !== "normal") return;
          if (session.needsBaseline) {
            engine.enterHandheldMode(translationScale);
            session.needsBaseline = false;
          }
          engine.applyDevicePose(pose);
        }),
      );
      await source.start();
      if (!isCurrent()) return;
      setActive(true);
      onActiveChangeRef.current?.(true);
      confirmHaptic();
    } catch (reason) {
      if (isCurrent()) {
        // stopSession invalidates the session synchronously before awaiting
        // cleanup, so failure cannot keep steering the virtual camera.
        void stopSession();
        setError(reason instanceof Error ? reason.message : "Motion tracking could not start.");
        warnHaptic();
      }
    } finally {
      if (isCurrent()) setStarting(false);
    }
  };

  const disable = async () => {
    setError("");
    tapHaptic();
    await stopSession();
  };

  const recenter = () => {
    const session = sessionRef.current;
    if (!session || disabledRef.current) return;
    session.needsBaseline = true;
    tapHaptic();
  };

  if (!active) {
    return (
      <div className="magic-window-controls">
        <button
          className="magic-toggle"
          onClick={() => void enable()}
          disabled={starting || disabled}
        >
          <ScanEye size={15} /> {starting ? "Starting…" : "Magic Window"}
        </button>
        {error && <span className="magic-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="magic-window-controls active">
      <span className={`tracking-chip quality-${quality}`} role="status">
        <i /> {QUALITY_LABEL[quality]}
      </span>
      <button
        className="magic-action"
        onClick={recenter}
        disabled={disabled || quality !== "normal"}
      >
        <Crosshair size={14} /> Recenter
      </button>
      <button
        className="magic-action exit"
        onClick={() => void disable()}
        aria-label="Exit Magic Window"
      >
        <X size={14} />
      </button>
    </div>
  );
}
