import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANNEQUIN_NODES } from "@oculo/scene-core";

const MODELS = join(__dirname, "..", "..", "public", "models");

interface GltfNode {
  name?: string;
  translation?: [number, number, number];
  children?: number[];
}

/** Reads the JSON chunk of a binary glTF (header, then the first chunk). */
function readGlb(path: string): { nodes: GltfNode[] } {
  const bytes = readFileSync(path);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  const length = bytes.readUInt32LE(12);
  expect(bytes.toString("ascii", 16, 20)).toBe("JSON");
  return JSON.parse(bytes.toString("utf8", 20, 20 + length)) as { nodes: GltfNode[] };
}

describe("cinematographer model", () => {
  const gltf = readGlb(join(MODELS, "cinematographer.glb"));

  it("has every joint the engine animates", () => {
    const names = gltf.nodes.map((node) => node.name);
    for (const name of MANNEQUIN_NODES) expect(names).toContain(name);
  });

  it("stands on its origin with the head joint where the procedural figure has it", () => {
    const byName = new Map(gltf.nodes.map((node, index) => [node.name, index]));
    const parents = new Map<number, number>();
    gltf.nodes.forEach((node, index) =>
      node.children?.forEach((child) => parents.set(child, index)),
    );
    let height = 0;
    let index = byName.get("head");
    while (index !== undefined) {
      height += gltf.nodes[index]?.translation?.[1] ?? 0;
      index = parents.get(index);
    }
    // The head pivot sits at the neck (0.93); its centre, the eye, is at 1.0.
    expect(height).toBeCloseTo(0.93, 3);
  });

  it("ships a small model and tray tokens", () => {
    expect(readFileSync(join(MODELS, "cinematographer.glb")).byteLength).toBeLessThan(160_000);
    for (const scale of ["2x", "3x"])
      expect(
        readFileSync(join(MODELS, `cinematographer-token@${scale}.png`)).byteLength,
      ).toBeGreaterThan(1000);
  });
});
