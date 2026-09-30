import { Euler, MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Camera movement a user is currently asking for; every axis runs from -1 to 1. */
export interface NavigationInput {
  /** Strafe right (+) and left (-). */
  readonly moveX: number;
  /** Walk forward (+) and back (-), level with the ground. */
  readonly moveZ: number;
  /** Crane up (+) and down (-). */
  readonly vertical: number;
  /** Pan right (+) and left (-). */
  readonly yawRate: number;
  /** Tilt up (+) and down (-). */
  readonly pitchRate: number;
}

const IDLE: NavigationInput = { moveX: 0, moveZ: 0, vertical: 0, yawRate: 0, pitchRate: 0 };
const MAX_PITCH = MathUtils.degToRad(85);
const LOOK_RATE_RADIANS = MathUtils.degToRad(60);
const DEFAULT_SPEED = 1.5;
/** Longest frame integrated at once, so a stalled tab doesn't jump the camera. */
const MAX_STEP_MS = 100;

const clampAxis = (value: number) =>
  Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
/** Softens small deflections so a thumb can make precise adjustments. */
const response = (value: number) => value * Math.abs(value);

const KEY_BINDINGS: Record<string, readonly [keyof NavigationInput, number]> = {
  KeyW: ["moveZ", 1],
  ArrowUp: ["moveZ", 1],
  KeyS: ["moveZ", -1],
  ArrowDown: ["moveZ", -1],
  KeyA: ["moveX", -1],
  ArrowLeft: ["moveX", -1],
  KeyD: ["moveX", 1],
  ArrowRight: ["moveX", 1],
  KeyE: ["vertical", 1],
  KeyQ: ["vertical", -1],
  KeyJ: ["yawRate", -1],
  KeyL: ["yawRate", 1],
  KeyI: ["pitchRate", 1],
  KeyK: ["pitchRate", -1],
};

/**
 * First-person navigation: walk, strafe, crane, pan and tilt. The camera's dutch angle
 * is kept while looking around. Inputs come from on-screen sticks, a one-finger drag
 * (look), a two-finger pinch (dolly along the view) and the keyboard when the canvas
 * has focus.
 */
export class FlyController {
  /** Scene units per second at full deflection and speed multiplier 1. */
  baseSpeed = DEFAULT_SPEED;
  speedMultiplier = 1;
  private enabledState = true;
  private stickInput: NavigationInput = IDLE;
  private readonly heldKeys = new Set<string>();
  private fast = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance: number | undefined;
  private pendingDolly = 0;
  private readonly euler = new Euler(0, 0, 0, "YXZ");

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
  ) {
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerUp);
    element.addEventListener("keydown", this.onKeyDown);
    element.addEventListener("keyup", this.onKeyUp);
    element.addEventListener("blur", this.onBlur);
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  /** Disabling also lets go of every held input, so re-enabling never lurches. */
  set enabled(value: boolean) {
    this.enabledState = value;
    if (!value) this.release();
  }

  /** Current requested movement from sticks and held keys. */
  get input(): NavigationInput {
    const keys = { ...IDLE } as { -readonly [K in keyof NavigationInput]: number };
    for (const code of this.heldKeys) {
      const binding = KEY_BINDINGS[code];
      if (binding) keys[binding[0]] += binding[1];
    }
    const merged = {} as { -readonly [K in keyof NavigationInput]: number };
    for (const axis of Object.keys(IDLE) as (keyof NavigationInput)[])
      merged[axis] = clampAxis(this.stickInput[axis] + keys[axis]);
    return merged;
  }

  get isActive(): boolean {
    const input = this.input;
    return (
      this.pendingDolly !== 0 ||
      (Object.keys(input) as (keyof NavigationInput)[]).some((axis) => input[axis] !== 0)
    );
  }

  /** Replaces the on-screen stick input. Missing axes keep their current value. */
  setInput(input: Partial<NavigationInput>): void {
    if (!this.enabledState) return;
    const next = { ...this.stickInput };
    for (const axis of Object.keys(input) as (keyof NavigationInput)[])
      next[axis] = clampAxis(input[axis] ?? 0);
    this.stickInput = next;
  }

  /** Stops all movement and forgets held keys and touches. */
  release(): void {
    this.stickInput = IDLE;
    this.heldKeys.clear();
    this.pointers.clear();
    this.pinchDistance = undefined;
    this.pendingDolly = 0;
    this.fast = false;
  }

  /** Turns the camera directly, as a drag across the view does. */
  look(yawRadians: number, pitchRadians: number): void {
    if (!this.enabledState) return;
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.euler.y -= yawRadians;
    this.euler.x = MathUtils.clamp(this.euler.x + pitchRadians, -MAX_PITCH, MAX_PITCH);
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** Moves along the viewing direction by `distance` scene units. */
  dolly(distance: number): void {
    if (!this.enabledState || !Number.isFinite(distance)) return;
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(forward, distance);
  }

  /** Integrates held inputs over one frame. Returns whether the camera moved. */
  update(frameDurationMs: number): boolean {
    if (!this.enabledState) return false;
    let moved = false;
    if (this.pendingDolly !== 0) {
      this.dolly(this.pendingDolly);
      this.pendingDolly = 0;
      moved = true;
    }
    const seconds = Math.min(MAX_STEP_MS, Math.max(0, frameDurationMs)) / 1000;
    if (seconds === 0) return moved;
    const input = this.input;
    if (input.yawRate !== 0 || input.pitchRate !== 0) {
      this.look(
        response(input.yawRate) * LOOK_RATE_RADIANS * seconds,
        response(input.pitchRate) * LOOK_RATE_RADIANS * seconds,
      );
      moved = true;
    }
    if (input.moveX !== 0 || input.moveZ !== 0 || input.vertical !== 0) {
      const speed = this.baseSpeed * this.speedMultiplier * (this.fast ? 3 : 1) * seconds;
      this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
      const yaw = this.euler.y;
      // Walking stays level, like a dolly on the floor; the crane moves vertically.
      const forward = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      this.camera.position
        .addScaledVector(forward, response(input.moveZ) * speed)
        .addScaledVector(right, response(input.moveX) * speed)
        .addScaledVector(new Vector3(0, 1, 0), response(input.vertical) * speed);
      moved = true;
    }
    return moved;
  }

  dispose(): void {
    this.release();
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerUp);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.element.removeEventListener("keyup", this.onKeyUp);
    this.element.removeEventListener("blur", this.onBlur);
  }

  private radiansPerPixel(): number {
    const height = this.element.clientHeight || 1;
    return MathUtils.degToRad(this.camera.fov) / height;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabledState) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.element.setPointerCapture?.(event.pointerId);
    this.pinchDistance = this.pointers.size === 2 ? this.spread() : undefined;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous || !this.enabledState) return;
    const current = { x: event.clientX, y: event.clientY };
    this.pointers.set(event.pointerId, current);
    if (this.pointers.size === 1) {
      // The scene follows the finger, as when dragging a photo sphere.
      const perPixel = this.radiansPerPixel();
      this.look((previous.x - current.x) * perPixel, (current.y - previous.y) * perPixel);
    } else if (this.pointers.size === 2 && this.pinchDistance !== undefined) {
      const spread = this.spread();
      const height = this.element.clientHeight || 1;
      this.pendingDolly += ((spread - this.pinchDistance) / height) * this.baseSpeed * 2;
      this.pinchDistance = spread;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.pinchDistance = this.pointers.size === 2 ? this.spread() : undefined;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabledState || event.metaKey || event.ctrlKey || event.altKey) return;
    this.fast = event.shiftKey;
    if (!KEY_BINDINGS[event.code]) return;
    event.preventDefault();
    this.heldKeys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.fast = event.shiftKey;
    this.heldKeys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.heldKeys.clear();
    this.fast = false;
  };

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
