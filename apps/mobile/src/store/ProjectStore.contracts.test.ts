import { migrated } from "../test/projectFixtures";
import { migrateScene, createAssetVersion } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";
import { DEFAULT_CAMERA, type Project } from "../types/project";

const databaseNames: string[] = [];

function makeProject(id: string, updatedAt: number): Project {
  return migrated({
    schemaVersion: 2,
    sceneId: "garden",
    assetVersionId: "legacy-scene:garden",
    id,
    name: `Project ${id}`,
    scene: migrateScene({
      id: "garden",
      name: "Garden",
      splatUrl: "https://example.com/scene.spz",
      source: "bundled",
    }),
    updatedAt,
    durationSeconds: 8,
    camera: DEFAULT_CAMERA,
    shots: [],
    path: {
      sceneId: "garden",
      assetVersionId: "legacy-scene:garden",
      id: "path",
      name: "Main path",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  });
}

function makeStore(): IndexedDBProjectStore {
  const name = `oculo-test-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return new IndexedDBProjectStore(name);
}

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => indexedDB.deleteDatabase(name)));
});

describe("IndexedDBProjectStore", () => {
  it("persists, reads, and deletes projects", async () => {
    const store = makeStore();
    const project = makeProject("one", 1);
    await store.put(project);

    expect(await store.get("one")).toEqual(project);
    await store.delete("one");
    expect(await store.get("one")).toBeUndefined();
  });

  it("lists most recently updated projects first", async () => {
    const store = makeStore();
    await store.put(makeProject("old", 10));
    await store.put(makeProject("new", 20));

    expect((await store.list()).map(({ id }) => id)).toEqual(["new", "old"]);
  });

  it("replaces an existing project without mutating the input", async () => {
    const store = makeStore();
    const project = makeProject("one", 1);
    await store.put(project);
    project.name = "Changed after save";

    expect((await store.get("one"))?.name).toBe("Project one");
    await store.put({ ...project, updatedAt: 2 });
    expect((await store.get("one"))?.updatedAt).toBe(2);
  });

  it("migrates a version 1 database additively, preserving projects", async () => {
    const name = `oculo-migration-${crypto.randomUUID()}`;
    databaseNames.push(name);

    // Simulate a database created before sync metadata existed.
    const legacy = await openDB(name, 1, {
      upgrade(database) {
        const projects = database.createObjectStore("projects", { keyPath: "id" });
        projects.createIndex("by-updated", "updatedAt");
      },
    });
    const current = makeProject("legacy", 7);
    const { output: _output, ...legacyCamera } = current.scenes[0]!.camera;
    void _output;
    const legacyRecord = {
      schemaVersion: 1,
      id: current.id,
      name: current.name,
      updatedAt: 7,
      durationSeconds: 8,
      settings: current.settings,
      scene: {
        id: "garden",
        name: "Garden",
        splatUrl: "https://example.com/scene.spz",
        source: "bundled",
      },
      camera: legacyCamera,
      shots: [],
      path: { id: "path", name: "Main path", keyframes: [] },
    };
    await legacy.put("projects", legacyRecord);
    legacy.close();

    const store = new IndexedDBProjectStore(name);
    const migrated = await store.get("legacy");
    expect(migrated?.name).toBe("Project legacy");
    expect(migrated?.schemaVersion).toBe(4);
    expect(migrated?.scenes[0]!.assetVersionId).toBe("legacy-project:legacy");
    const inspection = await openDB(name);
    expect(await inspection.get("projects", "legacy")).toEqual(legacyRecord);
    if (!migrated) throw new Error("Missing project");
    await store.put(migrated);
    expect((await inspection.get("projects", "legacy")).schemaVersion).toBe(4);
    inspection.close();

    // The new syncMeta store is available without touching existing data.
    await store.putSyncMeta({ id: "legacy", dirty: true, deleted: false });
    expect((await store.getSyncMeta("legacy"))?.dirty).toBe(true);
    expect((await store.list()).map(({ id }) => id)).toEqual(["legacy"]);
  });

  it("stores and removes sync metadata", async () => {
    const store = makeStore();
    await store.putSyncMeta({ id: "a", dirty: true, deleted: false, lastSyncedAt: 5 });
    await store.putSyncMeta({ id: "b", dirty: false, deleted: true });

    expect((await store.listSyncMeta()).length).toBe(2);
    await store.deleteSyncMeta("a");
    expect(await store.getSyncMeta("a")).toBeUndefined();
    expect((await store.getSyncMeta("b"))?.deleted).toBe(true);
  });
  it("atomically refuses scene rebinding and preserves the saved project", async () => {
    const store = makeStore();
    const p = makeProject("pinned", 1);
    await store.put(p);
    const changed = structuredClone(p);
    changed.scenes[0]!.scene.assetToScene.translation[0] = 10;
    await expect(store.put(changed)).rejects.toThrow("immutable");
    expect(await store.get(p.id)).toEqual(p);
    const anotherProject = { ...changed, id: "second" };
    await expect(store.put(anotherProject)).rejects.toThrow("registered");
    expect(await store.get("second")).toBeUndefined();
  });

  it("allows verified locator relocation across saves and store instances", async () => {
    const name = `oculo-relocation-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const store = new IndexedDBProjectStore(name);
    const p = makeProject("local", 1);
    p.scenes[0]!.scene.asset = await createAssetVersion(new Uint8Array([1, 2, 3]), {
      format: { name: "spz", version: "2" },
      locator: { kind: "local", relativePath: "scenes/original.spz" },
    });
    p.scenes[0]!.assetVersionId = p.scenes[0]!.scene.asset.versionId;
    await store.put(p);
    const reopened = new IndexedDBProjectStore(name);
    const moved = structuredClone(p);
    moved.scenes[0]!.scene.asset.locator = { kind: "local", relativePath: "scenes/moved.spz" };
    await reopened.put(moved);
    expect((await store.get(p.id))?.scenes[0]!.camera).toEqual(p.scenes[0]!.camera);
    expect((await store.get(p.id))?.scenes[0]!.assetVersionId).toBe(p.scenes[0]!.assetVersionId);
  });
});

it("upgrades the feature database layout without orphaning separately stored images", async () => {
  const name = `feature-v4-${crypto.randomUUID()}`;
  databaseNames.push(name);
  const oldCamera = {
    pose: { position: [0, 0, 3], quaternion: [0, 0, 0, 1] },
    focalLengthMm: 35,
    sensorWidthMm: 36,
    sensorHeightMm: 24,
    outputAspectRatio: 2.39,
    near: 0.01,
    far: 1000,
  };
  const speedCurve = {
    version: 1,
    points: [
      { time: 0, speed: 0, intensity: 1 },
      { time: 1, speed: 2, intensity: 0 },
    ],
  };
  const scene = {
    id: "old-scene",
    name: "Old scene",
    source: "bundled",
    splatUrl: "https://example.com/old.spz",
    splatQuaternion: [1, 0, 0, 0],
  };
  const old = {
    schemaVersion: 2,
    id: "old",
    name: "Old project",
    scene,
    updatedAt: 7,
    durationSeconds: 8,
    camera: oldCamera,
    shots: [
      {
        id: "shot",
        sceneId: scene.id,
        name: "Frame",
        camera: oldCamera,
        createdAt: "2026-09-01T00:00:00Z",
        notes: "Keep me",
      },
    ],
    path: {
      id: "path",
      name: "Move",
      keyframes: [
        { timeSeconds: 0, camera: oldCamera, speedCurve },
        { timeSeconds: 8, camera: oldCamera },
      ],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
    shotSheet: { version: 1, excludedShotIds: ["shot"] },
  };
  const signature = JSON.stringify([
    1,
    scene.id,
    scene.id,
    scene.splatUrl,
    scene.splatQuaternion,
    oldCamera.pose.position,
    oldCamera.pose.quaternion,
    35,
    36,
    24,
    2.39,
    0.01,
    1000,
  ]);
  const db = await openDB(name, 4, {
    upgrade(db) {
      db.createObjectStore("projects", { keyPath: "id" }).createIndex("by-updated", "updatedAt");
      db.createObjectStore("syncMeta", { keyPath: "id" });
      db.createObjectStore("shotImages", { keyPath: "key" }).createIndex("by-project", "projectId");
      db.createObjectStore("sceneAssets", { keyPath: "id" });
    },
  });
  await db.put("projects", old);
  await db.put("shotImages", {
    key: JSON.stringify(["old", "shot", signature]),
    projectId: "old",
    shotId: "shot",
    signature,
    dataUrl: "data:image/jpeg;base64,original",
  });
  await db.put("syncMeta", {
    id: "old",
    ownerUid: "owner",
    revision: 9,
    dirty: true,
    deleted: false,
  });
  db.close();
  const store = new IndexedDBProjectStore(name);
  const migrated = (await store.get("old"))!;
  expect(migrated.scenes[0]!.camera.output.aspectRatio).toBe(2.39);
  expect(migrated.scenes[0]!.shots.at(-1)!.keyframes[0]?.speedCurve).toEqual(speedCurve);
  expect(migrated.shotSheet).toEqual(old.shotSheet);
  expect(migrated.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe("data:image/jpeg;base64,original");
  expect(migrated.scenes[0]!.shots[0]?.assetVersionId).toBe(migrated.scenes[0]!.assetVersionId);
  expect(await store.getSyncMeta("old")).toMatchObject({ ownerUid: "owner", revision: 9 });
  await store.put(migrated);
  expect(await new IndexedDBProjectStore(name).get("old")).toEqual(migrated);
});
