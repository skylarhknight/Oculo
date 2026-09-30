import { useEffect, useRef, type CSSProperties } from "react";
import { Move3d } from "lucide-react";
import type { MapViewPhase, SceneEngine } from "@oculo/scene-core";
import type { Shot } from "../../types/project";

interface ShotsOverviewProps {
  engineRef: { readonly current: SceneEngine | null };
  phase: MapViewPhase;
  shots: readonly Shot[];
  /** The shot open in Compose, drawn in the accent color. */
  activeShotId: string | null;
  /** A shot the user is pointing at in the list, lifted on the map. */
  highlightId: string | null;
  disabled: boolean;
  onOpen: (shot: Shot) => void;
}

const FAN_RADIUS_PX = 34;
const FAN_STEP_PX = 32;
const FAN_ROW = 4;
/** Keeps fanned pins this far inside the overview's edges. */
const EDGE_PX = 18;

/**
 * Offsets that spread pins sharing (nearly) one spot, such as shots that start from
 * the same camera, so each stays visible and tappable: a tight stack of rows (up to
 * four across) rising from the spot. The dots underneath keep marking the true
 * position.
 */
export function fanOut(
  markers: readonly { id: string; x: number; y: number }[],
): Map<string, { x: number; y: number }> {
  const offsets = new Map<string, { x: number; y: number }>();
  const clusters: { x: number; y: number; ids: string[] }[] = [];
  for (const marker of markers) {
    const cluster = clusters.find(
      (item) => Math.hypot(item.x - marker.x, item.y - marker.y) < FAN_RADIUS_PX,
    );
    if (cluster) cluster.ids.push(marker.id);
    else clusters.push({ x: marker.x, y: marker.y, ids: [marker.id] });
  }
  for (const { ids } of clusters) {
    ids.forEach((id, index) => {
      const row = Math.floor(index / FAN_ROW);
      const inRow = Math.min(FAN_ROW, ids.length - row * FAN_ROW);
      const column = index % FAN_ROW;
      offsets.set(id, {
        x: (column - (inRow - 1) / 2) * FAN_STEP_PX,
        y: row === 0 ? 0 : -row * FAN_STEP_PX,
      });
    });
  }
  separate(markers, offsets);
  return offsets;
}

/** Nudges pin heads from different spots apart until none overlap (a few passes). */
function separate(
  markers: readonly { id: string; x: number; y: number }[],
  offsets: Map<string, { x: number; y: number }>,
): void {
  const heads = markers.map((marker) => {
    const offset = offsets.get(marker.id)!;
    return { id: marker.id, x: marker.x + offset.x, y: marker.y + offset.y };
  });
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (let i = 0; i < heads.length; i += 1) {
      for (let j = i + 1; j < heads.length; j += 1) {
        const a = heads[i]!;
        const b = heads[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= FAN_STEP_PX) continue;
        const push = (FAN_STEP_PX - distance) / 2;
        // Coincident heads split sideways.
        const [ux, uy] = distance > 1e-3 ? [dx / distance, dy / distance] : [1, 0];
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  heads.forEach((head, index) => {
    const marker = markers[index]!;
    offsets.set(head.id, { x: head.x - marker.x, y: head.y - marker.y });
  });
}

/**
 * Numbered camera pins over the isometric overview on the Shots tab. The engine draws
 * each shot's frustum in the scene; these pins track those cameras every frame and are
 * the tap targets that open a shot (the camera then flies down into it).
 */
export function ShotsOverview({
  engineRef,
  phase,
  shots,
  activeShotId,
  highlightId,
  disabled,
  onOpen,
}: ShotsOverviewProps) {
  const layerRef = useRef<HTMLOListElement>(null);
  const pinsRef = useRef(new Map<string, HTMLLIElement>());

  // Follow the markers as the overview rotates, zooms, and flies.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const engine = engineRef.current;
      const layer = layerRef.current;
      if (engine && layer && typeof engine.projectShotMarkers === "function") {
        const rect = layer.getBoundingClientRect();
        const seen = new Set<string>();
        const markers = engine.projectShotMarkers();
        // Nearer cameras stack above farther ones.
        const byDepth = [...markers].sort((a, b) => b.depth - a.depth);
        const fans = fanOut(markers);
        for (const marker of markers) {
          const pin = pinsRef.current.get(marker.id);
          if (!pin) continue;
          seen.add(marker.id);
          pin.style.transform = `translate3d(${marker.x - rect.left}px, ${marker.y - rect.top}px, 0)`;
          pin.style.zIndex = String(byDepth.indexOf(marker) + 1);
          const fan = fans.get(marker.id) ?? { x: 0, y: 0 };
          const x = marker.x - rect.left;
          const clamped = Math.min(Math.max(x + fan.x, EDGE_PX), rect.width - EDGE_PX);
          pin.style.setProperty("--fan-x", `${clamped - x}px`);
          pin.style.setProperty("--fan-y", `${fan.y}px`);
          pin.dataset.offscreen = "false";
        }
        for (const [id, pin] of pinsRef.current) if (!seen.has(id)) pin.dataset.offscreen = "true";
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engineRef]);

  return (
    <div className="shots-overview" data-phase={phase}>
      <p className="shots-overview__hint" role="status">
        Drag to orbit · tap a camera to open it
      </p>
      <ol className="shots-overview__pins" ref={layerRef} aria-label="Shots in the scene">
        {shots.map((shot, index) => (
          <li
            key={shot.id}
            ref={(element) => {
              if (element) pinsRef.current.set(shot.id, element);
              else pinsRef.current.delete(shot.id);
            }}
            className="overview-pin"
            data-offscreen="true"
            data-active={shot.id === activeShotId}
            data-highlight={shot.id === highlightId}
            style={{ "--i": index } as CSSProperties}
          >
            <button
              className="overview-pin__button"
              aria-label={`Open ${shot.name} from the map`}
              disabled={disabled}
              onClick={() => onOpen(shot)}
            >
              <span className="overview-pin__head">
                {index + 1}
                {shot.keyframes.length > 1 && (
                  <i className="overview-pin__moving" aria-hidden="true">
                    <Move3d size={9} />
                  </i>
                )}
              </span>
              <span className="overview-pin__label">{shot.name}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
