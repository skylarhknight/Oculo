import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Check, Compass, House, RotateCcw, RotateCw, X } from "lucide-react";
import type { MapView, MapViewPhase } from "@oculo/scene-core";
import { confirmHaptic, tapHaptic } from "../../services/haptics";

/** The part of the engine's map session the overlay drives. */
export type MapControls = Pick<
  MapView,
  | "startCarry"
  | "carryTo"
  | "drop"
  | "placeAt"
  | "figureScreenPosition"
  | "rotateBy"
  | "snapTo"
  | "turn"
>;

const STEP = Math.PI / 4;
const TURN = Math.PI / 12;
const NUDGE_PX = 24;
const DRAG_START_PX = 6;
const TOKEN = `${import.meta.env.BASE_URL}models/cinematographer-token@2x.png`;
const TOKEN_3X = `${import.meta.env.BASE_URL}models/cinematographer-token@3x.png`;

const HINTS: Record<MapViewPhase, string> = {
  off: "",
  entering: "Rising above the scene…",
  map: "Drag the cinematographer into the scene",
  dragging: "Drop to place",
  placed: "Swipe to aim, then Go",
  diving: "Stepping in…",
  exiting: "Back to your camera…",
};

interface MapModeProps {
  /** The live map session, once the engine has opened it. */
  controls: MapControls | undefined;
  phase: MapViewPhase;
  /** Viewport the map fills, for placing the figure without a drag. */
  viewportRef: { readonly current: HTMLElement | null };
  /** Updated every frame by the parent with the map rotation, for the compass. */
  compassRef: { current: HTMLElement | null };
  reduceMotion: boolean;
  /** Whether the scene's sky or ceiling is cut away; absent when there is none to cut. */
  cutaway?: { readonly on: boolean; readonly onToggle: () => void } | undefined;
  onGo: () => void;
  onClose: () => void;
}

/**
 * Map mode overlay: rotate the isometric scene, drag the cinematographer from the dock
 * onto it, aim, and Go. Every gesture has a button or key equivalent.
 */
export function MapMode({
  controls,
  phase,
  viewportRef,
  compassRef,
  reduceMotion,
  cutaway,
  onGo,
  onClose,
}: MapModeProps) {
  const tokenRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; valid: boolean } | null>(
    null,
  );
  const [tokenState, setTokenState] = useState<"rest" | "lifted" | "handed-off" | "returning">(
    "rest",
  );
  const [aiming, setAiming] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const interactive = phase === "map" || phase === "placed" || phase === "dragging";
  const placed = phase === "placed";
  const hint =
    phase === "dragging" && drag.current && !drag.current.valid
      ? "Find solid ground"
      : HINTS[phase];

  // Restart the auto-Go countdown whenever the figure lands or aiming ends.
  useEffect(() => {
    if (placed && !aiming) setCountdown((value) => value + 1);
  }, [placed, aiming]);

  // Aiming happens on the scene itself; pause the countdown while a finger is down.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !placed) return;
    // Only touches on the scene aim; the overlay's own buttons do not.
    const down = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".map-mode")) return;
      setAiming(true);
    };
    const up = () => setAiming(false);
    viewport.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      viewport.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setAiming(false);
    };
  }, [placed, viewportRef]);

  const placeAtCentre = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!controls || !rect) return;
    if (controls.placeAt(rect.left + rect.width / 2, rect.top + rect.height * 0.55))
      confirmHaptic();
  };

  // Keyboard: arrows move the placed figure, [ and ] turn it, Enter goes, Escape closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!controls || !interactive) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!placed) return;
      const nudge: Record<string, [number, number]> = {
        ArrowUp: [0, -NUDGE_PX],
        ArrowDown: [0, NUDGE_PX],
        ArrowLeft: [-NUDGE_PX, 0],
        ArrowRight: [NUDGE_PX, 0],
      };
      const step = nudge[event.key];
      if (step) {
        event.preventDefault();
        const at = controls.figureScreenPosition();
        if (at) controls.placeAt(at.x + step[0], at.y + step[1]);
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        controls.turn(event.key === "[" ? TURN : -TURN);
        setCountdown((value) => value + 1);
      } else if (event.key === "Enter" && target?.tagName !== "BUTTON") {
        event.preventDefault();
        onGo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controls, interactive, placed, onGo, onClose]);

  const moveToken = (dx: number, dy: number) => {
    tokenRef.current?.style.setProperty("--drag-x", `${dx}px`);
    tokenRef.current?.style.setProperty("--drag-y", `${dy}px`);
  };

  const onTokenDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!controls || !interactive || event.button !== 0) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      valid: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setTokenState("lifted");
    tapHaptic();
  };

  const onTokenMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || !controls) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_START_PX) return;
      current.moved = true;
      controls.startCarry();
    }
    moveToken(dx, dy);
    const valid = controls.carryTo(event.clientX, event.clientY);
    if (valid !== current.valid) {
      current.valid = valid;
      tapHaptic();
      // Over solid ground the 3D figure takes over from the flat token.
      setTokenState(valid ? "handed-off" : "lifted");
    }
  };

  const onTokenUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (!current.moved || !controls) {
      setTokenState("rest");
      moveToken(0, 0);
      return;
    }
    const landed = controls.drop(event.clientX, event.clientY);
    if (landed) confirmHaptic();
    // The token springs back into the dock either way; the figure now lives in the scene.
    setTokenState("returning");
    requestAnimationFrame(() => moveToken(0, 0));
  };

  return (
    <div className="map-mode" data-phase={phase} data-reduce-motion={reduceMotion}>
      <div className="map-topbar">
        <button className="map-glass map-done" onClick={onClose} disabled={!interactive}>
          <X size={18} /> Close map
        </button>
        {cutaway && (
          <button
            className="map-glass map-roof"
            aria-label="Show roof"
            aria-pressed={!cutaway.on}
            disabled={!interactive}
            onClick={() => {
              tapHaptic();
              cutaway.onToggle();
            }}
          >
            <House size={16} /> Roof
          </button>
        )}
        <div className="map-rotate" role="group" aria-label="Rotate map">
          <button
            className="map-glass map-round"
            aria-label="Rotate map left"
            disabled={!interactive}
            onClick={() => controls?.rotateBy(-STEP)}
          >
            <RotateCcw size={18} />
          </button>
          <button
            ref={(element) => {
              compassRef.current = element;
            }}
            className="map-glass map-round map-compass"
            aria-label="Straighten map"
            disabled={!interactive}
            onClick={() => controls?.snapTo(STEP)}
          >
            <Compass size={20} />
          </button>
          <button
            className="map-glass map-round"
            aria-label="Rotate map right"
            disabled={!interactive}
            onClick={() => controls?.rotateBy(STEP)}
          >
            <RotateCw size={18} />
          </button>
        </div>
      </div>

      <p className="map-hint" role="status" aria-live="polite" key={hint}>
        {hint}
      </p>

      <div className="map-dock">
        <button
          ref={tokenRef}
          className="map-token"
          data-state={tokenState}
          aria-label={
            placed ? "Move the cinematographer to the centre" : "Place the cinematographer"
          }
          aria-describedby="map-token-help"
          disabled={!interactive}
          onPointerDown={onTokenDown}
          onPointerMove={onTokenMove}
          onPointerUp={onTokenUp}
          onPointerCancel={onTokenUp}
          onClick={(event) => {
            // Keyboard and assistive activation (a click without a drag) places at the centre.
            if (event.detail === 0) placeAtCentre();
          }}
          onTransitionEnd={() => {
            if (tokenState === "returning") setTokenState("rest");
          }}
        >
          <img src={TOKEN} srcSet={`${TOKEN} 2x, ${TOKEN_3X} 3x`} alt="" draggable={false} />
          <span className="map-token__shadow" aria-hidden="true" />
        </button>
        <span id="map-token-help" className="visually-hidden">
          Drag onto the scene to stand there. Arrow keys move it, brackets turn it, Enter goes.
        </span>
        {placed && (
          <button
            key={countdown}
            className="map-go"
            data-countdown={!reduceMotion && !aiming}
            onClick={onGo}
            onAnimationEnd={(event) => {
              if (event.animationName === "map-countdown" && !aiming) onGo();
            }}
          >
            <svg className="map-go__ring" aria-hidden="true">
              <rect className="map-go__track" pathLength={1} />
              <rect className="map-go__progress" pathLength={1} />
            </svg>
            <Check size={20} /> Go
          </button>
        )}
      </div>
    </div>
  );
}
