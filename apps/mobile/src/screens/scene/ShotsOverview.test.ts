import { describe, expect, it } from "vitest";
import { fanOut } from "./ShotsOverview";

describe("shots overview pins", () => {
  it("leaves lone pins in place and stacks shared spots in rows above them", () => {
    const shared = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index}`,
      x: 100 + index,
      y: 100,
    }));
    const fans = fanOut([...shared, { id: "far", x: 300, y: 100 }]);
    expect(fans.get("far")).toEqual({ x: 0, y: 0 });
    // Four across the bottom row, centred on the spot, one pin apart.
    expect(["s0", "s1", "s2", "s3"].map((id) => fans.get(id)!.x)).toEqual([-48, -16, 16, 48]);
    expect(fans.get("s0")!.y).toBe(0);
    // The rest rise one row, centred again.
    expect(["s4", "s5"].map((id) => fans.get(id))).toEqual([
      { x: -16, y: -32 },
      { x: 16, y: -32 },
    ]);
  });

  it("keeps pins from neighbouring spots from overlapping", () => {
    const markers = [
      { id: "a", x: 100, y: 100 },
      { id: "b", x: 140, y: 100 },
      { id: "c", x: 150, y: 110 },
    ];
    const fans = fanOut(markers);
    const heads = markers.map((marker) => ({
      x: marker.x + fans.get(marker.id)!.x,
      y: marker.y + fans.get(marker.id)!.y,
    }));
    for (let i = 0; i < heads.length; i += 1)
      for (let j = i + 1; j < heads.length; j += 1)
        expect(
          Math.hypot(heads[i]!.x - heads[j]!.x, heads[i]!.y - heads[j]!.y),
        ).toBeGreaterThanOrEqual(31.5);
  });
});
