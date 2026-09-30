/**
 * Small, frame-rate independent motion primitives shared by the map view and the
 * mannequin. Everything advances from elapsed milliseconds, never frame counts.
 */

/** A damped spring toward a target, integrated with fixed substeps for stability. */
export class Spring {
  velocity = 0;
  target: number;

  constructor(
    public value: number,
    public stiffness = 170,
    public damping = 26,
  ) {
    this.target = value;
  }

  /** Jumps to a value at rest. */
  snap(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Adds velocity, for a flick or an impact. */
  kick(velocity: number): void {
    this.velocity += velocity;
  }

  get settled(): boolean {
    return Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3;
  }

  update(dtMs: number): number {
    let remaining = Math.min(Math.max(dtMs, 0), 100) / 1000;
    const step = 1 / 240;
    while (remaining > 0) {
      const dt = Math.min(step, remaining);
      const force = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += force * dt;
      this.value += this.velocity * dt;
      remaining -= dt;
    }
    return this.value;
  }
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** Slow lift-off, fast middle, soft landing: the camera "dive" into the character. */
export const easeDive = (t: number) => {
  const x = clamp01(t);
  const s = x * x * (3 - 2 * x);
  return s * s * (3 - 2 * s);
};

export const easeOutBack = (t: number, overshoot = 1.6) => {
  const x = clamp01(t) - 1;
  return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
};

/** Exponential decay of a velocity with a half-life, independent of frame rate. */
export function decay(velocity: number, dtMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 0;
  return velocity * 0.5 ** (Math.max(0, dtMs) / halfLifeMs);
}

/** Shortest signed angle from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  const tau = Math.PI * 2;
  return ((((to - from + Math.PI) % tau) + tau) % tau) - Math.PI;
}

/** A timed transition resolved by the render loop. Zero duration settles at once. */
export class Tween {
  elapsedMs = 0;
  private resolveDone: () => void = () => undefined;
  readonly done: Promise<void>;

  constructor(
    readonly durationMs: number,
    readonly apply: (t: number) => void,
  ) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    if (durationMs <= 0) this.finish();
  }

  get finished(): boolean {
    return this.elapsedMs >= this.durationMs;
  }

  update(dtMs: number): boolean {
    if (this.finished) return true;
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + Math.max(0, dtMs));
    this.apply(this.elapsedMs / this.durationMs);
    if (this.finished) this.resolveDone();
    return this.finished;
  }

  finish(): void {
    this.elapsedMs = this.durationMs;
    this.apply(1);
    this.resolveDone();
  }
}
