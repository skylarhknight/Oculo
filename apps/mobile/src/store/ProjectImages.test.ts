import { migrated, editFirstScene, type SingleSceneDocument } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { IndexedDBProjectStore, validateProject } from "./ProjectStore";
import { DEFAULT_CAMERA, type Project } from "../types/project";

function projectDocument(id = "p"): SingleSceneDocument {
  return {
    sceneId: "scene",
    assetVersionId: "legacy-scene:scene",
    schemaVersion: 2,
    id,
    name: "Location study",
    updatedAt: 1,
    durationSeconds: 8,
    scene: migrateScene({
      id: "scene",
      name: "Scene",
      splatUrl: "https://example.com/scene.spz",
      source: "bundled",
    }),
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [
      {
        assetVersionId: "legacy-scene:scene",
        id: "s1",
        sceneId: "scene",
        name: "Shot 01",
        camera: structuredClone(DEFAULT_CAMERA),
        createdAt: new Date(0).toISOString(),
        thumbnailDataUrl: "data:image/jpeg;base64,first",
      },
      {
        assetVersionId: "legacy-scene:scene",
        id: "s2",
        sceneId: "scene",
        name: "Shot 02",
        camera: structuredClone(DEFAULT_CAMERA),
        createdAt: new Date(1).toISOString(),
        thumbnailDataUrl: "data:image/jpeg;base64,second",
      },
    ],
    path: {
      sceneId: "scene",
      assetVersionId: "legacy-scene:scene",
      id: "path",
      name: "Move",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  };
}

const project = (id = "p"): Project => migrated(projectDocument(id));

function setup() {
  const name = `oculo-images-${crypto.randomUUID()}`;
  return { name, store: new IndexedDBProjectStore(name) };
}

function metadataOnly(value: Project): Project {
  return editFirstScene(value, (w) => ({
    ...w,
    shots: w.shots.map((shot) => {
      const copy = { ...shot };
      delete copy.thumbnailDataUrl;
      return copy;
    }),
  }));
}

describe("durable shot media", () => {
  it("stores images separately and hydrates them after a metadata-only save and database reopen", async () => {
    const { name, store } = setup();
    const original = project();
    await store.put(original);
    await store.put({ ...metadataOnly(original), name: "Updated title", updatedAt: 2 });
    const reopened = new IndexedDBProjectStore(name);
    const saved = (await reopened.get("p"))!;
    expect(saved.name).toBe("Updated title");
    expect(saved.scenes[0]!.shots.map((shot) => shot.thumbnailDataUrl)).toEqual(
      original.scenes[0]!.shots.map((shot) => shot.thumbnailDataUrl),
    );
    expect((await reopened.list())[0]?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeDefined();
    const db = await openDB(name);
    expect((await db.get("projects", "p")).scenes[0].shots[0].thumbnailDataUrl).toBeUndefined();
    expect(await db.count("shotImages")).toBe(2);
    db.close();
  });

  it("atomically migrates legacy embedded frames on first read without changing their contents", async () => {
    const name = `oculo-legacy-images-${crypto.randomUUID()}`;
    const db = await openDB(name, 2, {
      upgrade(database) {
        database
          .createObjectStore("projects", { keyPath: "id" })
          .createIndex("by-updated", "updatedAt");
        database.createObjectStore("syncMeta", { keyPath: "id" });
      },
    });
    // A stored single-scene (v2) row migrates on read without losing its frames.
    await db.put("projects", projectDocument());
    await db.put("syncMeta", { id: "p", dirty: false, deleted: false, lastSyncedAt: 1 });
    db.close();
    const migrated = new IndexedDBProjectStore(name);
    expect(await migrated.get("p")).toEqual(project());
    const check = await openDB(name);
    expect(check.version).toBe(7);
    const row = await check.get("projects", "p");
    expect(row.schemaVersion).toBe(4);
    expect(row.scenes[0].shots[0].thumbnailDataUrl).toBeUndefined();
    expect(await check.count("shotImages")).toBe(2);
    expect((await migrated.getSyncMeta("p"))?.lastSyncedAt).toBe(1);
    check.close();
  });

  it.each(["lens", "aspect", "pose", "scene"])(
    "never attaches an existing image to a different %s",
    async (change) => {
      const { name, store } = setup();
      await store.put(project());
      const next = metadataOnly(project());
      const shot = next.scenes[0]!.shots[0]!;
      if (change === "lens") {
        shot.setup.lens = { kind: "prime", focalLengthMm: 85 };
        shot.keyframes[0]!.focalLengthMm = 85;
      }
      if (change === "aspect") shot.setup.output.aspectRatio = 1;
      if (change === "pose") shot.keyframes[0]!.pose.position[0] = 4;
      if (change === "scene")
        next.scenes[0]!.scene.asset.locator = {
          kind: "remote",
          url: "https://example.com/different.spz",
        };
      if (change === "scene") {
        await expect(store.put(next)).rejects.toThrow("immutable");
        expect((await store.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeDefined();
        return;
      }
      await store.put(next);
      expect((await store.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
      const db = await openDB(name);
      expect(await db.count("shotImages")).toBe(1);
      db.close();
    },
  );

  it("preserves corrupt frame bytes for explicit recovery and replaces them on recapture", async () => {
    const { store } = setup();
    const original = project();
    original.scenes[0]!.shots[0]!.thumbnailDataUrl = "data:image/jpeg;base64,corrupt";
    await store.put(original);
    expect((await store.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toContain("corrupt");
    original.scenes[0]!.shots[0]!.thumbnailDataUrl = "data:image/jpeg;base64,recaptured";
    await store.put(original);
    expect((await store.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toContain("recaptured");
  });

  it("does not bind an unchanged hydrated old image to a newly edited camera", async () => {
    const { store } = setup();
    await store.put(project());
    const edited = (await store.get("p"))!;
    edited.scenes[0]!.shots[0]!.setup.output.aspectRatio = 1;
    await store.put(edited);
    expect((await store.get("p"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeUndefined();
    expect((await store.get("p"))?.scenes[0]!.shots[1]?.thumbnailDataUrl).toBeDefined();
  });

  it("cleans only removed shots and leaves images belonging to another project intact", async () => {
    const { name, store } = setup();
    await store.put(project("one"));
    await store.put(project("two"));
    const shortened = project("one");
    shortened.scenes[0]!.shots = shortened.scenes[0]!.shots.slice(1);
    await store.put(metadataOnly(shortened));
    const db = await openDB(name);
    expect(await db.count("shotImages")).toBe(3);
    await store.delete("one");
    expect(await db.count("shotImages")).toBe(2);
    expect((await store.get("two"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBeDefined();
    const restoredMetadata = metadataOnly(project("one"));
    await store.put(restoredMetadata);
    expect(
      (await store.get("one"))?.scenes[0]!.shots.every(
        (shot) => shot.thumbnailDataUrl === undefined,
      ),
    ).toBe(true);
    db.close();
  });

  it("aborts a stale account transaction without importing its remote images", async () => {
    const { store } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.commitSync(
        { id: "p", revision: 0 },
        {
          kind: "remote",
          ownerUid: "old-user",
          project: project(),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.get("p")).toBeUndefined();
  });
});

describe("shot-sheet selection persistence", () => {
  it("normalizes duplicate and deleted exclusions while preserving shot array order", async () => {
    const { store } = setup();
    const input = project();
    input.scenes[0]!.shots.reverse();
    input.shotSheet = { version: 1, excludedShotIds: ["s1", "gone", "s1"] };
    await store.put(input);
    const saved = (await store.get("p"))!;
    expect(saved.scenes[0]!.shots.map(({ id }) => id)).toEqual(["s2", "s1"]);
    expect(saved.shotSheet).toEqual({ version: 1, excludedShotIds: ["s1"] });
    expect(input.shotSheet.excludedShotIds).toEqual(["s1", "gone", "s1"]);
  });

  it("preserves older projects without requiring new settings and rejects future selection versions", () => {
    expect(validateProject(project()).shotSheet).toBeUndefined();
    expect(() =>
      validateProject({ ...project(), shotSheet: { version: 2, excludedShotIds: [] } }),
    ).toThrow("shotSheet");
    expect(() =>
      validateProject({ ...project(), shotSheet: { version: 1, excludedShotIds: [42] } }),
    ).toThrow("shotSheet");
  });
});
