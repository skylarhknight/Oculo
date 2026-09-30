import { describe, expect, it } from "vitest";
import { frustumSegments } from "../src/overlay.js";

describe("shot marker frustums", () => {
  it("places the far rectangle along the camera's -Z with the output aspect", () => {
    const values = frustumSegments(
      {
        id: "a",
        position: [1, 2, 3],
        quaternion: [0, 0, 0, 1],
        verticalFovDegrees: 90,
        aspectRatio: 2,
      },
      1,
    );
    // 4 edges from the apex + 4 rectangle edges + 1 up tick, two points each.
    expect(values).toHaveLength(9 * 2 * 3);
    expect(values.slice(0, 3)).toEqual([1, 2, 3]);
    const [x, y, z] = values.slice(3, 6);
    expect(x).toBeCloseTo(1 - 2);
    expect(y).toBeCloseTo(2 + 1);
    expect(z).toBeCloseTo(3 - 1);
  });
});
