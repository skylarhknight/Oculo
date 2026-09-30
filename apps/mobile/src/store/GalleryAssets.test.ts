import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";

const asset = (versionId: string) => ({
  versionId,
  sceneId: "moon",
  sha256: "a".repeat(64),
  byteSize: 3,
  savedAt: 1,
  data: new Blob([new Uint8Array([1, 2, 3])]),
});

describe("downloaded gallery scenes", () => {
  it("upgrades a v6 database additively and keeps existing data", async () => {
    const name = `gallery-${crypto.randomUUID()}`;
    const legacy = await openDB(name, 6, {
      upgrade(db) {
        db.createObjectStore("projects", { keyPath: "id" }).createIndex("by-updated", "updatedAt");
        db.createObjectStore("syncMeta", { keyPath: "id" });
        db.createObjectStore("preferences", { keyPath: "key" });
      },
    });
    await legacy.put("syncMeta", { id: "kept", dirty: false, deleted: false });
    legacy.close();
    const store = new IndexedDBProjectStore(name);
    expect(await store.listGalleryAssets()).toEqual([]);
    expect(await store.getSyncMeta("kept")).toBeDefined();
  });

  it("stores, lists without bytes, and removes a download", async () => {
    const store = new IndexedDBProjectStore(`gallery-${crypto.randomUUID()}`);
    await store.putGalleryAsset(asset("moon-v1"));
    expect((await store.getGalleryAsset("moon-v1"))?.data.size).toBe(3);
    expect(await store.listGalleryAssets()).toEqual([
      { versionId: "moon-v1", sceneId: "moon", sha256: "a".repeat(64), byteSize: 3, savedAt: 1 },
    ]);
    await store.deleteGalleryAsset("moon-v1");
    expect(await store.getGalleryAsset("moon-v1")).toBeUndefined();
  });
});
