import type { Vector3Tuple } from "./types.js";

/**
 * A "dollhouse" box for looking at a scene from above: everything outside it is hidden
 * while the map is open. Captured scenes often wrap the subject in a sky dome, or close
 * it with a ceiling; seen from outside, either hides the floor plan behind a blur.
 */
export interface Cutaway {
  /** World-space centre of the visible box. */
  readonly center: Vector3Tuple;
  /** Half the box's size along each world axis. */
  readonly halfExtents: Vector3Tuple;
  /** Where the ground is, for framing. */
  readonly floorY: number;
  /** The top of the visible box. */
  readonly cutY: number;
  /** The highest sampled splat, where a reveal animation starts. */
  readonly topY: number;
  /** Whether a ceiling was found (an interior) rather than open sky. */
  readonly ceiling: boolean;
  /** The scene's core, for framing: the footprint from the floor to the cut. */
  readonly core: { readonly center: Vector3Tuple; readonly radius: number };
}

export interface CutawayOptions {
  /** Share trimmed from each end of X and Z as outliers when finding the footprint. */
  readonly trim?: number;
  /** The box's width as a multiple of the footprint, so walls at the edge stay. */
  readonly margin?: number;
}

const MIN_SAMPLES = 100;
const BINS = 64;
/** Cells per side when looking for a roof over the footprint. */
const GRID = 8;
/** A cell needs this many samples before it can say whether it has a roof. */
const MIN_CELL_SAMPLES = 12;
/** Empty air under a roof, as a share of the scene's height. */
const ROOF_GAP = 0.18;
/** The share of cells that must have a roof before the scene counts as enclosed. */
const ROOFED_SHARE = 0.5;
/** How far under the roof the cut goes, as a share of the scene's height. */
const ROOF_MARGIN = 0.02;
/** A cell is part of the core when it holds this share of the typical splat's cell. */
const DENSITY_SHARE = 0.05;

function quantile(sorted: ArrayLike<number>, fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))
  ]!;
}

/**
 * Estimates the dollhouse box from splat centres (world space, Y up, as xyz triples).
 *
 * - The core is the densest part of a coarse voxel grid, refined twice: a sky dome or
 *   floaters are sparse however many splats they hold. Its X and Z are the footprint.
 * - Heights are read from the core inside that footprint. The top of that column (all but a tenth
 *    of a percent) is the natural cut.
 * - The scene is enclosed when most of its footprint has a roof: empty air above the
 *   floor, then something overhead. The cut then drops under the lowest of those
 *   roofs, which removes a flat ceiling, a vault or a dome and keeps the walls.
 *
 * Returns null when there are too few splats to judge.
 */
export function estimateCutaway(
  samples: ArrayLike<number>,
  options: CutawayOptions = {},
): Cutaway | null {
  const count = Math.floor(samples.length / 3);
  if (count < MIN_SAMPLES) return null;
  const trim = options.trim ?? 0.01;
  const margin = options.margin ?? 1.25;

  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  let topY = -Infinity;
  for (let i = 0; i < count; i++) {
    xs[i] = samples[i * 3]!;
    zs[i] = samples[i * 3 + 2]!;
    topY = Math.max(topY, samples[i * 3 + 1]!);
  }

  // The dense core: a sky dome or floaters are sparse however many splats they hold.
  let kept = Array.from({ length: count }, (_, i) => i);
  for (let pass = 0; pass < 2; pass++) {
    const denser = densestCells(samples, kept);
    if (denser.length < MIN_SAMPLES) break;
    kept = denser;
  }
  const sortedX = kept.map((i) => xs[i]!).sort((a, b) => a - b);
  const sortedZ = kept.map((i) => zs[i]!).sort((a, b) => a - b);
  const x0 = quantile(sortedX, trim);
  const x1 = quantile(sortedX, 1 - trim);
  const z0 = quantile(sortedZ, trim);
  const z1 = quantile(sortedZ, 1 - trim);
  if (!(x1 >= x0 && z1 >= z0)) return null;

  const inColumn = kept.filter((i) => {
    const x = xs[i]!;
    const z = zs[i]!;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
  });
  if (inColumn.length < MIN_SAMPLES) return null;
  const column = inColumn.map((i) => samples[i * 3 + 1]!).sort((a, b) => a - b);
  const bottom = quantile(column, 0.02);
  const floorY = quantile(column, 0.05);
  const columnTop = quantile(column, 0.999);
  const span = columnTop - bottom;
  if (!(span > 0) || !Number.isFinite(span)) return null;

  // A roof: over most of the footprint, looking up from the floor there is empty air
  // and then something overhead (a ceiling, a vault, a dome). Walls, trees and
  // buildings rise continuously from the ground, so they leave no such gap.
  const cells = new Map<number, number[]>();
  for (const i of inColumn) {
    const gx = Math.min(GRID - 1, Math.floor(((xs[i]! - x0) / (x1 - x0 || 1)) * GRID));
    const gz = Math.min(GRID - 1, Math.floor(((zs[i]! - z0) / (z1 - z0 || 1)) * GRID));
    const key = gx * GRID + gz;
    const heights = cells.get(key);
    if (heights) heights.push(samples[i * 3 + 1]!);
    else cells.set(key, [samples[i * 3 + 1]!]);
  }
  const minGap = span * ROOF_GAP;
  const roofs: number[] = [];
  let occupied = 0;
  for (const heights of cells.values()) {
    if (heights.length < MIN_CELL_SAMPLES) continue;
    occupied++;
    heights.sort((a, b) => a - b);
    // The widest stretch of empty air in this cell, above the floor.
    let gap = 0;
    let roof = Infinity;
    for (let k = 1; k < heights.length; k++) {
      const below = heights[k - 1]!;
      const above = heights[k]!;
      if (above - below > gap && above > floorY + minGap) {
        gap = above - below;
        roof = above;
      }
    }
    if (gap >= minGap) roofs.push(roof);
  }
  let ceiling = false;
  let cutY = columnTop + span / BINS;
  if (occupied > 0 && roofs.length >= occupied * ROOFED_SHARE) {
    // Cut under the lowest part of the roof (a dome's spring line, a ceiling's
    // underside) so the walls stay and everything overhead goes.
    roofs.sort((a, b) => a - b);
    cutY = quantile(roofs, 0.05) - span * ROOF_MARGIN;
    ceiling = true;
  }

  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hx = ((x1 - x0) / 2) * margin;
  const hz = ((z1 - z0) / 2) * margin;
  const low = bottom - span * 0.1;
  const coreRadius = Math.hypot(x1 - x0, cutY - floorY, z1 - z0) / 2;
  return {
    center: [cx, (low + cutY) / 2, cz],
    halfExtents: [Math.max(hx, 1e-3), Math.max((cutY - low) / 2, 1e-3), Math.max(hz, 1e-3)],
    floorY,
    cutY,
    topY: Math.max(topY, cutY),
    ceiling,
    core: {
      center: [cx, (floorY + cutY) / 2, cz],
      radius: coreRadius > 0 ? coreRadius : span,
    },
  };
}

/**
 * The splats in cells denser than a small share of the typical splat's cell: a coarse
 * voxel grid over the given splats' box, where density rather than count decides.
 */
function densestCells(samples: ArrayLike<number>, indices: readonly number[]): number[] {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const i of indices)
    for (let axis = 0; axis < 3; axis++) {
      const value = samples[i * 3 + axis]!;
      if (value < low[axis]!) low[axis] = value;
      if (value > high[axis]!) high[axis] = value;
    }
  const cellsPerAxis = Math.max(4, Math.min(32, Math.round(Math.cbrt(indices.length / 4))));
  const size = low.map((value, axis) => Math.max(high[axis]! - value, 1e-9) / cellsPerAxis);
  const cellOf = (i: number) => {
    let cell = 0;
    for (let axis = 0; axis < 3; axis++) {
      const at = Math.floor((samples[i * 3 + axis]! - low[axis]!) / size[axis]!);
      cell = cell * cellsPerAxis + Math.min(cellsPerAxis - 1, Math.max(0, at));
    }
    return cell;
  };
  const counts = new Map<number, number>();
  const cells = indices.map((i) => {
    const cell = cellOf(i);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
    return cell;
  });
  // The cell density the average splat sees, weighted by the splats themselves.
  let squares = 0;
  for (const value of counts.values()) squares += value * value;
  const threshold = (squares / indices.length) * DENSITY_SHARE;
  return indices.filter((_, k) => counts.get(cells[k]!)! >= threshold);
}

/** Whether a world point is inside the cutaway box (with a small tolerance). */
export function insideCutaway(cutaway: Cutaway, point: Vector3Tuple, slack = 1.001): boolean {
  return point.every(
    (value, axis) => Math.abs(value - cutaway.center[axis]!) <= cutaway.halfExtents[axis]! * slack,
  );
}
