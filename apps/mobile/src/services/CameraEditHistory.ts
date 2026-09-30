import type { CinematicCamera, Shot } from "../types/project";

/**
 * Camera editing history is session-local; saved projects contain the resulting edits.
 * A snapshot holds the rig and the shot being edited (null in free camera mode).
 */
export type CameraEditSnapshot = {
  camera: CinematicCamera;
  shot: Shot | null;
  playheadSeconds: number;
};
type Entry = { before: CameraEditSnapshot; after: CameraEditSnapshot };
const clone = (value: CameraEditSnapshot): CameraEditSnapshot => structuredClone(value);
const equal = (a: CameraEditSnapshot, b: CameraEditSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

export function cameraEditSnapshot(
  camera: CinematicCamera,
  shot: Shot | null,
  playheadSeconds = 0,
): CameraEditSnapshot {
  return clone({ camera, shot, playheadSeconds });
}

export class CameraEditHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private grouping = false;
  private pending: Entry | null = null;

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.past.length > 0 || this.pending !== null;
  }
  get canRedo(): boolean {
    return this.pending === null && this.future.length > 0;
  }

  begin(): void {
    this.grouping = true;
  }

  record(before: CameraEditSnapshot, after: CameraEditSnapshot): void {
    if (equal(before, after)) return;
    const entry = { before: clone(before), after: clone(after) };
    if (this.grouping) {
      this.pending = { before: this.pending?.before ?? entry.before, after: entry.after };
    } else this.push(entry);
  }

  commit(): void {
    this.grouping = false;
    const pending = this.pending;
    this.pending = null;
    if (pending) this.push(pending);
  }

  undo(): CameraEditSnapshot | null {
    this.commit();
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(entry);
    return clone(entry.before);
  }

  redo(): CameraEditSnapshot | null {
    this.commit();
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(entry);
    return clone(entry.after);
  }

  private push(entry: Entry): void {
    if (equal(entry.before, entry.after)) return;
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
}
