import { migrated, movingShot } from "../test/projectFixtures";
import { migrateScene, shotStartCamera } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBProjectStore, validateProject } from "./ProjectStore";
import { DEFAULT_CAMERA, type Project } from "../types/project";
import type { CameraSpeedCurve } from "@oculo/scene-schema";

const databaseNames: string[] = [];

const speedCurve: CameraSpeedCurve = {
  version: 1,
  points: [
    { time: 0, speed: 0, intensity: 1 },
    { time: 0.25, speed: 2, intensity: 0.4 },
    { time: 1, speed: 1, intensity: 0 },
  ],
};

function makeProject(id: string, updatedAt: number): Project {
  return migrated({
    sceneId: "garden",
    assetVersionId: "legacy-scene:garden",
    schemaVersion: 2,
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

  it("reopens saved speed curves without changing camera waypoint arrival times", async () => {
    const name = `oculo-speed-curve-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const store = new IndexedDBProjectStore(name);
    const project = makeProject("curved", 1);
    project.scenes[0]!.shots = [
      movingShot(project.scenes[0]!, [
        { timeSeconds: 0, camera: DEFAULT_CAMERA, speedCurve: structuredClone(speedCurve) },
        { timeSeconds: 3, camera: DEFAULT_CAMERA },
        { timeSeconds: 8, camera: DEFAULT_CAMERA },
      ]),
    ];
    const expected = structuredClone(project);
    await store.put(project);
    project.scenes[0]!.shots[0]!.keyframes[0]!.speedCurve!.points[1]!.speed = 4;

    const reopened = new IndexedDBProjectStore(name);
    expect(await reopened.get("curved")).toEqual(expected);
  });

  it("rejects unsupported speed curve versions before replacing a saved project", async () => {
    const store = makeStore();
    const original = makeProject("curved", 1);
    await store.put(original);
    const invalid = {
      ...original,
      scenes: [
        {
          ...original.scenes[0]!,
          shots: [
            movingShot(original.scenes[0]!, [
              { timeSeconds: 0, camera: DEFAULT_CAMERA },
              { timeSeconds: 8, camera: DEFAULT_CAMERA },
            ]),
          ].map((shot) => ({
            ...shot,
            keyframes: shot.keyframes.map((frame, index) =>
              index === 0 ? { ...frame, speedCurve: { ...speedCurve, version: 2 } } : frame,
            ),
          })),
        },
      ],
    } as unknown as Project;

    await expect(store.put(invalid)).rejects.toThrow();
    expect(await store.get("curved")).toEqual(original);
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

  it("commits the snapshot taken at call time before another store reopens the project", async () => {
    const name = `oculo-durable-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const store = new IndexedDBProjectStore(name);
    const project = structuredClone(makeProject("one", 1));
    const expected = structuredClone(project);

    // The initial database open is still pending when the caller edits again.
    const saving = store.put(project);
    project.name = "Edited while opening";
    project.scenes[0]!.camera.pose.position[0] = 42;
    await saving;

    const reopened = new IndexedDBProjectStore(name);
    expect(await reopened.get("one")).toEqual(expected);
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
    await legacy.put("projects", makeProject("legacy", 7));
    legacy.close();

    const store = new IndexedDBProjectStore(name);
    expect((await store.get("legacy"))?.name).toBe("Project legacy");

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

  it.each([0, 1])(
    "migrates v%i project cameras, shots, and paths without changing their sensor geometry",
    async (schemaVersion) => {
      const name = `oculo-framing-${crypto.randomUUID()}`;
      databaseNames.push(name);
      const database = await openDB(name, 1, {
        upgrade(db) {
          db.createObjectStore("projects", { keyPath: "id" }).createIndex(
            "by-updated",
            "updatedAt",
          );
        },
      });
      const oldCamera = {
        pose: { position: [0, 1.4, 4.2], quaternion: [0, 0, 0, 1] },
        focalLengthMm: 35,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        near: 0.01,
        far: 1000,
      };
      const legacyCamera = { ...oldCamera, sensorHeightMm: 36 / 2.39 };
      const legacy = {
        schemaVersion,
        id: "legacy",
        name: "Project legacy",
        updatedAt: 7,
        durationSeconds: 8,
        scene: {
          id: "garden",
          name: "Garden",
          splatUrl: "https://example.com/scene.spz",
          source: "bundled",
        },
        settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
        camera: legacyCamera,
        shots: [
          {
            id: "shot",
            sceneId: "garden",
            name: "Wide",
            camera: oldCamera,
            createdAt: new Date(0).toISOString(),
            notes: "Keep this",
            thumbnailDataUrl: "data:image/jpeg;base64,saved",
          },
        ],
        path: {
          id: "move",
          name: "Saved move",
          keyframes: [{ timeSeconds: 0, camera: legacyCamera }],
        },
      };
      await database.put("projects", legacy);
      database.close();

      const store = new IndexedDBProjectStore(name);
      const migrated = (await store.get("legacy"))!;
      expect(migrated.schemaVersion).toBe(4);
      expect(migrated.scenes[0]!.camera.output.aspectRatio).toBeCloseTo(2.39);
      expect(migrated.scenes[0]!.camera.sensorHeightMm).toBe(legacyCamera.sensorHeightMm);
      expect(migrated.scenes[0]!.shots[0]!.setup.output.aspectRatio).toBe(1.5);
      expect(migrated.scenes[0]!.shots[0]!.thumbnailDataUrl).toBe(
        legacy.shots[0]!.thumbnailDataUrl,
      );
      expect(migrated.scenes[0]!.shots[0]!.notes).toBe("Keep this");
      // A one-keyframe legacy move was never playable, so only the still remains.
      expect(migrated.scenes[0]!.shots).toHaveLength(1);
      expect(shotStartCamera(migrated.scenes[0]!.shots[0]!).focalLengthMm).toBe(35);
      expect(migrated.updatedAt).toBe(7);
      expect(legacy.camera).not.toHaveProperty("outputAspectRatio");
      await store.put(migrated);
      expect(await store.get("legacy")).toEqual(migrated);
    },
  );

  it("rejects future projects and malformed current framing without silently migrating them", () => {
    expect(() => validateProject({ ...makeProject("future", 1), schemaVersion: 5 })).toThrow(
      "Unsupported project schema version: 5",
    );
    expect(() =>
      validateProject({
        ...makeProject("invalid", 1),
        camera: {
          ...DEFAULT_CAMERA,
          output: { aspectRatio: 0, crop: "center-inside-sensor" as const },
        },
      }),
    ).toThrow();
  });
});
