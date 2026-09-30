import { z } from "zod";
import {
  CinematicCameraSchema,
  PublicShotSchema,
  SceneDescriptorSchema,
  SceneWorkspaceSchema,
  type SceneWorkspace,
} from "./contracts.js";

const ExportSceneSchema = SceneDescriptorSchema.omit({
  asset: true,
  legacyMetadata: true,
  localAsset: true,
})
  .extend({
    asset: z
      .object({ ...SceneDescriptorSchema.shape.asset.shape })
      .omit({ locator: true })
      .strict(),
  })
  .strict();
export const ShotPlanExportSchema = z
  .object({
    schemaVersion: z.literal(3),
    type: z.literal("OculoShotPlan"),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        sceneId: z.string().min(1),
        assetVersionId: z.string().min(1),
        updatedAt: z.number().finite(),
        scene: ExportSceneSchema,
        camera: CinematicCameraSchema,
        shots: z.array(PublicShotSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ project: p }, ctx) => {
    for (const ref of [p, ...p.shots]) {
      if (ref.sceneId !== p.scene.id || ref.assetVersionId !== p.scene.asset.versionId)
        ctx.addIssue({
          code: "custom",
          message: "Export references do not match the scene version",
        });
    }
  });
export type ShotPlanExport = z.infer<typeof ShotPlanExportSchema>;
export function publicSourceLabel(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /^(?:blob|file|data):/i.test(trimmed) ||
    /^(?:[~/\\]|[a-z]:\\)/i.test(trimmed)
  )
    return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/(?:token|key|signature|credential|auth|secret|password)/i.test(name))
        url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    // A URL embedded inside a descriptive label may contain a private locator.
    if (/[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return null;
    return /[?&](?:token|key|signature|credential|auth|secret|password)=/i.test(trimmed)
      ? null
      : trimmed;
  }
}
export function exportShotPlan(input: SceneWorkspace): ShotPlanExport {
  const p = SceneWorkspaceSchema.parse(input);
  const { asset, legacyMetadata: _legacy, localAsset: _local, ...scene } = p.scene;
  const { locator: _locator, ...publicAsset } = asset;
  void _legacy;
  void _local;
  void _locator;
  return ShotPlanExportSchema.parse({
    schemaVersion: 3,
    type: "OculoShotPlan",
    project: {
      id: p.id,
      name: p.name,
      sceneId: p.sceneId,
      assetVersionId: p.assetVersionId,
      updatedAt: p.updatedAt,
      scene: {
        ...scene,
        asset: publicAsset,
        sourceCoordinates: {
          convention: publicSourceLabel(scene.sourceCoordinates.convention),
          conversion: publicSourceLabel(scene.sourceCoordinates.conversion),
        },
        metricScale:
          scene.metricScale.status === "known"
            ? {
                ...scene.metricScale,
                evidence: {
                  ...scene.metricScale.evidence,
                  description:
                    publicSourceLabel(scene.metricScale.evidence.description) ??
                    "Evidence retained locally",
                },
              }
            : scene.metricScale,
        provenance: {
          ...scene.provenance,
          sourceApp: publicSourceLabel(scene.provenance.sourceApp),
          sourceName: publicSourceLabel(scene.provenance.sourceName),
          attribution: publicSourceLabel(scene.provenance.attribution),
        },
      },
      camera: p.camera,
      shots: p.shots.map(({ thumbnailDataUrl: _thumbnail, ...shot }) => {
        void _thumbnail;
        return shot;
      }),
    },
  });
}
export const stringifyShotPlan = (p: SceneWorkspace): string =>
  JSON.stringify(exportShotPlan(p), null, 2);
export const parseShotPlan = (value: unknown): ShotPlanExport =>
  ShotPlanExportSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
