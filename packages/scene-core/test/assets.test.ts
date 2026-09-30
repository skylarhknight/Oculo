import { describe, expect, it, vi } from "vitest";
import { createAssetVersion, migrateScene } from "@oculo/scene-schema";
import { resolveSceneBytes } from "../src/assets";
describe("runtime asset resolution", () => {
  it("resolves a relative local locator at runtime and verifies bytes before rendering", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const scene = migrateScene({
      id: "room",
      name: "Room",
      source: "imported",
      splatUrl: "blob:expired",
    });
    scene.asset = await createAssetVersion(bytes, {
      format: { name: "spz", version: null },
      locator: { kind: "local", relativePath: "assets/version.spz" },
    });
    const resolve = vi.fn((_scene: typeof scene) => {
      void _scene;
      return "https://localhost/runtime/version";
    });
    const fetcher = vi.fn(async () => new Response(bytes));
    expect(await resolveSceneBytes(scene, resolve, undefined, fetcher as typeof fetch)).toEqual({
      fileBytes: bytes,
    });
    expect(resolve.mock.calls[0]?.[0]).toEqual(scene);
    expect(scene.asset.locator).toEqual({ kind: "local", relativePath: "assets/version.spz" });
    await expect(
      resolveSceneBytes(
        scene,
        resolve,
        undefined,
        (async () => new Response(new Uint8Array([1, 2, 4]))) as typeof fetch,
      ),
    ).rejects.toThrow("fingerprint");
  });
  it("does not invent a URL for missing assets or fetch after cancellation", async () => {
    const scene = migrateScene({
      id: "room",
      name: "Room",
      source: "imported",
      splatUrl: "blob:expired",
    });
    await expect(resolveSceneBytes(scene)).rejects.toThrow("unavailable");
    const controller = new AbortController();
    controller.abort();
    const resolver = vi.fn(() => "x");
    await expect(resolveSceneBytes(scene, resolver, controller.signal)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
});
