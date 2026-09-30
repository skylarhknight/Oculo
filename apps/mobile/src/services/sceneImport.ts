import { BUNDLED_DESCRIPTORS } from "../config/sceneCatalog";
import { getCameraFraming } from "@oculo/camera-core";
import {
  migrateScene,
  createAssetVersion,
  verifyAssetBytes,
  type CameraPose,
  type CinematicCamera,
  type SceneDescriptor,
} from "@oculo/scene-schema";
import type { IndexedDBProjectStore, StoredSceneAsset } from "../store/ProjectStore";
import { cloneCamera, DEFAULT_CAMERA } from "../types/project";

export const MAX_SCENE_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_SCENE_SPLATS = 1_000_000;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
export type SceneOrientation = "original" | "flip-y" | "rotate-left" | "rotate-right";
export type SceneImportProgress = { phase: "validating" | "ready"; fraction: number };
export type PreparedSceneImport = {
  scene: SceneDescriptor;
  camera: CinematicCamera;
  asset: StoredSceneAsset;
};
export type ResolvedSceneAsset = { scene: SceneDescriptor; url?: string; release: () => void };

export function sceneOrientationQuaternion(
  orientation: SceneOrientation,
): CameraPose["quaternion"] {
  switch (orientation) {
    case "flip-y":
      return [1, 0, 0, 0];
    case "rotate-left":
      return [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    case "rotate-right":
      return [0, 0, -Math.SQRT1_2, Math.SQRT1_2];
    default:
      return [0, 0, 0, 1];
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Scene import canceled", "AbortError");
}

/** SPZ v2/v3 layout follows https://github.com/nianticlabs/spz/blob/main/src/cc/load-spz.cc.
 * Decompression is streamed and bounded before storing anything. We reject newer
 * versions/extensions rather than accepting a scene the installed decoder cannot read.
 */
export async function validateSpz(
  file: Blob,
  options: { signal?: AbortSignal; onProgress?: (progress: SceneImportProgress) => void } = {},
): Promise<{
  numSplats: number;
  center: [number, number, number];
  radius: number;
  version: number;
}> {
  const { signal, onProgress } = options;
  abortIfNeeded(signal);
  if (file.size === 0) throw new Error("The scene file is empty");
  if (file.size > MAX_SCENE_IMPORT_BYTES) throw new Error("Choose an SPZ file smaller than 64 MB");
  if (typeof DecompressionStream === "undefined")
    throw new Error(
      "This device cannot decompress SPZ files. Update the app or browser and try again.",
    );
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  abortIfNeeded(signal);
  if (magic[0] === 0x4e && magic[1] === 0x47)
    throw new Error("This SPZ version is not supported yet. Export an SPZ version 2 or 3 file.");
  if (magic[0] !== 0x1f || magic[1] !== 0x8b)
    throw new Error("This file is not a gzip-compressed SPZ scene");

  let compressedRead = 0;
  const progress = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      abortIfNeeded(signal);
      compressedRead += chunk.length;
      onProgress?.({
        phase: "validating",
        fraction: Math.min(0.95, (compressedRead / file.size) * 0.95),
      });
      controller.enqueue(chunk);
    },
  });
  const reader = file
    .stream()
    .pipeThrough(progress)
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const header = new Uint8Array(16);
  let headerBytes = 0;
  let decodedBytes = 0;
  let expectedBytes: number | undefined;
  let numSplats = 0;
  let version = 0;
  let fractionalBits = 0;
  const minima = [Infinity, Infinity, Infinity];
  const maxima = [-Infinity, -Infinity, -Infinity];
  let coordinate = 0;
  let coordinateBytes = 0;
  let coordinateValue = 0;
  let maxScale = 0;
  try {
    onProgress?.({ phase: "validating", fraction: 0 });
    while (true) {
      abortIfNeeded(signal);
      const { value, done } = await reader.read();
      abortIfNeeded(signal);
      if (done) break;
      const chunkStart = decodedBytes;
      decodedBytes += value.length;
      if (decodedBytes > MAX_DECODED_BYTES)
        throw new Error("The decompressed scene exceeds the 128 MB limit");
      if (headerBytes < 16) {
        const copied = Math.min(16 - headerBytes, value.length);
        header.set(value.subarray(0, copied), headerBytes);
        headerBytes += copied;
        if (headerBytes === 16) {
          const view = new DataView(header.buffer);
          if (view.getUint32(0, true) !== 0x5053474e) throw new Error("The SPZ header is invalid");
          version = view.getUint32(4, true);
          if (version !== 2 && version !== 3)
            throw new Error("Only SPZ versions 2 and 3 are supported");
          numSplats = view.getUint32(8, true);
          if (numSplats === 0) throw new Error("The scene contains no splats");
          if (numSplats > MAX_SCENE_SPLATS)
            throw new Error("The scene exceeds the 1,000,000 splat limit");
          const degree = header[12]!;
          fractionalBits = header[13]!;
          if (degree > 3 || fractionalBits > 24 || (header[14]! & ~1) !== 0 || header[15] !== 0)
            throw new Error("The SPZ header uses unsupported attributes or extensions");
          const shBytes = ((degree + 1) ** 2 - 1) * 3;
          expectedBytes = 16 + numSplats * (9 + 1 + 3 + 3 + (version === 3 ? 4 : 3) + shBytes);
          if (expectedBytes > MAX_DECODED_BYTES)
            throw new Error("The decompressed scene exceeds the 128 MB limit");
        }
      }
      if (expectedBytes !== undefined) {
        if (decodedBytes > expectedBytes)
          throw new Error("The SPZ file contains unexpected trailing data");
        // Read fixed-point positions across arbitrary stream boundaries without
        // retaining a second decompressed copy of the whole scene.
        const start = Math.max(0, 16 - chunkStart);
        const end = Math.min(value.length, 16 + numSplats * 9 - chunkStart);
        for (let offset = start; offset < end; offset += 1) {
          coordinateValue |= value[offset]! << (coordinateBytes * 8);
          coordinateBytes += 1;
          if (coordinateBytes === 3) {
            const signed = (coordinateValue << 8) >> 8;
            const position = signed / 2 ** fractionalBits;
            const axis = coordinate % 3;
            minima[axis] = Math.min(minima[axis]!, position);
            maxima[axis] = Math.max(maxima[axis]!, position);
            coordinate += 1;
            coordinateBytes = 0;
            coordinateValue = 0;
          }
        }
        const scalesStart = Math.max(0, 16 + numSplats * 13 - chunkStart);
        const scalesEnd = Math.min(value.length, 16 + numSplats * 16 - chunkStart);
        for (let offset = scalesStart; offset < scalesEnd; offset += 1)
          maxScale = Math.max(maxScale, Math.exp(value[offset]! / 16 - 10));
      }
    }
    if (expectedBytes === undefined || decodedBytes !== expectedBytes)
      throw new Error("The SPZ file is truncated or its point count is incorrect");
    const center = minima.map((min, axis) => (min + maxima[axis]!) / 2) as [number, number, number];
    // Include three standard deviations of the largest Gaussian, so a sparse
    // file with large splats is not framed as if its centers were tiny points.
    const radius = Math.hypot(...maxima.map((max, axis) => max - center[axis]!)) + 3 * maxScale;
    return { numSplats, center, radius, version };
  } catch (error) {
    abortIfNeeded(signal);
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new Error("The SPZ file is damaged or incomplete. Export it again and retry.", {
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function prepareSceneImport(
  file: File,
  options: {
    name?: string;
    orientation?: SceneOrientation;
    provenance?: Partial<SceneDescriptor["provenance"]>;
    signal?: AbortSignal;
    onProgress?: (progress: SceneImportProgress) => void;
  } = {},
): Promise<PreparedSceneImport> {
  if (!/\.spz$/i.test(file.name)) throw new Error("Choose a .spz Gaussian splat file");
  const bounds = await validateSpz(file, options);
  abortIfNeeded(options.signal);
  const id = crypto.randomUUID();
  const filename = file.name
    .split(/[\\/]/)
    .at(-1)!
    .split("")
    .filter((character) => character.charCodeAt(0) > 31)
    .join("")
    .slice(0, 255);
  const descriptor = {
    version: 1 as const,
    id,
    filename,
    format: "spz" as const,
    byteLength: file.size,
  };
  const orientation = options.orientation ?? "original";
  const [x, y, z] = bounds.center;
  const center: [number, number, number] =
    orientation === "flip-y"
      ? [x, -y, -z]
      : orientation === "rotate-left"
        ? [-y, x, z]
        : orientation === "rotate-right"
          ? [y, -x, z]
          : [x, y, z];
  const camera = cloneCamera(DEFAULT_CAMERA);
  const framing = getCameraFraming(camera);
  const verticalHalfFov = (framing.verticalFovDegrees * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * framing.aspectRatio);
  const distance = Math.max(
    3,
    (bounds.radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * 1.05,
  );
  camera.pose = {
    position: [center[0], center[1], center[2] + distance],
    quaternion: [0, 0, 0, 1],
  };
  camera.near = Math.max(DEFAULT_CAMERA.near, distance / 10_000);
  camera.far = Math.max(DEFAULT_CAMERA.far, distance + bounds.radius * 2);
  const scene: SceneDescriptor = migrateScene({
    id: `import-${id}`,
    name: options.name?.trim() || filename.replace(/\.spz$/i, ""),
    splatUrl: `oculo-asset:${id}`,
    localAsset: descriptor,
    source: "imported",
    splatQuaternion: sceneOrientationQuaternion(orientation),
    initialCameraPose: structuredClone(camera.pose),
  });
  scene.asset = await createAssetVersion(new Uint8Array(await file.arrayBuffer()), {
    format: { name: "spz", version: String(bounds.version) },
    locator: { kind: "local", relativePath: `scene-assets/${id}.spz` },
  });
  scene.provenance = {
    kind: options.provenance?.kind ?? "unknown",
    sourceApp: options.provenance?.sourceApp?.trim() || null,
    sourceName: scene.name,
    importedAt: new Date().toISOString(),
    attribution: options.provenance?.attribution?.trim() || null,
  };
  if (scene.provenance.attribution) scene.attribution = { text: scene.provenance.attribution };
  options.onProgress?.({ phase: "ready", fraction: 1 });
  abortIfNeeded(options.signal);
  return {
    scene,
    camera,
    asset: { id, descriptor, data: file.slice(0, file.size, "application/octet-stream") },
  };
}

export async function resolveSceneAsset(
  scene: SceneDescriptor,
  store: Pick<IndexedDBProjectStore, "getSceneAsset"> &
    Partial<Pick<IndexedDBProjectStore, "getGalleryAsset">>,
  signal?: AbortSignal,
): Promise<ResolvedSceneAsset> {
  abortIfNeeded(signal);
  if (!scene.localAsset && scene.asset.locator.kind !== "local") {
    // A gallery scene downloaded earlier opens from this device, and offline.
    const cached = await store.getGalleryAsset?.(scene.asset.versionId);
    abortIfNeeded(signal);
    if (cached && cached.byteSize === cached.data.size) {
      const url = URL.createObjectURL(cached.data);
      let released = false;
      return {
        scene,
        url,
        release() {
          if (!released) URL.revokeObjectURL(url);
          released = true;
        },
      };
    }
  }
  if (!scene.localAsset) {
    // Older bundled projects had only a root-relative URL, which contracts migrate
    // as unavailable. Resolve the installed starter without changing saved identity.
    const bundled =
      scene.source === "bundled" && scene.asset.locator.kind === "unavailable"
        ? BUNDLED_DESCRIPTORS.find((descriptor) => descriptor.id === scene.id)
        : undefined;
    const locator = bundled?.asset.locator;
    return {
      scene,
      ...(locator?.kind === "local" ? { url: `/${locator.relativePath}` } : {}),
      release: () => undefined,
    };
  }
  const data = await store.getSceneAsset(scene.localAsset.id);
  abortIfNeeded(signal);
  if (!data)
    throw new Error(
      `The scene file “${scene.localAsset.filename}” is missing on this device. Import the original file to create a new project for this location. Existing shots and shot sheets are still available.`,
    );
  if (data.size !== scene.localAsset.byteLength)
    throw new Error("The saved scene file is incomplete. Import the original file again.");
  await verifyAssetBytes(scene.asset, new Uint8Array(await data.arrayBuffer()));
  abortIfNeeded(signal);
  const url = URL.createObjectURL(data);
  let released = false;
  return {
    scene,
    url,
    release() {
      if (!released) URL.revokeObjectURL(url);
      released = true;
    },
  };
}
