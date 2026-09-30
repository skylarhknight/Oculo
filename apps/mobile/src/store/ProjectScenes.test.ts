import { migrateScene } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";
import { createWorkspaceStore } from "./WorkspaceStore";
import { DEFAULT_CAMERA, type Project, type ProjectScene } from "../types/project";
import { firstScene, shotFrom } from "../test/projectFixtures";
import { prepareSceneImport } from "../services/sceneImport";
import { spzFixture } from "../test/spzFixture";

const bundled = migrateScene({
  id: "garden",
  name: "Garden",
  splatUrl: "https://example.com/scene.spz",
  source: "bundled",
});

function sceneEntry(id: string, scene = bundled, shotPrefix = id): ProjectScene {
  const ref = { sceneId: scene.id, assetVersionId: scene.asset.versionId };
  return {
    id,
    name: `Scene ${id}`,
    createdAt: 1,
    updatedAt: 1,
    scene,
    ...ref,
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [
      shotFrom({
        ...ref,
        id: `${shotPrefix}-shot`,
        name: "Wide",
        camera: structuredClone(DEFAULT_CAMERA),
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: `data:image/jpeg;base64,${shotPrefix}`,
      }),
    ],
  };
}

function project(id: string, scenes: ProjectScene[], extra: Partial<Project> = {}): Project {
  return {
    schemaVersion: 4,
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    scenes,
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
    ...extra,
  };
}

const newStore = (limit = () => Infinity) => {
  const name = `scenes-${crypto.randomUUID()}`;
  return { name, store: new IndexedDBProjectStore(name, limit) };
};

describe("multi-scene projects", () => {
  it("keeps frames per scene and removes only a deleted scene's frames", async () => {
    const { name, store } = newStore();
    await store.put(project("p", [sceneEntry("a"), sceneEntry("b")]));
    const saved = (await store.get("p"))!;
    expect(saved.scenes.map((s) => s.shots[0]?.thumbnailDataUrl)).toEqual([
      "data:image/jpeg;base64,a",
      "data:image/jpeg;base64,b",
    ]);
    await store.put({ ...saved, scenes: [saved.scenes[1]!], updatedAt: 2 });
    const db = await openDB(name);
    expect(await db.count("shotImages")).toBe(1);
    db.close();
    expect((await store.get("p"))!.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe(
      "data:image/jpeg;base64,b",
    );
  });

  it("adds an imported scene atomically and deletes its bytes with the scene", async () => {
    const { store } = newStore();
    await store.put(project("p", [sceneEntry("a")]));
    const prepared = await prepareSceneImport(spzFixture());
    const existing = (await store.get("p"))!;
    const withImport = {
      ...existing,
      scenes: [...existing.scenes, sceneEntry("imported", prepared.scene)],
    };
    await store.putImportedProject(withImport, prepared.asset);
    expect(await store.getSceneAsset(prepared.asset.id)).toBeDefined();
    await store.put({ ...withImport, scenes: [withImport.scenes[0]!] });
    expect(await store.getSceneAsset(prepared.asset.id)).toBeUndefined();
  });

  it("rejects rebinding a kept scene to different coordinates", async () => {
    const { store } = newStore();
    await store.put(project("p", [sceneEntry("a")]));
    const moved = structuredClone(bundled);
    moved.assetToScene.translation[0] = 3;
    await expect(store.put(project("p", [sceneEntry("a", moved)]))).rejects.toThrow();
  });

  it("does not count the tutorial toward the free project, but counts its copy", async () => {
    const { store } = newStore(() => 1);
    await store.put(project("tutorial", [sceneEntry("t")], { tutorial: true }));
    await store.put(project("mine", [sceneEntry("m")]));
    await expect(store.put(project("second", [sceneEntry("s")]))).rejects.toThrow("free project");
    await store.delete("mine");
    const copy = await store.duplicateProject("tutorial", "copy", "My copy");
    expect(copy.tutorial).toBeUndefined();
    await expect(store.put(project("third", [sceneEntry("x")]))).rejects.toThrow("free project");
  });

  it("writes a scene workspace back without touching the project's other scenes", async () => {
    const { store } = newStore();
    await store.put(project("p", [sceneEntry("a"), sceneEntry("b")]));
    const saved = (await store.get("p"))!;
    const workspace = firstScene(saved);
    await createWorkspaceStore(store).put({
      ...workspace,
      projectSceneName: "Renamed",
      updatedAt: 5,
      shots: [],
    });
    const next = (await store.get("p"))!;
    expect(next.scenes[0]!.name).toBe("Renamed");
    expect(next.scenes[0]!.shots).toEqual([]);
    expect(next.scenes[1]).toEqual(saved.scenes[1]);
    expect(next.updatedAt).toBe(5);
  });
});
