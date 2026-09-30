import { SCENE_GALLERY } from "../config/sceneCatalog";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SCENE_IMPORT_BYTES,
  prepareSceneImport,
  resolveSceneAsset,
  validateSpz,
} from "./sceneImport";
import { spzFixture } from "../test/spzFixture";
import { getCameraFraming } from "@oculo/camera-core";

afterEach(() => vi.restoreAllMocks());

describe("SPZ import", () => {
  it.each([2, 3])(
    "validates actual gzip version %i bytes and computes a framing pose",
    async (version) => {
      const progress = vi.fn();
      const prepared = await prepareSceneImport(spzFixture({ version }), { onProgress: progress });
      expect(prepared.scene.initialCameraPose?.position.slice(0, 2)).toEqual([0, 0]);
      expect(prepared.camera.pose).toEqual(prepared.scene.initialCameraPose);
      expect(prepared.camera.pose.position[2]).toBeGreaterThan(3);
      expect(prepared.scene.asset.locator).toEqual({
        kind: "local",
        relativePath: `scene-assets/${prepared.asset.id}.spz`,
      });
      expect(prepared.scene.asset.format.version).toBe(String(version));
      expect(prepared.asset.data.size).toBe(prepared.scene.localAsset?.byteLength);
      expect(progress.mock.calls.at(-1)?.[0]).toEqual({ phase: "ready", fraction: 1 });
    },
  );

  it("records explicit provenance without inferring physical scale", async () => {
    const prepared = await prepareSceneImport(spzFixture(), {
      name: "Atrium",
      provenance: { kind: "generated", sourceApp: "World Labs", attribution: "Team scene" },
    });
    expect(prepared.scene.provenance).toMatchObject({
      kind: "generated",
      sourceApp: "World Labs",
      sourceName: "Atrium",
      attribution: "Team scene",
    });
    expect(prepared.scene.provenance.importedAt).toMatch(/^\d{4}-/);
  });

  it("validates the committed render fixture", async () => {
    const bytes = await readFile(new URL("../../test-fixtures/colored-wall.spz", import.meta.url));
    const result = await validateSpz(new Blob([bytes]));
    expect(result.numSplats).toBe(192);
    expect(result.radius).toBeGreaterThan(1);
  });

  it("fits a tall, huge SPZ inside both the output gate and expanded clipping planes", async () => {
    const file = spzFixture({
      fractionalBits: 0,
      positions: [
        [100, -2000, 0],
        [100, 2000, 0],
      ],
    });
    const { camera } = await prepareSceneImport(file);
    const framing = getCameraFraming(camera);
    const distance = camera.pose.position[2];
    const halfHeight = Math.tan((framing.verticalFovDegrees * Math.PI) / 360) * distance;
    expect(camera.pose.position.slice(0, 2)).toEqual([100, 0]);
    expect(halfHeight).toBeGreaterThan(2000);
    expect(camera.near).toBeLessThan(distance - 2000);
    expect(camera.far).toBeGreaterThan(distance + 2000);
    expect(camera.far).toBeGreaterThan(1000);
  });

  it("accounts for Gaussian size when a sparse scene has coincident centers", async () => {
    const file = spzFixture({ positions: [[0, 0, 0]], scaleByte: 240 });
    const { camera } = await prepareSceneImport(file);
    expect(camera.pose.position[2]).toBeGreaterThan(1000);
    expect(camera.far).toBeGreaterThan(camera.pose.position[2]);
  });

  it.each([
    ["original", [2, 3, 4]],
    ["flip-y", [2, -3, -4]],
    ["rotate-left", [-3, 2, 4]],
    ["rotate-right", [3, -2, 4]],
  ] as const)("frames the transformed center after orientation %s", async (orientation, center) => {
    const file = spzFixture({
      positions: [
        [1, 2, 3],
        [3, 4, 5],
      ],
    });
    const original = await prepareSceneImport(file);
    const rotated = await prepareSceneImport(file, { orientation });
    const distance = original.camera.pose.position[2] - 4;
    expect(rotated.camera.pose.position[0]).toBe(center[0]);
    expect(rotated.camera.pose.position[1]).toBe(center[1]);
    expect(rotated.camera.pose.position[2] - center[2]).toBeCloseTo(distance);
  });

  it.each([
    [{ count: 0 }, "no splats"],
    [{ version: 4 }, "versions 2 and 3"],
    [{ degree: 4 }, "unsupported attributes"],
    [{ fractionalBits: 31 }, "unsupported attributes"],
    [{ flags: 2 }, "unsupported attributes"],
    [{ magic: 0 }, "header is invalid"],
    [{ trailing: 1 }, "trailing data"],
    [{ truncate: 1 }, "truncated"],
  ])("rejects malformed or unsupported streams %j", async (options, message) => {
    await expect(validateSpz(spzFixture(options))).rejects.toThrow(message);
  });

  it("checks gzip integrity and detects truncated compressed data", async () => {
    const valid = spzFixture();
    const damaged = await valid.arrayBuffer();
    const corrupted = new Uint8Array(damaged);
    corrupted[damaged.byteLength - 8] = corrupted[damaged.byteLength - 8]! ^ 255;
    await expect(validateSpz(new Blob([damaged]))).rejects.toThrow();
    await expect(validateSpz(valid.slice(0, -5))).rejects.toThrow();
  });

  it("rejects empty, oversized, mislabeled, and newer plaintext files", async () => {
    await expect(validateSpz(new Blob())).rejects.toThrow("empty");
    const oversized = new Blob([new Uint8Array(MAX_SCENE_IMPORT_BYTES + 1)]);
    await expect(validateSpz(oversized)).rejects.toThrow("64 MB");
    await expect(prepareSceneImport(new File(["junk"], "scene.ply"))).rejects.toThrow(".spz");
    await expect(validateSpz(new Blob(["not a splat"]))).rejects.toThrow("not a gzip");
    await expect(validateSpz(new Blob(["NGSP"]))).rejects.toThrow("version is not supported");
  });

  it("rejects a point-count bomb from its header before decoding its declared arrays", async () => {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32LE(0x5053474e, 0);
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(1_000_001, 8);
    await expect(validateSpz(new Blob([gzipSync(bytes)]))).rejects.toThrow("1,000,000");
  });

  it("supports all orientation controls while keeping normalized quaternions", async () => {
    for (const orientation of ["original", "flip-y", "rotate-left", "rotate-right"] as const) {
      const result = await prepareSceneImport(spzFixture(), { orientation });
      expect(Math.hypot(...result.scene.assetToScene.rotation)).toBeCloseTo(1);
    }
  });

  it("cancels before work and during streamed validation without producing an asset", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareSceneImport(spzFixture(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const streaming = new AbortController();
    await expect(
      prepareSceneImport(spzFixture(), {
        signal: streaming.signal,
        onProgress: () => streaming.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves stored bytes without networking and releases temporary URLs once", async () => {
    const prepared = await prepareSceneImport(spzFixture());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const resolved = await resolveSceneAsset(prepared.scene, {
      getSceneAsset: async () => prepared.asset.data,
    });
    expect(resolved.url!).toMatch(/^blob:/);
    expect(prepared.scene.asset.locator.kind).toBe("local");
    expect(await (await fetch(resolved.url!)).arrayBuffer()).toEqual(
      await prepared.asset.data.arrayBuffer(),
    );
    resolved.release();
    resolved.release();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("opens a downloaded gallery scene from the device", async () => {
    const scene = SCENE_GALLERY.find((entry) => entry.availability === "download")!.descriptor;
    const data = new Blob([new Uint8Array([1, 2, 3])]);
    const resolved = await resolveSceneAsset(scene, {
      getSceneAsset: async () => undefined,
      getGalleryAsset: async (versionId) =>
        versionId === scene.asset.versionId
          ? { versionId, sceneId: scene.id, sha256: "", byteSize: 3, savedAt: 0, data }
          : undefined,
    });
    expect(resolved.url).toMatch(/^blob:/);
    resolved.release();
    const bundled = await resolveSceneAsset(SCENE_GALLERY[0]!.descriptor, {
      getSceneAsset: async () => undefined,
      getGalleryAsset: async () => undefined,
    });
    expect(bundled.url).toBeUndefined();
  });

  it("explains a missing or incomplete asset and suppresses canceled resolutions", async () => {
    const prepared = await prepareSceneImport(spzFixture());
    await expect(
      resolveSceneAsset(prepared.scene, { getSceneAsset: async () => undefined }),
    ).rejects.toThrow("missing on this device");
    await expect(
      resolveSceneAsset(prepared.scene, { getSceneAsset: async () => new Blob(["bad"]) }),
    ).rejects.toThrow("incomplete");
    const abort = new AbortController();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(
      resolveSceneAsset(
        prepared.scene,
        {
          getSceneAsset: async () => {
            abort.abort();
            return prepared.asset.data;
          },
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(createUrl).not.toHaveBeenCalled();
  });
});
