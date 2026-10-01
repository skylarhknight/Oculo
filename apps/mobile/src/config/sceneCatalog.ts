import {
  CANONICAL_COORDINATES,
  SceneDescriptorSchema,
  identityTransform,
  type SceneDescriptor,
} from "@oculo/scene-schema";
import { DEMO_SCENES } from "./demoScenes";
import generated from "./sceneCatalog.generated.json";
import sceneHosting from "./sceneHosting.json";

/** Built by `pnpm scenes:build` (tools/scenes/build.mjs); one entry per gallery scene. */
interface GeneratedScene {
  id: string;
  superSplatId: string;
  title: string;
  author: string;
  bundled: boolean;
  fileName: string;
  byteSize: number;
  sha256: string;
  splatCount: number;
  camera: { position: number[]; target: number[]; fov: number; quaternion: number[] };
  source: { count: number; streamedLevel: number | null } | null;
  /** Map figure eye height in scene units, measured for scenes without a known metric scale. */
  mapEyeHeight?: number;
}

export const SCENE_LICENSE = {
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export interface SceneCredit {
  author: string;
  authorUrl: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  /** What Oculo changed, as CC BY asks. */
  changes: string;
}

export interface GalleryScene {
  id: string;
  title: string;
  /** Bundled scenes open offline; download scenes are fetched once, on a tap. */
  availability: "bundled" | "download";
  thumbnail: string;
  splatCount: number;
  byteSize: number;
  credit: SceneCredit;
  descriptor: SceneDescriptor;
}

/**
 * Where download scenes are hosted. The host must allow cross-origin GETs (the app runs
 * at capacitor://localhost). `pnpm scenes:upload` pins sceneHosting.json to one commit
 * of a public Hugging Face dataset; VITE_SCENE_GALLERY_BASE_URL overrides it (a local
 * server while testing). Without either, download scenes are listed as unavailable.
 */
export const SCENE_GALLERY_BASE_URL = (() => {
  const configured = (import.meta.env.VITE_SCENE_GALLERY_BASE_URL as string | undefined)?.trim();
  const hosted = (sceneHosting as { baseUrl: string | null }).baseUrl?.trim();
  const value = configured || hosted;
  return value && /^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : null;
})();

const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

// SuperSplat's viewer turns SOG scenes 180° about Z; its published cameras assume it.
const SUPERSPLAT_ROTATION: [number, number, number, number] = [0, 0, 1, 0];

function changesFor(scene: GeneratedScene): string {
  if (!scene.source) return "Packaged into a single SOG file; content unchanged.";
  const millions = (count: number) => `${(count / 1e6).toFixed(1)}M`;
  return `Reduced from ${millions(scene.source.count)} to ${millions(scene.splatCount)} splats and re-encoded for iPhone.`;
}

function descriptorFor(scene: GeneratedScene, credit: SceneCredit): SceneDescriptor {
  const locator = scene.bundled
    ? { kind: "local", relativePath: `scenes/${scene.id}/${scene.fileName}` }
    : SCENE_GALLERY_BASE_URL
      ? { kind: "remote", url: `${SCENE_GALLERY_BASE_URL}/${scene.fileName}` }
      : { kind: "unavailable" };
  const text = `${scene.title} — ${credit.author} · ${credit.license}. ${credit.changes}`;
  return SceneDescriptorSchema.parse({
    id: scene.id,
    name: scene.title,
    asset: {
      versionId: `gallery-${scene.id}-${scene.sha256.slice(0, 12)}`,
      fingerprint: { status: "verified", algorithm: "sha256", digest: scene.sha256 },
      format: { name: "sog", version: null },
      byteSize: scene.byteSize,
      locator,
    },
    attribution: {
      text,
      url: credit.sourceUrl,
      license: credit.license,
      licenseUrl: credit.licenseUrl,
    },
    coordinates: CANONICAL_COORDINATES,
    assetToScene: { ...identityTransform(), rotation: SUPERSPLAT_ROTATION },
    sourceCoordinates: {
      convention: "SuperSplat SOG",
      conversion: "Rotated 180° about Z, as the SuperSplat viewer loads SOG scenes",
    },
    metricScale: { status: "unknown" },
    provenance: {
      kind: "captured",
      sourceApp: "SuperSplat",
      sourceName: scene.title,
      importedAt: null,
      attribution: text,
    },
    initialCameraPose: { position: scene.camera.position, quaternion: scene.camera.quaternion },
    source: scene.bundled ? "bundled" : "remote",
  });
}

function galleryScene(scene: GeneratedScene): GalleryScene {
  const credit: SceneCredit = {
    author: scene.author,
    authorUrl: `https://superspl.at/user/${scene.author}`,
    sourceUrl: `https://superspl.at/scene/${scene.superSplatId}`,
    license: SCENE_LICENSE.name,
    licenseUrl: SCENE_LICENSE.url,
    changes: changesFor(scene),
  };
  // The original starter keeps its saved identity so existing projects still bind.
  const starter = DEMO_SCENES.find((demo) => demo.descriptor.id === scene.id);
  return {
    id: scene.id,
    title: scene.title,
    availability: scene.bundled ? "bundled" : "download",
    thumbnail: asset(`scenes/${scene.id}/thumb.webp`),
    splatCount: scene.splatCount,
    byteSize: scene.byteSize,
    credit,
    descriptor: starter?.descriptor ?? descriptorFor(scene, credit),
  };
}

/** Bundled scenes first, then downloads, each in catalog order. */
export const SCENE_GALLERY: readonly GalleryScene[] = (generated as GeneratedScene[])
  .map(galleryScene)
  .sort((a, b) => Number(b.availability === "bundled") - Number(a.availability === "bundled"));

/** The current build's descriptor for a gallery or starter scene, if it is one. */
export function catalogDescriptor(sceneId: string): SceneDescriptor | undefined {
  return (
    SCENE_GALLERY.find((scene) => scene.id === sceneId)?.descriptor ??
    DEMO_SCENES.find((demo) => demo.descriptor.id === sceneId)?.descriptor
  );
}

/** Scenes whose bytes ship inside the app. */
export const BUNDLED_DESCRIPTORS: readonly SceneDescriptor[] = SCENE_GALLERY.filter(
  (scene) => scene.availability === "bundled",
).map((scene) => scene.descriptor);

export const downloadAvailable = (scene: GalleryScene) =>
  scene.availability === "bundled" || scene.descriptor.asset.locator.kind === "remote";

/**
 * The map figure's eye height for a gallery scene, in scene units, when the catalog has a
 * measured one. A display hint only: it is not part of the scene binding or any export.
 */
export function galleryEyeHeight(sceneId: string): number | undefined {
  return (generated as GeneratedScene[]).find((scene) => scene.id === sceneId)?.mapEyeHeight;
}
