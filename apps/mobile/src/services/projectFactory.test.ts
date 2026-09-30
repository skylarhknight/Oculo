import { ProjectSchema, migrateScene } from "@oculo/scene-schema";
import { describe, expect, it } from "vitest";
import { shotFrom } from "../test/projectFixtures";
import {
  addScene,
  createProject,
  createProjectScene,
  duplicateScene,
  removeScene,
  renameScene,
  searchProjects,
  sortProjects,
  summarizeProject,
} from "./projectFactory";

const garden = migrateScene({
  id: "garden",
  name: "Garden",
  splatUrl: "https://example.com/garden.spz",
  source: "bundled",
});

function withShot(project: ReturnType<typeof createProject>, sceneIndex = 0) {
  const scene = project.scenes[sceneIndex]!;
  scene.shots.push(
    shotFrom({
      id: crypto.randomUUID(),
      sceneId: scene.sceneId,
      assetVersionId: scene.assetVersionId,
      name: "Wide",
      camera: structuredClone(scene.camera),
      createdAt: new Date(0).toISOString(),
      thumbnailDataUrl: "data:image/jpeg;base64,a",
    }),
  );
  return project;
}

describe("project factory", () => {
  it("creates valid multi-scene projects", () => {
    const project = addScene(
      createProject("  Shoot  ", createProjectScene(garden)),
      createProjectScene(garden, { name: "Night pass" }),
    );
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect(project.name).toBe("Shoot");
    expect(project.scenes.map((s) => s.name)).toEqual(["Garden", "Night pass"]);
    expect(createProject(" ", createProjectScene(garden)).name).toBe("Untitled project");
  });

  it("duplicates a scene with new shot IDs directly after the source", () => {
    const project = withShot(
      addScene(createProject("P", createProjectScene(garden)), createProjectScene(garden)),
    );
    const copy = duplicateScene(project, project.scenes[0]!.id);
    expect(ProjectSchema.parse(copy)).toBeTruthy();
    expect(copy.scenes).toHaveLength(3);
    expect(copy.scenes[1]!.name).toBe("Garden (copy)");
    expect(copy.scenes[1]!.shots[0]!.id).not.toBe(project.scenes[0]!.shots[0]!.id);
  });

  it("removes a scene and its export choices, but never the last scene", () => {
    const project = withShot(
      addScene(createProject("P", createProjectScene(garden)), createProjectScene(garden)),
    );
    const shotId = project.scenes[0]!.shots[0]!.id;
    project.shotSheet = { version: 1, excludedShotIds: [shotId] };
    const next = removeScene(project, project.scenes[0]!.id);
    expect(next.scenes).toHaveLength(1);
    expect(next.shotSheet?.excludedShotIds).toEqual([]);
    expect(() => removeScene(next, next.scenes[0]!.id)).toThrow("at least one scene");
    expect(renameScene(next, next.scenes[0]!.id, " B ").scenes[0]!.name).toBe("B");
  });

  it("summarizes, sorts with the tutorial pinned, and searches scene names", () => {
    const a = withShot(createProject("Alpha", createProjectScene(garden)));
    a.updatedAt = 1;
    const b = createProject("beta", createProjectScene(garden, { name: "Rooftop" }));
    b.updatedAt = 3;
    const tutorial = {
      ...createProject("Tutorial", createProjectScene(garden)),
      tutorial: true as const,
      updatedAt: 0,
    };
    expect(summarizeProject(a)).toMatchObject({ sceneCount: 1, shotCount: 1, onDeviceOnly: false });
    expect(sortProjects([a, b, tutorial], "recent").map((p) => p.name)).toEqual([
      "Tutorial",
      "beta",
      "Alpha",
    ]);
    expect(sortProjects([b, a, tutorial], "name").map((p) => p.name)).toEqual([
      "Tutorial",
      "Alpha",
      "beta",
    ]);
    expect(sortProjects([b, a], "shots").map((p) => p.name)).toEqual(["Alpha", "beta"]);
    expect(searchProjects([a, b], "roof").map((p) => p.name)).toEqual(["beta"]);
  });
});
