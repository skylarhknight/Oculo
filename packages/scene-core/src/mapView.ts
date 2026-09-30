import {
  Euler,
  MathUtils,
  Matrix4,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Ray,
  Vector2,
  Vector3,
} from "three";
import { Mannequin } from "./mannequin.js";
import { Tween, decay, easeDive, easeInOutCubic, Spring } from "./motion.js";
import type { QuaternionTuple, Vector3Tuple } from "./types.js";

/** Elevation of a true isometric view: arctan(1/√2) ≈ 35.26°. */
export const ISOMETRIC_ELEVATION = Math.atan(1 / Math.SQRT2);
/** A long lens flattens perspective so the view reads as isometric. */
export const MAP_FOV_DEGREES = 22;
export const MAP_ENTER_MS = 1100;
export const MAP_EXIT_MS = 800;
export const MAP_DIVE_MS = 1250;
const MIN_ELEVATION = MathUtils.degToRad(20);
const MAX_ELEVATION = MathUtils.degToRad(70);
const ZOOM_RANGE = [0.5, 1.6] as const;
const INERTIA_HALF_LIFE_MS = 180;
/** Idle time before a preview turntable spins again after the user lets go. */
const AUTO_ROTATE_RESUME_MS = 3000;

export type MapViewPhase =
  "off" | "entering" | "map" | "dragging" | "placed" | "diving" | "exiting";

export interface MapBounds {
  readonly center: Vector3Tuple;
  readonly radius: number;
}

export interface OrbitState {
  readonly target: Vector3Tuple;
  readonly azimuth: number;
  readonly elevation: number;
  readonly distance: number;
}

export interface ViewPose {
  readonly position: Vector3Tuple;
  readonly quaternion: QuaternionTuple;
  readonly fov: number;
}

/** Distance at which a sphere of `radius` fits the narrower field of view. */
export function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = MathUtils.degToRad(fovDegrees) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 1e-3));
  return (Math.max(radius, 1e-3) / Math.sin(Math.min(vertical, horizontal))) * 1.02;
}

/**
 * The smallest growth of a bounding sphere that also encloses `points` (one pass of
 * Ritter's method), so an overview frames the scene and every saved camera.
 */
export function encloseBounds(bounds: MapBounds, points: readonly Vector3Tuple[]): MapBounds {
  const center = new Vector3(...bounds.center);
  let radius = bounds.radius;
  for (const point of points) {
    const offset = new Vector3(...point).sub(center);
    const distance = offset.length();
    if (!Number.isFinite(distance) || distance <= radius) continue;
    const grown = (radius + distance) / 2;
    center.add(offset.multiplyScalar((grown - radius) / distance));
    radius = grown;
  }
  return { center: [center.x, center.y, center.z], radius };
}

/** Camera yaw (rotation about +Y, YXZ order) of an orientation. */
export function yawOf(quaternion: QuaternionTuple): number {
  return new Euler().setFromQuaternion(new Quaternion(...quaternion), "YXZ").y;
}

/** The orbiting map camera: looking at the target from azimuth/elevation. */
export function orbitPose(state: OrbitState, fov = MAP_FOV_DEGREES): ViewPose {
  const { azimuth, elevation, distance } = state;
  const [x, y, z] = state.target;
  const position: Vector3Tuple = [
    x + distance * Math.sin(azimuth) * Math.cos(elevation),
    y + distance * Math.sin(elevation),
    z + distance * Math.cos(azimuth) * Math.cos(elevation),
  ];
  const q = new Quaternion().setFromEuler(new Euler(-elevation, azimuth, 0, "YXZ"));
  return { position, quaternion: [q.x, q.y, q.z, q.w], fov };
}

/** Eye-level pose standing on a ground point: level horizon, looking along `heading`. */
export function groundEyePose(
  ground: Vector3Tuple,
  heading: number,
  eyeHeight: number,
): { position: Vector3Tuple; quaternion: QuaternionTuple } {
  const q = new Quaternion().setFromEuler(new Euler(0, heading, 0, "YXZ"));
  return {
    position: [ground[0], ground[1] + eyeHeight, ground[2]],
    quaternion: [q.x, q.y, q.z, q.w],
  };
}

/**
 * Interpolates between two views along a quadratic Bézier whose control point is
 * lifted by `lift`, so moves arc through the air instead of cutting through the scene.
 */
export function tweenPose(from: ViewPose, to: ViewPose, t: number, lift = 0): ViewPose {
  const a = new Vector3(...from.position);
  const b = new Vector3(...to.position);
  const control = a
    .clone()
    .add(b)
    .multiplyScalar(0.5)
    .add(new Vector3(0, lift, 0));
  const u = 1 - t;
  const position = a
    .multiplyScalar(u * u)
    .add(control.multiplyScalar(2 * u * t))
    .add(b.multiplyScalar(t * t));
  const q = new Quaternion(...from.quaternion).slerp(new Quaternion(...to.quaternion), t);
  return {
    position: t >= 1 ? to.position : t <= 0 ? from.position : [position.x, position.y, position.z],
    quaternion: t >= 1 ? to.quaternion : [q.x, q.y, q.z, q.w],
    fov: from.fov + (to.fov - from.fov) * t,
  };
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** A point `distance` ahead of a view, where it is looking. */
export function focusOf(
  pose: Pick<ViewPose, "position" | "quaternion">,
  distance: number,
): Vector3Tuple {
  const ahead = new Vector3(0, 0, -distance)
    .applyQuaternion(new Quaternion(...pose.quaternion))
    .add(new Vector3(...pose.position));
  return [ahead.x, ahead.y, ahead.z];
}

/**
 * A crane move between two views that keeps its subject in frame: the camera arcs
 * along the lifted Bézier while aiming at a point that glides from what the first view
 * looks at to what the second one does. Near each end the aim blends into the exact
 * start and end orientations, so dutch angles and pitch are met precisely.
 */
export function craneTween(
  from: ViewPose,
  to: ViewPose,
  t: number,
  lift: number,
  fromFocus: Vector3Tuple,
  toFocus: Vector3Tuple,
): ViewPose {
  const pose = tweenPose(from, to, t, lift);
  if (t <= 0 || t >= 1) return pose;
  const focus = new Vector3(...fromFocus).lerp(new Vector3(...toFocus), t);
  const eye = new Vector3(...pose.position);
  const look = new Quaternion().setFromRotationMatrix(
    new Matrix4().lookAt(eye, focus, new Vector3(0, 1, 0)),
  );
  const q = new Quaternion(...from.quaternion)
    .slerp(look, smoothstep(0, 0.22, t))
    .slerp(new Quaternion(...to.quaternion), smoothstep(0.78, 1, t));
  return { ...pose, quaternion: [q.x, q.y, q.z, q.w] };
}

/** Heading that makes a camera at `from` look horizontally toward `to`. */
export function headingToward(from: Vector3Tuple, to: Vector3Tuple): number {
  return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
}

export interface MapViewHost {
  readonly element: HTMLElement;
  /** Scene surface hit along a ray, in world space. */
  raycast(ray: Ray): Vector3 | undefined;
}

export interface MapEnterOptions {
  readonly rig: ViewPose;
  readonly bounds: MapBounds;
  readonly eyeHeight: number;
  readonly reduceMotion: boolean;
  /** Where the camera currently stands, when known. */
  readonly origin?: Vector3Tuple;
  /** Show the cinematographer (default). Without it the map is a rotatable overview. */
  readonly figure?: boolean;
}

export interface MapViewEvent {
  readonly phase: MapViewPhase;
  readonly azimuth: number;
}

/**
 * The isometric "map" session. It renders through its own camera so the composed rig
 * camera is untouched until the user teleports. One finger rotates (with inertia), a
 * pinch zooms, and the cinematographer can be grabbed, dropped and aimed.
 */
export class MapView {
  readonly camera = new PerspectiveCamera(MAP_FOV_DEGREES, 1, 0.01, 5000);
  readonly mannequin = new Mannequin();
  private phaseValue: MapViewPhase = "off";
  private readonly listeners = new Set<(event: MapViewEvent) => void>();
  private target = new Vector3();
  private azimuth = 0;
  private readonly azimuthSpring = new Spring(0, 120, 22);
  private snapping = false;
  private elevation = ISOMETRIC_ELEVATION;
  private fit = 10;
  private zoom = 1;
  private readonly zoomSpring = new Spring(1, 160, 26);
  private velocity = 0;
  private tween: Tween | undefined;
  private eyeHeight = 1;
  private reduceMotion = false;
  private rigFov = 50;
  private readonly pointers = new Map<number, { x: number; y: number; t: number }>();
  private gesture: "rotate" | "carry" | "aim" | "pinch" | undefined;
  private pinch: number | undefined;
  private lastEmittedAzimuth = Number.NaN;
  private placedByDrag = false;
  private figure = true;
  private autoRotate = 0;
  private idleMs = Number.POSITIVE_INFINITY;

  constructor(private readonly host: MapViewHost) {
    this.mannequin.group.renderOrder = 4;
  }

  get phase(): MapViewPhase {
    return this.phaseValue;
  }

  get active(): boolean {
    return this.phaseValue !== "off";
  }

  /** Whether this session shows the cinematographer (false for the shots overview). */
  get hasFigure(): boolean {
    return this.figure;
  }

  get currentAzimuth(): number {
    return this.azimuth;
  }

  onChange(listener: (event: MapViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Flies from the rig up to the isometric view; resolves when it arrives. */
  enter(options: MapEnterOptions): Promise<void> {
    this.eyeHeight = options.eyeHeight;
    this.reduceMotion = options.reduceMotion;
    this.rigFov = options.rig.fov;
    this.mannequin.eyeHeight = options.eyeHeight;
    this.mannequin.reduceMotion = options.reduceMotion;
    this.target = new Vector3(...options.bounds.center);
    this.azimuth = yawOf(options.rig.quaternion) + Math.PI / 4;
    this.azimuthSpring.snap(this.azimuth);
    this.elevation = ISOMETRIC_ELEVATION;
    this.fit = fitDistance(options.bounds.radius, MAP_FOV_DEGREES, this.aspect());
    this.zoom = 1;
    this.zoomSpring.snap(1);
    this.velocity = 0;
    this.autoRotate = 0;
    this.idleMs = Number.POSITIVE_INFINITY;
    const origin = options.origin ?? [
      options.rig.position[0],
      options.rig.position[1] - options.eyeHeight,
      options.rig.position[2],
    ];
    this.figure = options.figure ?? true;
    if (this.figure) {
      this.mannequin.placeAt(new Vector3(...origin), yawOf(options.rig.quaternion));
      this.mannequin.markOrigin(new Vector3(...origin));
    } else {
      this.mannequin.hide();
    }
    this.attach();
    this.setPhase("entering");
    const from = options.rig;
    const subject = this.target.toArray() as Vector3Tuple;
    const fromFocus = focusOf(from, new Vector3(...from.position).distanceTo(this.target));
    this.tween = new Tween(options.reduceMotion ? 0 : MAP_ENTER_MS, (t) => {
      const eased = easeInOutCubic(t);
      this.applyPose(craneTween(from, this.orbit(), eased, this.fit * 0.2, fromFocus, subject));
    });
    const tween = this.tween;
    return tween.done.then(() => {
      // A later transition (closing while still rising) owns the camera now.
      if (this.tween !== tween) return;
      this.tween = undefined;
      if (this.phaseValue === "entering") this.setPhase("map");
    });
  }

  /** Flies back to the rig without teleporting. */
  exit(rig: ViewPose): Promise<void> {
    this.setPhase("exiting");
    this.mannequin.showAim(false);
    const from = this.currentPose();
    const subject = this.target.toArray() as Vector3Tuple;
    const toFocus = focusOf(rig, new Vector3(...rig.position).distanceTo(this.target));
    this.tween = new Tween(this.reduceMotion ? 0 : MAP_EXIT_MS, (t) => {
      const eased = easeInOutCubic(t);
      this.applyPose(craneTween(from, rig, eased, this.fit * 0.15, subject, toFocus));
      this.mannequin.setDiveProgress(t);
    });
    const tween = this.tween;
    return tween.done.then(() => {
      if (this.tween === tween) this.finish();
    });
  }

  /** Dives into the figure's eyes; resolves with the eye-level pose to adopt. */
  dive(): Promise<{ position: Vector3Tuple; quaternion: QuaternionTuple }> {
    this.setPhase("diving");
    this.mannequin.showAim(false);
    const ground = this.mannequin.position;
    const eye = groundEyePose(
      [ground.x, ground.y, ground.z],
      this.mannequin.currentHeading,
      this.eyeHeight,
    );
    const from = this.currentPose();
    const to: ViewPose = { ...eye, fov: this.rigFov };
    // Aim at the figure on the way down, then look out along its heading.
    const head: Vector3Tuple = [ground.x, ground.y + this.eyeHeight, ground.z];
    const outward = focusOf(to, Math.max(this.eyeHeight * 6, this.fit * 0.15));
    this.tween = new Tween(this.reduceMotion ? 0 : MAP_DIVE_MS, (t) => {
      const eased = easeDive(t);
      const aim = new Vector3(...head).lerp(new Vector3(...outward), smoothstep(0.55, 1, eased));
      this.applyPose(
        craneTween(from, to, eased, this.eyeHeight * 2.5, head, aim.toArray() as Vector3Tuple),
      );
      this.mannequin.setDiveProgress(eased);
    });
    const tween = this.tween;
    return tween.done.then(() => {
      if (this.tween === tween) this.finish();
      return eye;
    });
  }

  /**
   * A slow turntable spin (radians per second; 0 stops it) for previews. It pauses while
   * the user rotates, zooms or flicks, and eases back in after a few idle seconds.
   */
  setAutoRotate(radiansPerSecond: number): void {
    this.autoRotate = Number.isFinite(radiansPerSecond) ? radiansPerSecond : 0;
  }

  /** Rotates by whole steps (buttons); `step` is signed radians. */
  rotateBy(step: number): void {
    if (!this.interactive) return;
    this.idleMs = 0;
    this.velocity = 0;
    this.snapping = true;
    this.azimuthSpring.value = this.azimuth;
    this.azimuthSpring.target = this.azimuth + step;
    if (this.reduceMotion) this.azimuthSpring.snap(this.azimuthSpring.target);
  }

  /** Springs to the nearest multiple of `step` (compass double-tap). */
  snapTo(step = Math.PI / 4): void {
    if (!this.interactive) return;
    this.rotateBy(Math.round(this.azimuth / step) * step - this.azimuth);
  }

  zoomBy(factor: number): void {
    if (!this.interactive || !Number.isFinite(factor) || factor <= 0) return;
    this.idleMs = 0;
    this.zoomSpring.target = MathUtils.clamp(this.zoomSpring.target * factor, ...ZOOM_RANGE);
  }

  /** Ground point under a viewport position, or undefined over sky or empty space. */
  groundAt(clientX: number, clientY: number): Vector3 | undefined {
    const ray = this.rayAt(clientX, clientY);
    return ray ? this.host.raycast(ray) : undefined;
  }

  /** Lifts the figure for a drag that started outside the scene (the tray). */
  startCarry(): void {
    if (!this.interactive || !this.figure) return;
    this.mannequin.pickUp();
    this.mannequin.showAim(false);
    this.setPhase("dragging");
  }

  /** Moves a carried figure; returns whether the finger is over valid ground. */
  carryTo(clientX: number, clientY: number): boolean {
    if (this.phaseValue !== "dragging") return false;
    const ground = this.groundAt(clientX, clientY);
    this.mannequin.carryTo(ground);
    return ground !== undefined;
  }

  /** Releases a carried figure; returns whether it landed. */
  drop(clientX?: number, clientY?: number): boolean {
    if (this.phaseValue !== "dragging") return false;
    const ground =
      clientX === undefined || clientY === undefined ? undefined : this.groundAt(clientX, clientY);
    if (ground) this.mannequin.carryTo(ground);
    const placed = ground !== undefined || (clientX === undefined && this.placedByDrag);
    this.mannequin.drop(placed);
    this.setPhase(placed ? "placed" : "map");
    if (placed) {
      // Face into the scene: toward its centre, or along the map view near the middle.
      const ground = this.mannequin.position;
      const flat = new Vector3(this.target.x - ground.x, 0, this.target.z - ground.z);
      const heading =
        flat.length() > this.eyeHeight * 2
          ? headingToward([ground.x, ground.y, ground.z], [this.target.x, ground.y, this.target.z])
          : this.azimuth;
      this.mannequin.setHeading(heading, false);
      this.mannequin.showAim(true);
    }
    return placed;
  }

  /** Places the figure at a viewport point without dragging (accessibility path). */
  placeAt(clientX: number, clientY: number): boolean {
    if (!this.interactive || !this.figure) return false;
    const ground = this.groundAt(clientX, clientY);
    if (!ground) return false;
    this.mannequin.pickUp();
    this.mannequin.carryTo(ground);
    this.setPhase("dragging");
    this.placedByDrag = true;
    const placed = this.drop();
    this.placedByDrag = false;
    return placed;
  }

  /** Viewport position of the figure's feet, for keyboard nudging. */
  figureScreenPosition(): { x: number; y: number } | undefined {
    const rect = this.host.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const point = this.mannequin.displayedGround.project(this.camera);
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  }

  /** Aims the figure at a viewport point projected onto its ground plane. */
  aimAt(clientX: number, clientY: number): void {
    const ray = this.rayAt(clientX, clientY);
    if (!ray) return;
    const ground = this.mannequin.position;
    const point = ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -ground.y), new Vector3());
    if (!point || point.distanceTo(ground) < this.eyeHeight * 0.05) return;
    this.mannequin.setHeading(
      headingToward([ground.x, ground.y, ground.z], [point.x, point.y, point.z]),
    );
  }

  turn(delta: number): void {
    this.mannequin.setHeading(this.mannequin.currentHeading + delta);
  }

  setHeading(heading: number): void {
    this.mannequin.setHeading(heading);
  }

  get heading(): number {
    return this.mannequin.currentHeading;
  }

  update(dtMs: number): void {
    if (!this.active) return;
    this.camera.aspect = this.aspect();
    if (this.tween) {
      this.tween.update(dtMs);
    } else {
      if (this.snapping) {
        this.azimuth = this.azimuthSpring.update(dtMs);
        if (this.azimuthSpring.settled) this.snapping = false;
      } else if (this.gesture !== "rotate" && this.velocity !== 0) {
        this.azimuth += this.velocity * (dtMs / 1000);
        this.velocity = decay(this.velocity, dtMs, INERTIA_HALF_LIFE_MS);
        if (Math.abs(this.velocity) < 0.01) this.velocity = 0;
      } else if (this.autoRotate !== 0 && this.gesture === undefined) {
        this.idleMs += dtMs;
        // Ease the spin back in rather than jumping to full speed.
        const ramp = smoothstep(AUTO_ROTATE_RESUME_MS, AUTO_ROTATE_RESUME_MS + 900, this.idleMs);
        this.azimuth += this.autoRotate * ramp * (dtMs / 1000);
      }
      this.zoom = this.zoomSpring.update(dtMs);
      this.applyPose(this.orbit());
    }
    this.mannequin.update(dtMs);
    if (Math.abs(this.azimuth - this.lastEmittedAzimuth) > 1e-3) this.emit();
  }

  dispose(): void {
    this.detach();
    this.mannequin.dispose();
    this.listeners.clear();
  }

  private get interactive(): boolean {
    return (
      this.phaseValue === "map" || this.phaseValue === "placed" || this.phaseValue === "dragging"
    );
  }

  private finish(): void {
    this.tween = undefined;
    this.detach();
    this.mannequin.hide();
    this.setPhase("off");
  }

  private orbit(): ViewPose {
    return orbitPose({
      target: [this.target.x, this.target.y, this.target.z],
      azimuth: this.azimuth,
      elevation: this.elevation,
      distance: this.fit * this.zoom,
    });
  }

  private currentPose(): ViewPose {
    const { position, quaternion } = this.camera;
    return {
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      fov: this.camera.fov,
    };
  }

  private applyPose(pose: ViewPose): void {
    this.camera.position.fromArray(pose.position as Vector3Tuple);
    this.camera.quaternion.fromArray(pose.quaternion as QuaternionTuple);
    this.camera.fov = pose.fov;
    // A generous far plane keeps the whole scene visible from orbit distance.
    this.camera.far = Math.max(1000, this.fit * 4);
    this.camera.near = Math.max(0.01, this.eyeHeight * 0.02);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private aspect(): number {
    const { clientWidth, clientHeight } = this.host.element;
    return clientWidth > 0 && clientHeight > 0 ? clientWidth / clientHeight : 1;
  }

  private rayAt(clientX: number, clientY: number): Ray | undefined {
    const rect = this.host.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.camera.updateMatrixWorld(true);
    const origin = new Vector3().setFromMatrixPosition(this.camera.matrixWorld);
    const direction = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    return new Ray(origin, direction);
  }

  /** Is a viewport point on the figure (generous, thumb-sized)? */
  private hitsFigure(clientX: number, clientY: number): boolean {
    if (!this.figure) return false;
    const feet = this.figureScreenPosition();
    if (!feet) return false;
    const head = this.mannequin.displayedGround
      .add(new Vector3(0, this.mannequin.displayHeight, 0))
      .project(this.camera);
    const rect = this.host.element.getBoundingClientRect();
    const headY = rect.top + ((1 - head.y) / 2) * rect.height;
    const height = Math.max(24, Math.abs(feet.y - headY));
    const centerY = (feet.y + headY) / 2;
    return (
      Math.abs(clientX - feet.x) < Math.max(28, height * 0.45) &&
      Math.abs(clientY - centerY) < height * 0.7 + 16
    );
  }

  private setPhase(phase: MapViewPhase): void {
    if (phase === this.phaseValue) return;
    this.phaseValue = phase;
    this.emit();
  }

  private emit(): void {
    this.lastEmittedAzimuth = this.azimuth;
    const event = { phase: this.phaseValue, azimuth: this.azimuth };
    for (const listener of this.listeners) listener(event);
  }

  private attached = false;

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    const element = this.host.element;
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    element.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const element = this.host.element;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerCancel);
    element.removeEventListener("wheel", this.onWheel);
    this.pointers.clear();
    this.gesture = undefined;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.interactive) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: event.timeStamp });
    this.host.element.setPointerCapture?.(event.pointerId);
    if (this.pointers.size === 2) {
      if (this.gesture === "carry") return;
      this.gesture = "pinch";
      this.pinch = this.spread();
      return;
    }
    this.velocity = 0;
    this.snapping = false;
    this.idleMs = 0;
    if (this.hitsFigure(event.clientX, event.clientY)) {
      this.gesture = "carry";
      this.startCarry();
    } else if (this.phaseValue === "placed") {
      this.gesture = "aim";
      this.aimAt(event.clientX, event.clientY);
    } else {
      this.gesture = "rotate";
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const current = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    this.pointers.set(event.pointerId, current);
    if (this.gesture === "carry") {
      this.carryTo(event.clientX, event.clientY);
    } else if (this.gesture === "aim") {
      this.aimAt(event.clientX, event.clientY);
    } else if (this.gesture === "pinch" && this.pinch !== undefined) {
      const spread = this.spread();
      if (spread > 0 && this.pinch > 0) this.zoomBy(this.pinch / spread);
      this.pinch = spread;
    } else if (this.gesture === "rotate") {
      const width = this.host.element.clientWidth || 1;
      const height = this.host.element.clientHeight || 1;
      const deltaAzimuth = -((current.x - previous.x) / width) * Math.PI;
      this.azimuth += deltaAzimuth;
      this.elevation = MathUtils.clamp(
        this.elevation + ((current.y - previous.y) / height) * (Math.PI / 2),
        MIN_ELEVATION,
        MAX_ELEVATION,
      );
      const dt = Math.max(1, current.t - previous.t);
      // Keep a smoothed flick velocity for inertia on release.
      this.velocity = this.velocity * 0.6 + (deltaAzimuth / (dt / 1000)) * 0.4;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const last = this.pointers.get(event.pointerId)!;
    this.pointers.delete(event.pointerId);
    if (this.gesture === "carry" && this.pointers.size === 0) {
      this.drop(event.clientX, event.clientY);
    }
    if (this.gesture === "rotate" && event.timeStamp - last.t > 80) this.velocity = 0;
    if (this.pointers.size === 0) this.gesture = undefined;
    else if (this.gesture === "pinch") this.gesture = undefined;
    this.pinch = undefined;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.gesture === "carry") this.drop();
    this.gesture = undefined;
    this.pinch = undefined;
    this.velocity = 0;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.interactive) return;
    event.preventDefault();
    this.zoomBy(Math.exp(event.deltaY * 0.0015));
  };

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
