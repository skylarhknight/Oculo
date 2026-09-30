import {
  AssetSchema,
  SceneDescriptorSchema,
  type SceneAsset,
  type SceneDescriptor,
} from "./contracts.js";

/** Hash the supplied original bytes without modifying them. File IO belongs to adapters. */
export async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function createAssetVersion(
  bytes: Uint8Array,
  metadata: Pick<SceneAsset, "format" | "locator">,
): Promise<SceneAsset> {
  return AssetSchema.parse({
    ...metadata,
    versionId: crypto.randomUUID(),
    byteSize: bytes.byteLength,
    fingerprint: { status: "verified", algorithm: "sha256", digest: await fingerprintBytes(bytes) },
  });
}
export async function verifyAssetBytes(asset: SceneAsset, bytes: Uint8Array): Promise<void> {
  AssetSchema.parse(asset);
  if (asset.byteSize !== null && asset.byteSize !== bytes.byteLength)
    throw new Error("Scene asset byte size changed; import as a new version");
  if (
    asset.fingerprint.status === "verified" &&
    asset.fingerprint.digest !== (await fingerprintBytes(bytes))
  )
    throw new Error("Scene asset fingerprint changed; import as a new version");
}
/** Locator changes/relinks are allowed; geometry, transforms and scale are not. */
export function sceneBindingSignature(input: SceneDescriptor): string {
  const s = SceneDescriptorSchema.parse(input);
  return JSON.stringify({
    sceneId: s.id,
    assetVersionId: s.asset.versionId,
    fingerprint: s.asset.fingerprint,
    byteSize: s.asset.byteSize,
    format: s.asset.format,
    ...(s.asset.fingerprint.status === "unknown" ? { unverifiedLocator: s.asset.locator } : {}),
    coordinates: s.coordinates,
    assetToScene: s.assetToScene,
    sourceCoordinates: s.sourceCoordinates,
    metricScale: s.metricScale,
  });
}
export function assertSameSceneBinding(before: SceneDescriptor, after: SceneDescriptor): void {
  if (sceneBindingSignature(before) !== sceneBindingSignature(after))
    throw new Error(
      "Scene binding is immutable; create a new asset version/project instead of rebinding saved cameras",
    );
}

/** Content identity is global to a version, even if multiple scenes use it. */
export function assetContentSignature(asset: SceneAsset): string {
  const a = AssetSchema.parse(asset);
  return JSON.stringify({
    versionId: a.versionId,
    fingerprint: a.fingerprint,
    format: a.format,
    byteSize: a.byteSize,
  });
}
