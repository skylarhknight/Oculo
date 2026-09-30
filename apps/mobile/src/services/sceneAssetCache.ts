import { verifyAssetBytes } from "@oculo/scene-schema";
import type { GalleryScene } from "../config/sceneCatalog";
import type { GalleryAssetRepository } from "../store/ProjectStore";

export interface DownloadProgress {
  loaded: number;
  total: number;
}

export class SceneDownloadError extends Error {
  constructor(
    readonly code: "offline" | "unavailable" | "network" | "integrity",
    message: string,
  ) {
    super(message);
    this.name = "SceneDownloadError";
  }
}

/** A gallery scene's bytes, from this device when downloaded before. */
export async function cachedGalleryScene(
  scene: GalleryScene,
  repository: Pick<GalleryAssetRepository, "getGalleryAsset">,
): Promise<Blob | undefined> {
  const stored = await repository.getGalleryAsset(scene.descriptor.asset.versionId);
  return stored && stored.byteSize === stored.data.size ? stored.data : undefined;
}

/**
 * Downloads a gallery scene once, after the person taps it: streams it with progress,
 * checks its pinned SHA-256, and keeps it on the device for offline use. Nothing is
 * uploaded.
 */
export async function downloadGalleryScene(
  scene: GalleryScene,
  repository: Pick<GalleryAssetRepository, "getGalleryAsset" | "putGalleryAsset">,
  options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {},
): Promise<Blob> {
  const cached = await cachedGalleryScene(scene, repository);
  if (cached) return cached;
  const { asset } = scene.descriptor;
  if (asset.locator.kind !== "remote")
    throw new SceneDownloadError("unavailable", "This scene isn't available in this build.");
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    throw new SceneDownloadError("offline", "Connect to the internet to download this scene.");

  const total = asset.byteSize ?? scene.byteSize;
  let response: Response;
  try {
    response = await fetch(asset.locator.url, options.signal ? { signal: options.signal } : {});
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new SceneDownloadError("network", "Couldn't reach the scene library.");
  }
  if (!response.ok)
    throw new SceneDownloadError("network", `The scene library answered ${response.status}.`);

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  options.onProgress?.({ loaded, total });
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      options.onProgress?.({ loaded, total });
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    chunks.push(bytes);
    loaded = bytes.byteLength;
    options.onProgress?.({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    await verifyAssetBytes(asset, bytes);
  } catch {
    throw new SceneDownloadError("integrity", "The downloaded scene didn't match. Try again.");
  }
  const data = new Blob([bytes], { type: "application/octet-stream" });
  await repository.putGalleryAsset({
    versionId: asset.versionId,
    sceneId: scene.id,
    sha256: asset.fingerprint.status === "verified" ? asset.fingerprint.digest : "",
    byteSize: bytes.byteLength,
    savedAt: Date.now(),
    data,
  });
  return data;
}
