import { describe, expect, it } from "vitest";
import { estimateCutaway, insideCutaway } from "../src/cutaway.js";

/** A deterministic pseudo-random sequence so the fixtures never flake. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function cloud(
  parts: Array<[count: number, point: (r: () => number) => [number, number, number]]>,
) {
  const r = random(7);
  const out: number[] = [];
  for (const [count, point] of parts) for (let i = 0; i < count; i++) out.push(...point(r));
  return new Float32Array(out);
}

const span = (r: () => number, half: number) => (r() * 2 - 1) * half;

describe("cutaway estimate", () => {
  it("cuts just under a room's ceiling and keeps the walls", () => {
    const room = cloud([
      [6000, (r) => [span(r, 5), r() * 0.05, span(r, 5)]], // floor
      [6000, (r) => [span(r, 5), 3 + r() * 0.05, span(r, 5)]], // ceiling
      [1500, (r) => [5, r() * 3, span(r, 5)]], // walls
      [1500, (r) => [-5, r() * 3, span(r, 5)]],
      [1500, (r) => [span(r, 5), r() * 3, 5]],
      [1500, (r) => [span(r, 5), r() * 3, -5]],
      [400, (r) => [span(r, 1), r() * 1.2, span(r, 1)]], // a table
    ]);
    const cut = estimateCutaway(room)!;
    expect(cut.ceiling).toBe(true);
    expect(cut.cutY).toBeLessThan(3);
    expect(cut.cutY).toBeGreaterThan(2);
    expect(insideCutaway(cut, [4.9, 1.5, 0])).toBe(true);
    expect(insideCutaway(cut, [0, 3.02, 0])).toBe(false);
    expect(insideCutaway(cut, [0, 0.5, 0])).toBe(true);
  });

  it("cuts a domed rotunda at the dome's spring line and keeps its walls", () => {
    const rotunda = cloud([
      [
        6000,
        (r) => {
          const radius = 10 * Math.sqrt(r());
          const angle = r() * Math.PI * 2;
          return [radius * Math.cos(angle), r() * 0.1, radius * Math.sin(angle)];
        },
      ], // floor
      [
        5000,
        (r) => {
          const angle = r() * Math.PI * 2;
          return [10 * Math.cos(angle), r() * 10, 10 * Math.sin(angle)];
        },
      ], // drum walls
      [
        7000,
        (r) => {
          const theta = r() * Math.PI * 2;
          const phi = Math.acos(r());
          return [
            10 * Math.sin(phi) * Math.cos(theta),
            10 + 10 * Math.cos(phi),
            10 * Math.sin(phi) * Math.sin(theta),
          ];
        },
      ], // dome
    ]);
    const cut = estimateCutaway(rotunda)!;
    expect(cut.ceiling).toBe(true);
    // The rim of the dome nearest the drum stays as a ring; the vault over the floor goes.
    expect(cut.cutY).toBeGreaterThan(9);
    expect(cut.cutY).toBeLessThan(15);
    expect(insideCutaway(cut, [0, 0.05, 0])).toBe(true);
    expect(insideCutaway(cut, [9.9, 5, 0])).toBe(true);
    expect(insideCutaway(cut, [0, 19.5, 0])).toBe(false);
  });

  it("drops a sky dome but keeps the ground and trees", () => {
    const outdoors = cloud([
      [8000, (r) => [span(r, 10), r() * 0.3, span(r, 10)]], // ground
      [1200, (r) => [span(r, 2), 0.3 + r() * 3.5, span(r, 2)]], // a tree
      [
        6000,
        (r) => {
          // An upper hemisphere of sky, radius 100.
          const theta = r() * Math.PI * 2;
          const phi = Math.acos(r());
          return [
            100 * Math.sin(phi) * Math.cos(theta),
            100 * Math.cos(phi),
            100 * Math.sin(phi) * Math.sin(theta),
          ];
        },
      ],
    ]);
    const cut = estimateCutaway(outdoors)!;
    expect(cut.ceiling).toBe(false);
    expect(cut.cutY).toBeGreaterThan(3.5);
    expect(cut.cutY).toBeLessThan(20);
    expect(cut.halfExtents[0]).toBeLessThan(40);
    expect(insideCutaway(cut, [0, 3.7, 0])).toBe(true);
    expect(insideCutaway(cut, [0, 100, 0])).toBe(false);
    expect(insideCutaway(cut, [95, 20, 0])).toBe(false);
    expect(cut.topY).toBeGreaterThan(90);
    expect(cut.core.radius).toBeLessThan(30);
  });

  it("does not take a partial canopy for a ceiling", () => {
    const park = cloud([
      [8000, (r) => [span(r, 10), r() * 0.2, span(r, 10)]],
      [300, (r) => [span(r, 1), r() * 4, span(r, 1)]], // trunk
      [3000, (r) => [4 + span(r, 3), 4 + r() * 0.4, 4 + span(r, 3)]], // one canopy
    ]);
    const cut = estimateCutaway(park)!;
    expect(cut.ceiling).toBe(false);
    expect(cut.cutY).toBeGreaterThan(4.3);
  });

  it("gives up on too few splats", () => {
    expect(estimateCutaway(new Float32Array(90))).toBeNull();
    expect(estimateCutaway([])).toBeNull();
  });
});
