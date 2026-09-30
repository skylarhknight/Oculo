import {
  SceneDescriptorSchema,
  verifyAssetBytes,
  type SceneDescriptor,
} from "@oculo/scene-schema";

/** Runtime locator resolution; native filesystem details never enter domain records. */
export type AssetUrlResolver = (
  scene: SceneDescriptor,
  signal?: AbortSignal,
) => string | URL | Promise<string | URL>;
export function resolveRemoteAsset(scene: SceneDescriptor): string {
  if (scene.asset.locator.kind !== "remote")
    throw new Error(
      "Local scene asset is unavailable; provide a local asset resolver or relink the original file",
    );
  return scene.asset.locator.url;
}
export async function resolveSceneBytes(
  descriptor: SceneDescriptor,
  resolve: AssetUrlResolver = resolveRemoteAsset,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ url: string } | { fileBytes: Uint8Array }> {
  const scene = SceneDescriptorSchema.parse(descriptor);
  signal?.throwIfAborted();
  const url = String(await resolve(scene, signal));
  signal?.throwIfAborted();
  // Historical remote demos have no digest. Do not claim their bytes are pinned.
  if (scene.asset.fingerprint.status === "unknown") {
    if (scene.asset.locator.kind !== "remote")
      throw new Error("Local assets require a verified fingerprint");
    return { url };
  }
  const response = await fetcher(url, signal ? { signal } : {});
  if (!response.ok) throw new Error("Unable to read scene asset");
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyAssetBytes(scene.asset, bytes);
  signal?.throwIfAborted();
  return { fileBytes: bytes };
}
