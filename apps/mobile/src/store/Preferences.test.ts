import { DEFAULT_APP_PREFERENCES, MAX_CAMERA_PRESETS } from "@oculo/scene-schema";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { describe, expect, it } from "vitest";
import { IndexedDBProjectStore } from "./ProjectStore";

const preset = (id: string, createdAt: number) => ({
  version: 1 as const,
  id,
  name: `Preset ${id}`,
  focalLengthMm: 50,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
  aspectRatio: 2.39,
  createdAt,
});

describe("device preferences and camera presets", () => {
  it("upgrades a v5 database additively and returns default preferences", async () => {
    const name = `prefs-${crypto.randomUUID()}`;
    const legacy = await openDB(name, 5, {
      upgrade(db) {
        db.createObjectStore("projects", { keyPath: "id" }).createIndex("by-updated", "updatedAt");
        db.createObjectStore("syncMeta", { keyPath: "id" });
      },
    });
    await legacy.put("syncMeta", { id: "kept", dirty: false, deleted: false });
    legacy.close();
    const store = new IndexedDBProjectStore(name);
    expect(await store.getPreferences()).toEqual(DEFAULT_APP_PREFERENCES);
    expect(await store.getSyncMeta("kept")).toBeDefined();
    await store.putPreferences({ ...DEFAULT_APP_PREFERENCES, gallerySort: "shots" });
    expect((await new IndexedDBProjectStore(name).getPreferences()).gallerySort).toBe("shots");
  });

  it("lists presets oldest first, replaces by id, and caps the count", async () => {
    const store = new IndexedDBProjectStore(`presets-${crypto.randomUUID()}`);
    await store.putCameraPreset(preset("b", 2));
    await store.putCameraPreset(preset("a", 1));
    await store.putCameraPreset({ ...preset("b", 2), name: "Renamed" });
    expect((await store.listCameraPresets()).map((p) => p.name)).toEqual(["Preset a", "Renamed"]);
    for (let index = 2; index < MAX_CAMERA_PRESETS; index += 1)
      await store.putCameraPreset(preset(`x${index}`, 10 + index));
    await expect(store.putCameraPreset(preset("over", 99))).rejects.toThrow("up to");
    await store.deleteCameraPreset("a");
    await store.putCameraPreset(preset("over", 99));
  });
});
