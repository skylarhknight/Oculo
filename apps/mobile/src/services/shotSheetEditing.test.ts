import { migrateScene } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA, type SceneWorkspace } from "../types/project";
import { shotFrom } from "../test/projectFixtures";
import { createShotSheet } from "./shotSheet";
import {
  deleteShotFromProject,
  nextShotName,
  reorderShot,
  setShotIncluded,
} from "./shotSheetEditing";

function projectFixture(): SceneWorkspace {
  return {
    sceneId: "station",
    assetVersionId: "legacy-scene:station",
    projectSceneId: "scene-1",
    projectSceneName: "Scene",
    id: "film",
    name: "Station",
    updatedAt: 1,
    scene: migrateScene({
      id: "station",
      name: "Station scene",
      splatUrl: "https://example.com/a.spz",
      source: "bundled",
    }),
    camera: structuredClone(DEFAULT_CAMERA),
    shots: ["Shot 01", "Shot 03", "Custom"].map((name, index) =>
      shotFrom({
        assetVersionId: "legacy-scene:station",
        id: `s${index + 1}`,
        name,
        sceneId: "station",
        camera: structuredClone(DEFAULT_CAMERA),
        notes: "",
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: "data:image/png;base64,saved",
      }),
    ),
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

describe("shot sheet editing", () => {
  it("deletes an excluded shot without leaving an invalid in-memory selection", () => {
    const project = {
      ...projectFixture(),
      shotSheet: { version: 1 as const, excludedShotIds: ["s2", "s3", "s3", "deleted"] },
    };
    const next = deleteShotFromProject(project, "s2");
    expect(next.shots.map(({ id }) => id)).toEqual(["s1", "s3"]);
    expect(next.shotSheet?.excludedShotIds).toEqual(["s3"]);
    expect(createShotSheet(next).shots.map(({ id }) => id)).toEqual(["s1"]);
    expect(project.shots).toHaveLength(3);
    expect(project.shotSheet.excludedShotIds).toEqual(["s2", "s3", "s3", "deleted"]);
  });

  it("keeps stable IDs and inclusion while reordering, and bounds movement at either edge", () => {
    const project = projectFixture();
    const selection = setShotIncluded(project, "s1", false);
    const moved = { ...project, shots: reorderShot(project, "s3", -1), shotSheet: selection };
    expect(moved.shots.map(({ id }) => id)).toEqual(["s1", "s3", "s2"]);
    expect(createShotSheet(moved).shots.map(({ id, number }) => [id, number])).toEqual([
      ["s3", 1],
      ["s2", 2],
    ]);
    expect(reorderShot(moved, "s1", -1)).toEqual(moved.shots);
    expect(reorderShot(moved, "s2", 1)).toEqual(moved.shots);
    expect(reorderShot(moved, "missing", 1)).toEqual(moved.shots);
    expect(setShotIncluded(moved, "s1", true).excludedShotIds).toEqual([]);
  });

  it("chooses unused capture names after deletion, renaming and unusually large numeric titles", () => {
    const project = projectFixture();
    expect(nextShotName(project.shots)).toBe("Shot 04");
    expect(nextShotName(project.shots.filter(({ name }) => name !== "Shot 01"))).toBe("Shot 04");
    project.shots[0]!.name = `Shot ${Number.MAX_SAFE_INTEGER}`;
    project.shots[1]!.name = `Shot ${Number.MAX_SAFE_INTEGER - 1}`;
    project.shots[2]!.name = "shot 01";
    expect(nextShotName(project.shots)).toBe("Shot 02");
  });
});
