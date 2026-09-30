import { parseShotPlan } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { createTutorialProject } from "./tutorial";
import { cameraMetadataArtifact, safeFileStem } from "./cameraMetadataExport";
import { firstScene } from "../test/projectFixtures";

describe("camera metadata export", () => {
  it("creates a parseable, versioned JSON artifact with a safe filename", async () => {
    const workspace = firstScene(createTutorialProject());
    const artifact = cameraMetadataArtifact(workspace);
    expect(artifact.mimeType).toBe("application/json");
    expect(artifact.name).toMatch(/^[\p{L}\p{N} _().-]+ camera data\.json$/u);
    const plan = parseShotPlan(await artifact.blob.text());
    expect(plan.project.shots).toHaveLength(3);
    expect(plan.project.shots.map((shot) => shot.keyframes.length)).toEqual([1, 1, 3]);
    expect(plan.project.shots[2]!.setup.lens.kind).toBe("zoom");
  });

  it("sanitizes filename stems", () => {
    expect(safeFileStem("../Scene: 1/2 · Night")).toBe("Scene 1 2 Night");
    expect(safeFileStem("///")).toBe("Oculo");
  });
});
