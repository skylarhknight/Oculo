import { readFile } from "node:fs/promises";
import { SpzReader } from "@sparkjsdev/spark";
import { describe, expect, it } from "vitest";

describe("imported scene fixture compatibility", () => {
  it("decodes every synthetic splat using the renderer's real SPZ decoder", async () => {
    const bytes = await readFile(
      new URL("../../../apps/mobile/test-fixtures/colored-wall.spz", import.meta.url),
    );
    const reader = new SpzReader({ fileBytes: bytes });
    await reader.parseHeader();
    expect(reader.numSplats).toBe(192);
    let centers = 0;
    let opaque = 0;
    let scales = 0;
    let rotations = 0;
    await reader.parseSplats(
      (_index, x, y, z) => {
        expect([x, y, z].every(Number.isFinite)).toBe(true);
        centers += 1;
      },
      (_index, alpha) => {
        expect(alpha).toBeGreaterThan(0.8);
        opaque += 1;
      },
      undefined,
      (_index, x, y, z) => {
        expect(Math.min(x, y, z)).toBeGreaterThan(0);
        scales += 1;
      },
      (_index, x, y, z, w) => {
        expect(Math.hypot(x, y, z, w)).toBeCloseTo(1);
        rotations += 1;
      },
    );
    expect([centers, opaque, scales, rotations]).toEqual([192, 192, 192, 192]);
  });
});
