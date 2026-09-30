import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DESCRIPTORS,
  SCENE_GALLERY,
  SCENE_LICENSE,
  catalogDescriptor,
} from "./sceneCatalog";

const PUBLIC = join(__dirname, "../../public");

describe("scene gallery catalog", () => {
  it("credits every scene the way CC BY 4.0 asks", () => {
    expect(SCENE_GALLERY.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SCENE_GALLERY.map((scene) => scene.id)).size).toBe(SCENE_GALLERY.length);
    for (const { credit, descriptor } of SCENE_GALLERY) {
      expect(credit.author).not.toBe("");
      expect(credit.authorUrl).toMatch(/^https:\/\/superspl\.at\/user\//);
      expect(credit.sourceUrl).toMatch(/^https:\/\/superspl\.at\/scene\/[0-9a-f]{8}$/);
      expect(credit.license).toBe(SCENE_LICENSE.name);
      expect(credit.licenseUrl).toBe(SCENE_LICENSE.url);
      expect(credit.changes).not.toBe("");
      expect(descriptor.attribution?.licenseUrl).toBe(SCENE_LICENSE.url);
      expect(descriptor.asset.fingerprint.status).toBe("verified");
    }
  });

  it("stays within the mobile splat budget", () => {
    for (const scene of SCENE_GALLERY) expect(scene.splatCount).toBeLessThanOrEqual(1_000_000);
  });

  it("ships every bundled scene and thumbnail, byte for byte", () => {
    for (const scene of SCENE_GALLERY) {
      expect(existsSync(join(PUBLIC, `scenes/${scene.id}/thumb.webp`))).toBe(true);
      if (scene.availability !== "bundled") continue;
      const { locator, fingerprint, byteSize } = scene.descriptor.asset;
      if (locator.kind !== "local" || fingerprint.status !== "verified") throw new Error(scene.id);
      const file = join(PUBLIC, locator.relativePath);
      expect(statSync(file).size).toBe(byteSize);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(
        fingerprint.digest,
      );
    }
    expect(BUNDLED_DESCRIPTORS.map((scene) => scene.id)).toContain("small-garden");
  });

  it("keeps the original starter's identity for existing projects", () => {
    expect(catalogDescriptor("small-garden")?.asset.versionId).toBe("bundled-small-garden-v1");
    expect(catalogDescriptor("painted-bedroom")).toBeDefined();
    expect(catalogDescriptor("nope")).toBeUndefined();
  });
});
