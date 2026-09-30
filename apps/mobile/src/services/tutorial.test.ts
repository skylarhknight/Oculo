import { ProjectSchema, shotStartCamera } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { createTutorialProject } from "./tutorial";

describe("tutorial project", () => {
  it("is a valid, flagged, offline project with static shots and a moving shot", () => {
    const tutorial = createTutorialProject();
    expect(ProjectSchema.parse(tutorial)).toEqual(tutorial);
    expect(tutorial.tutorial).toBe(true);
    const [scene] = tutorial.scenes;
    expect(scene!.scene.asset.locator.kind).not.toBe("remote");
    expect(scene!.shots).toHaveLength(3);
    expect(scene!.shots.every((shot) => shot.notes)).toBe(true);
    const [wide, medium, push] = scene!.shots;
    expect(wide!.keyframes).toHaveLength(1);
    expect(medium!.keyframes).toHaveLength(1);
    expect(push!.keyframes).toHaveLength(3);
    expect(push!.setup.lens).toEqual({ kind: "zoom", minFocalLengthMm: 24, maxFocalLengthMm: 85 });
    // The move pulls focus and zooms in while it travels.
    expect(push!.keyframes.map((k) => k.focusDistanceM)).toEqual([6, 3, 1.2]);
    expect(push!.keyframes.at(-1)!.focalLengthMm).toBe(85);
    expect(push!.keyframes[0]!.speedCurve).toBeDefined();
    expect(shotStartCamera(medium!).pose.position).not.toEqual(
      shotStartCamera(wide!).pose.position,
    );
  });
});
