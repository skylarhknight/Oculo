import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Quaternion,
  Vector3,
  type PerspectiveCamera,
} from "three";
import type { QuaternionTuple, Vector3Tuple } from "./types.js";

/** A saved camera drawn as a small frustum in the scene. */
export interface ShotMarker {
  readonly id: string;
  readonly position: Vector3Tuple;
  readonly quaternion: QuaternionTuple;
  readonly verticalFovDegrees: number;
  readonly aspectRatio: number;
}

export interface PlanOverlayStyle {
  /** CSS-compatible colors, resolved by the app from its design tokens. */
  readonly markerColor: string;
  readonly selectedColor: string;
  readonly pathColor: string;
  /** Frustum depth in scene units. */
  readonly markerDepth?: number;
}

export interface PlanOverlayState {
  readonly markers: readonly ShotMarker[];
  readonly selectedId?: string;
  /** Sampled camera move positions, in order. */
  readonly path: readonly Vector3Tuple[];
  readonly style: PlanOverlayStyle;
}

const DEFAULT_DEPTH = 0.35;

/** Apex plus the far rectangle of a camera frustum, as line segments. */
export function frustumSegments(marker: ShotMarker, depth: number): number[] {
  const halfHeight = Math.tan(MathUtils.degToRad(marker.verticalFovDegrees) / 2) * depth;
  const halfWidth = halfHeight * marker.aspectRatio;
  const rotation = new Quaternion(...marker.quaternion);
  const apex = new Vector3(...marker.position);
  const corner = (x: number, y: number) =>
    new Vector3(x, y, -depth).applyQuaternion(rotation).add(apex);
  const corners = [
    corner(-halfWidth, halfHeight),
    corner(halfWidth, halfHeight),
    corner(halfWidth, -halfHeight),
    corner(-halfWidth, -halfHeight),
  ];
  const up = new Vector3(0, halfHeight * 1.5, -depth).applyQuaternion(rotation).add(apex);
  const points: Vector3[] = [];
  corners.forEach((point, index) => {
    points.push(apex, point, point, corners[(index + 1) % corners.length]!);
  });
  // A small "up" tick distinguishes a rolled camera from its mirror image.
  points.push(corners[0]!.clone().lerp(corners[1]!, 0.5), up);
  return points.flatMap((point) => [point.x, point.y, point.z]);
}

/**
 * Shot markers and the camera move, rendered with the scene for orientation only.
 * The engine hides this group during every capture, so exports never include it.
 */
export class PlanOverlay {
  readonly group = new Group();
  private state: PlanOverlayState | undefined;
  private depthOverride: number | undefined;

  constructor() {
    this.group.name = "oculo-plan-overlay";
    this.group.renderOrder = 10;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  update(state: PlanOverlayState | undefined): void {
    this.clear();
    this.state = state;
    if (!state) return;
    const depth = this.depthOverride ?? state.style.markerDepth ?? DEFAULT_DEPTH;
    for (const marker of state.markers) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new Float32BufferAttribute(frustumSegments(marker, depth), 3),
      );
      const selected = marker.id === state.selectedId;
      const lines = new LineSegments(
        geometry,
        new LineBasicMaterial({
          color: selected ? state.style.selectedColor : state.style.markerColor,
          depthTest: false,
          transparent: true,
          opacity: selected ? 1 : 0.8,
        }),
      );
      lines.name = `shot:${marker.id}`;
      lines.renderOrder = 11;
      this.group.add(lines);
    }
    if (state.path.length >= 2) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new Float32BufferAttribute(
          state.path.flatMap((point) => [...point]),
          3,
        ),
      );
      const line = new Line(
        geometry,
        new LineBasicMaterial({
          color: state.style.pathColor,
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        }),
      );
      line.name = "move-path";
      line.renderOrder = 11;
      this.group.add(line);
    }
  }

  /** Where each shot camera stands. */
  get markerPositions(): Vector3Tuple[] {
    return this.state?.markers.map((marker) => [...marker.position] as Vector3Tuple) ?? [];
  }

  /**
   * Draws markers at a different depth than the style asks for (larger frustums in the
   * zoomed-out overview); undefined returns to the style's depth.
   */
  setMarkerDepth(depth: number | undefined): void {
    if (depth === this.depthOverride) return;
    this.depthOverride = depth;
    if (this.state) this.update(this.state);
  }

  /** Each marker's position in canvas pixels, or undefined when it is off screen. */
  project(
    camera: PerspectiveCamera,
    canvasWidth: number,
    canvasHeight: number,
  ): { id: string; x: number; y: number; depth: number }[] {
    if (!this.state) return [];
    camera.updateMatrixWorld();
    return this.state.markers.flatMap((marker) => {
      const projected = new Vector3(...marker.position).project(camera);
      if (projected.z < -1 || projected.z > 1) return [];
      return [
        {
          id: marker.id,
          x: ((projected.x + 1) / 2) * canvasWidth,
          y: ((1 - projected.y) / 2) * canvasHeight,
          depth: projected.z,
        },
      ];
    });
  }

  /**
   * Nearest marker to a point in canvas pixels, within `radius` pixels.
   * Screen-space picking keeps small, distant frustums easy to tap.
   */
  pick(
    camera: PerspectiveCamera,
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
    radius = 28,
  ): string | undefined {
    if (!this.state || !this.group.visible) return undefined;
    camera.updateMatrixWorld();
    let best: { id: string; distance: number } | undefined;
    for (const marker of this.state.markers) {
      const projected = new Vector3(...marker.position).project(camera);
      // Behind the camera or outside the clip volume.
      if (projected.z < -1 || projected.z > 1) continue;
      const screenX = ((projected.x + 1) / 2) * canvasWidth;
      const screenY = ((1 - projected.y) / 2) * canvasHeight;
      const distance = Math.hypot(screenX - x, screenY - y);
      if (distance <= radius && (!best || distance < best.distance))
        best = { id: marker.id, distance };
    }
    return best?.id;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const object = child as LineSegments | Line;
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
  }

  dispose(): void {
    this.clear();
    this.state = undefined;
  }
}
