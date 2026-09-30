import { fingerprintBytes } from "@oculo/scene-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENE_GALLERY, type GalleryScene } from "../config/sceneCatalog";
import type { GalleryAsset } from "../store/ProjectStore";
import { SceneDownloadError, downloadGalleryScene } from "./sceneAssetCache";

const bytes = new Uint8Array([7, 8, 9, 10, 11]);

async function remoteScene(): Promise<GalleryScene> {
  const base = SCENE_GALLERY.find((scene) => scene.availability === "download")!;
  const descriptor = structuredClone(base.descriptor);
  descriptor.asset = {
    ...descriptor.asset,
    fingerprint: { status: "verified", algorithm: "sha256", digest: await fingerprintBytes(bytes) },
    byteSize: bytes.byteLength,
    locator: { kind: "remote", url: "https://scenes.example/moon.sog" },
  };
  return { ...base, byteSize: bytes.byteLength, descriptor };
}

function repository() {
  const rows = new Map<string, GalleryAsset>();
  return {
    rows,
    getGalleryAsset: async (id: string) => rows.get(id),
    putGalleryAsset: async (asset: GalleryAsset) => {
      rows.set(asset.versionId, asset);
    },
  };
}

function streamed(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("gallery scene downloads", () => {
  it("streams with progress, verifies, keeps the file, and never fetches it twice", async () => {
    const scene = await remoteScene();
    const repo = repository();
    const fetch = vi.fn(async () => streamed([bytes.slice(0, 2), bytes.slice(2)]));
    vi.stubGlobal("fetch", fetch);
    const progress: number[] = [];
    const data = await downloadGalleryScene(scene, repo, {
      onProgress: ({ loaded }) => progress.push(loaded),
    });
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(bytes);
    expect(progress).toEqual([0, 2, 5]);
    expect(repo.rows.get(scene.descriptor.asset.versionId)?.byteSize).toBe(5);
    await downloadGalleryScene(scene, repo);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses bytes that don't match the pinned hash and keeps nothing", async () => {
    const scene = await remoteScene();
    const repo = repository();
    vi.stubGlobal("fetch", async () => streamed([new Uint8Array([1, 2, 3, 4, 5])]));
    await expect(downloadGalleryScene(scene, repo)).rejects.toMatchObject({ code: "integrity" });
    expect(repo.rows.size).toBe(0);
  });

  it("reports an unavailable host and a failed request plainly", async () => {
    const unavailable = SCENE_GALLERY.find((scene) => scene.availability === "download")!;
    if (unavailable.descriptor.asset.locator.kind !== "remote")
      await expect(downloadGalleryScene(unavailable, repository())).rejects.toBeInstanceOf(
        SceneDownloadError,
      );
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await expect(downloadGalleryScene(await remoteScene(), repository())).rejects.toMatchObject({
      code: "network",
    });
  });
});
