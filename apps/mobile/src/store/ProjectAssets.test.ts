import { migrated, shotFrom } from "../test/projectFixtures";
import { migrateScene } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";
import { DEFAULT_CAMERA, type Project } from "../types/project";
import { prepareSceneImport } from "../services/sceneImport";
import { spzFixture } from "../test/spzFixture";

function project(id: string, scene: Project["scenes"][number]["scene"]): Project {
  return migrated({
    sceneId: scene.id,
    assetVersionId: scene.asset.versionId,
    schemaVersion: 2,
    id,
    name: id,
    scene,
    updatedAt: 1,
    durationSeconds: 8,
    camera: structuredClone(DEFAULT_CAMERA),
    shots: [],
    path: {
      sceneId: scene.id,
      assetVersionId: scene.asset.versionId,
      id: "path",
      name: "Main path",
      keyframes: [],
    },
    settings: { showGrid: true, showSafeFrame: true, reduceMotion: false },
  });
}

function store() {
  return new IndexedDBProjectStore(`asset-test-${crypto.randomUUID()}`);
}
afterEach(() => vi.restoreAllMocks());

describe("durable scene assets and project management", () => {
  it("enforces the free slot atomically, rolls back rejected import bytes, and keeps existing work editable", async () => {
    let pro = false;
    const local = new IndexedDBProjectStore(`capacity-${crypto.randomUUID()}`, () =>
      pro ? Infinity : 1,
    );
    const first = await prepareSceneImport(spzFixture());
    const second = await prepareSceneImport(spzFixture());
    const results = await Promise.allSettled([
      local.putImportedProject(project("first", first.scene), first.asset),
      local.putImportedProject(project("second", second.scene), second.asset),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [saved] = await local.list();
    const rejected = saved!.id === "first" ? second : first;
    expect(await local.getSceneAsset(rejected.asset.id)).toBeUndefined();
    await expect(local.duplicateProject(saved!.id, "copy", "Copy")).rejects.toThrow("free project");
    pro = true;
    await local.duplicateProject(saved!.id, "copy", "Copy");
    pro = false;
    await local.put({ ...saved!, name: "Still editable" });
    expect((await local.get(saved!.id))?.name).toBe("Still editable");
    expect(await local.list()).toHaveLength(2);
    await local.delete("copy");
    await local.delete(saved!.id);
    await local.putImportedProject(project("replacement", rejected.scene), rejected.asset);
    expect(await local.list()).toHaveLength(1);
  });

  it("captures imported file identity and bytes before its first asynchronous write", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    const id = prepared.asset.id;
    const originalBytes = await prepared.asset.data.arrayBuffer();
    const pending = local.putImportedProject(project("snapshot", prepared.scene), prepared.asset);
    prepared.asset.id = "changed";
    prepared.asset.data = new Blob(["changed"]);
    prepared.asset.descriptor.filename = "changed.spz";
    await pending;
    expect(await (await local.getSceneAsset(id))?.arrayBuffer()).toEqual(originalBytes);
    expect(await local.getSceneAsset("changed")).toBeUndefined();
    expect((await local.get("snapshot"))?.scenes[0]!.scene.localAsset?.filename).toBe(
      "fixture.spz",
    );
  });
  it("atomically stores a real SPZ and reopens its bytes with project metadata offline", async () => {
    const name = `asset-restart-${crypto.randomUUID()}`;
    const original = new IndexedDBProjectStore(name);
    const prepared = await prepareSceneImport(spzFixture());
    const saved = project("import", prepared.scene);
    await original.putImportedProject(saved, prepared.asset);
    const reopened = new IndexedDBProjectStore(name);
    expect(await reopened.get("import")).toEqual(saved);
    expect(await (await reopened.getSceneAsset(prepared.asset.id))?.arrayBuffer()).toEqual(
      await prepared.asset.data.arrayBuffer(),
    );
    expect(await reopened.getSyncMeta("import")).toMatchObject({
      dirty: true,
      deleted: false,
      revision: 1,
    });
  });

  it("adds the asset store without losing version 3 projects or media", async () => {
    const name = `asset-migrate-${crypto.randomUUID()}`;
    const legacy = await openDB(name, 3, {
      upgrade(db) {
        db.createObjectStore("projects", { keyPath: "id" }).createIndex("by-updated", "updatedAt");
        db.createObjectStore("syncMeta", { keyPath: "id" });
        db.createObjectStore("shotImages", { keyPath: "key" }).createIndex(
          "by-project",
          "projectId",
        );
      },
    });
    const saved = project(
      "legacy",
      migrateScene({
        id: "bundled",
        name: "Garden",
        source: "bundled",
        splatUrl: "/garden.spz",
      }),
    );
    await legacy.put("projects", saved);
    await legacy.put("syncMeta", { id: "legacy", dirty: true, deleted: false, revision: 7 });
    legacy.close();
    const migrated = new IndexedDBProjectStore(name);
    expect(await migrated.get("legacy")).toEqual(saved);
    expect((await migrated.getSyncMeta("legacy"))?.revision).toBe(7);
    const prepared = await prepareSceneImport(spzFixture());
    await migrated.putImportedProject(project("import", prepared.scene), prepared.asset);
    expect(await migrated.getSceneAsset(prepared.asset.id)).toBeDefined();
  });

  it("duplicates local frames and metadata while retaining a single immutable shared scene", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    const saved = project("original", prepared.scene);
    saved.scenes[0]!.shots = [
      shotFrom({
        assetVersionId: prepared.scene.asset.versionId,
        id: "shot",
        name: "View",
        sceneId: prepared.scene.id,
        camera: DEFAULT_CAMERA,
        createdAt: "2026-09-11T01:00:00Z",
        thumbnailDataUrl: "data:image/jpeg;base64,fixture",
      }),
    ];
    await local.putImportedProject(saved, prepared.asset, undefined, "owner-a");
    const copy = await local.duplicateProject("original", "copy", "Location copy", "owner-b");
    expect(copy.scenes[0]!.scene.localAsset?.id).toBe(prepared.asset.id);
    expect(copy.scenes[0]!.shots).toEqual(saved.scenes[0]!.shots);
    expect(await local.getSyncMeta("copy")).toMatchObject({
      ownerUid: "owner-a",
      dirty: true,
      revision: 1,
    });
    await local.delete("original");
    expect((await local.get("copy"))?.scenes[0]!.shots[0]?.thumbnailDataUrl).toBe(
      saved.scenes[0]!.shots[0]?.thumbnailDataUrl,
    );
    expect(await local.getSceneAsset(prepared.asset.id)).toBeDefined();
    await local.delete("copy");
    expect(await local.getSceneAsset(prepared.asset.id)).toBeUndefined();
    expect(await local.getSyncMeta("original")).toMatchObject({ deleted: true, dirty: true });
  });

  it("refuses asset replacement and collects bytes only after the last project is deleted", async () => {
    const local = store();
    const first = await prepareSceneImport(spzFixture());
    const second = await prepareSceneImport(spzFixture({ version: 3 }));
    await local.putImportedProject(project("one", first.scene), first.asset);
    await local.duplicateProject("one", "two", "Two");
    await expect(
      local.putImportedProject(project("one", second.scene), second.asset),
    ).rejects.toThrow("immutable");
    expect(await local.getSceneAsset(second.asset.id)).toBeUndefined();
    await local.delete("one");
    expect(await local.getSceneAsset(first.asset.id)).toBeDefined();
    await local.delete("two");
    expect(await local.getSceneAsset(first.asset.id)).toBeUndefined();
  });

  it("protects shared bytes against accidental replacement and duplicate IDs", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    await local.putImportedProject(project("one", prepared.scene), prepared.asset);
    await expect(
      local.putImportedProject(project("two", prepared.scene), prepared.asset),
    ).rejects.toThrow("already stored");
    await expect(local.duplicateProject("one", "one", "Copy")).rejects.toThrow("already in use");
    await expect(local.duplicateProject("missing", "new", "Copy")).rejects.toThrow(
      "no longer exists",
    );
    expect(await local.get("two")).toBeUndefined();
    expect(await local.getSceneAsset(prepared.asset.id)).toBeDefined();
  });

  it("aborts between asset and project writes with no orphan asset or partial revision", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    const controller = new AbortController();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = put.apply(this, args);
      if (this.name === "sceneAssets")
        request.addEventListener("success", () => controller.abort());
      return request;
    });
    await expect(
      local.putImportedProject(project("one", prepared.scene), prepared.asset, controller.signal),
    ).rejects.toThrow();
    expect(await local.get("one")).toBeUndefined();
    expect(await local.getSceneAsset(prepared.asset.id)).toBeUndefined();
    expect(await local.getSyncMeta("one")).toBeUndefined();
  });

  it("rolls back an imported Blob on a quota/write failure and permits retry", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "projects") throw new DOMException("Storage is full", "QuotaExceededError");
      return put.apply(this, args);
    });
    await expect(
      local.putImportedProject(project("one", prepared.scene), prepared.asset),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    spy.mockRestore();
    expect(await local.getSceneAsset(prepared.asset.id)).toBeUndefined();
    expect(await local.get("one")).toBeUndefined();
    await local.putImportedProject(project("one", prepared.scene), prepared.asset);
    expect(await local.get("one")).toBeDefined();
  });

  it("keeps ownership, dirty revision, and shared scene protection during remote deletions", async () => {
    const local = store();
    const prepared = await prepareSceneImport(spzFixture());
    await local.putImportedProject(
      project("one", prepared.scene),
      prepared.asset,
      undefined,
      "owner",
    );
    await local.duplicateProject("one", "two", "Copy");
    const [snapshot] = await local.listSyncSnapshots();
    expect(
      await local.commitSync(
        snapshot!,
        { kind: "acknowledge", ownerUid: "owner" },
        new AbortController().signal,
      ),
    ).toBe(true);
    const next = (await local.listSyncSnapshots()).find((item) => item.id === snapshot!.id)!;
    expect(
      await local.commitSync(
        next,
        { kind: "delete", ownerUid: "owner" },
        new AbortController().signal,
      ),
    ).toBe(true);
    expect(await local.getSceneAsset(prepared.asset.id)).toBeDefined();
  });
});
