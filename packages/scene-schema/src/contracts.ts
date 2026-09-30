import { z } from "zod";

export type LocalSceneAsset = {
  version: 1;
  id: string;
  filename: string;
  format: "spz";
  byteLength: number;
};

/** Version of individually persisted entity envelopes (scene, camera, shot, path). */
export const CURRENT_SCHEMA_VERSION = 2 as const;
/** Version of the persisted project document. */
export const PROJECT_SCHEMA_VERSION = 4 as const;
export const CANONICAL_COORDINATES = {
  handedness: "right",
  up: "+Y",
  cameraForward: "-Z",
  quaternionOrder: "xyzw",
  positionUnit: "scene-unit",
  lensUnit: "mm",
  timeUnit: "seconds",
} as const;
const text = z.string().min(1);
const finite = z.number().finite();
const positive = finite.positive();
const vector = z.tuple([finite, finite, finite]);
const quaternion = z
  .tuple([finite, finite, finite, finite])
  .refine((q) => q.some((v) => v !== 0), "Quaternion must have a non-zero length");
export const CameraPoseSchema = z.object({ position: vector, quaternion }).strict();
export type CameraPose = z.infer<typeof CameraPoseSchema>;
export const AssetTransformSchema = z
  .object({
    translation: vector,
    rotation: quaternion,
    scale: z.tuple([positive, positive, positive]),
  })
  .strict();
export const identityTransform = () =>
  AssetTransformSchema.parse({
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
const relativePath = text.refine(
  (s) =>
    /^[A-Za-z0-9_./-]+$/.test(s) &&
    !s.startsWith("/") &&
    s.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Asset locator must be an app-managed relative path",
);
export const AssetLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), relativePath }).strict(),
  z
    .object({
      kind: z.literal("remote"),
      url: z
        .string()
        .url()
        .refine((s) => /^https?:\/\//.test(s)),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export const AssetSchema = z
  .object({
    versionId: text,
    fingerprint: z.discriminatedUnion("status", [
      z.object({ status: z.literal("unknown") }).strict(),
      z
        .object({
          status: z.literal("verified"),
          algorithm: z.literal("sha256"),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    format: z
      .object({ name: z.enum(["spz", "ply", "splat", "sog", "unknown"]), version: text.nullable() })
      .strict(),
    byteSize: z.number().int().nonnegative().nullable(),
    locator: AssetLocatorSchema,
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.fingerprint.status === "verified" && asset.byteSize === null)
      ctx.addIssue({ code: "custom", message: "Verified asset requires byte size" });
  });
export type SceneAsset = z.infer<typeof AssetSchema>;
export const MetricScaleSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown") }).strict(),
  z
    .object({
      status: z.literal("known"),
      metersPerSceneUnit: positive,
      evidence: z
        .object({ kind: z.enum(["source-metadata", "calibration"]), description: text })
        .strict(),
    })
    .strict(),
]);
export const ProvenanceSchema = z
  .object({
    kind: z.enum(["captured", "generated", "unknown"]),
    sourceApp: text.nullable(),
    sourceName: text.nullable(),
    importedAt: z.string().datetime({ offset: true }).nullable(),
    attribution: text.nullable(),
  })
  .strict();
export const unknownProvenance = () =>
  ProvenanceSchema.parse({
    kind: "unknown",
    sourceApp: null,
    sourceName: null,
    importedAt: null,
    attribution: null,
  });
export const SceneDescriptorSchema = z
  .object({
    id: text,
    name: text,
    asset: AssetSchema,
    localAsset: z
      .object({
        version: z.literal(1),
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        filename: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (value) =>
              !/[\\/]/.test(value) && [...value].every((character) => character.charCodeAt(0) > 31),
            "Filename must not contain paths or control characters",
          ),
        format: z.literal("spz"),
        byteLength: z.number().int().positive().safe(),
      })
      .strict()
      .optional(),
    attribution: z
      .object({
        text: z.string().trim().min(1).max(1000),
        url: z.string().url().startsWith("https://").optional(),
        license: z.string().trim().min(1).max(100).optional(),
        licenseUrl: z.string().url().startsWith("https://").optional(),
      })
      .strict()
      .optional(),

    coordinates: z
      .object({
        handedness: z.literal("right"),
        up: z.literal("+Y"),
        cameraForward: z.literal("-Z"),
        quaternionOrder: z.literal("xyzw"),
        positionUnit: z.literal("scene-unit"),
        lensUnit: z.literal("mm"),
        timeUnit: z.literal("seconds"),
      })
      .strict(),
    assetToScene: AssetTransformSchema,
    sourceCoordinates: z
      .object({
        convention: text.nullable(),
        conversion: text.nullable(),
      })
      .strict(),
    metricScale: MetricScaleSchema,
    provenance: ProvenanceSchema,
    initialCameraPose: CameraPoseSchema.optional(),
    source: z.enum(["bundled", "remote", "worldlabs", "imported"]),
    // Preserved locally for legacy projects, never included in metadata exports.
    legacyMetadata: z
      .object({
        colliderUrl: text.optional(),
        thumbnailUrl: text.optional(),
        metricScaleFactor: positive.optional(),
        groundPlaneOffset: finite.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SceneDescriptor = z.infer<typeof SceneDescriptorSchema>;
export const SceneReferenceSchema = z.object({ sceneId: text, assetVersionId: text }).strict();
export type SceneReference = z.infer<typeof SceneReferenceSchema>;
export const sceneReference = (scene: SceneDescriptor): SceneReference => ({
  sceneId: scene.id,
  assetVersionId: scene.asset.versionId,
});
export const CinematicCameraSchema = z
  .object({
    pose: CameraPoseSchema,
    focalLengthMm: positive,
    sensorWidthMm: positive,
    sensorHeightMm: positive,
    output: z.object({ aspectRatio: positive, crop: z.literal("center-inside-sensor") }).strict(),
    near: positive,
    far: positive,
    /** Focus distance in scene units. Recorded for the crew; not rendered as blur. */
    focusDistanceM: positive.optional(),
    /** Aperture as an f-number. Recorded for the crew; not rendered as blur. */
    apertureFStop: finite.min(0.95).max(32).optional(),
  })
  .strict()
  .refine(
    ({ near, far }) => far > near,
    "Far clipping plane must be greater than near clipping plane",
  );
export type CinematicCamera = z.infer<typeof CinematicCameraSchema>;
/** Shot shape persisted before schema v4; kept to read older projects and envelopes. */
export const SavedShotSchema = z
  .object({
    id: text,
    sceneId: text,
    assetVersionId: text,
    name: text,
    camera: CinematicCameraSchema,
    thumbnailDataUrl: text.optional(),
    notes: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SavedShot = z.infer<typeof SavedShotSchema>;
export const MAX_SPEED_CURVE_POINTS = 16;
export const MAX_SPEED_WEIGHT = 4;

export type CameraSpeedPoint = {
  /** Normalized elapsed time within a camera path segment. */
  time: number;
  /** Relative speed, normalized during interpolation to preserve arrival time. */
  speed: number;
  /** Strength of easing at this point: 0 is a linear ramp, 1 is a flat tangent. */
  intensity: number;
};

export type CameraSpeedCurve = {
  version: 1;
  points: CameraSpeedPoint[];
};

export const CameraSpeedCurveSchema = z
  .object({
    version: z.literal(1),
    points: z
      .array(
        z
          .object({
            time: finite.min(0).max(1),
            speed: finite.min(0).max(MAX_SPEED_WEIGHT),
            intensity: finite.min(0).max(1),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_SPEED_CURVE_POINTS),
  })
  .strict()
  .superRefine(({ points }, context) => {
    if (points[0]?.time !== 0 || points.at(-1)?.time !== 1) {
      context.addIssue({
        code: "custom",
        path: ["points"],
        message: "Speed curve must begin at time 0 and end at time 1",
      });
    }
    for (let index = 1; index < points.length; index += 1) {
      if (points[index]!.time <= points[index - 1]!.time) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "time"],
          message: "Speed curve point times must be strictly increasing",
        });
      }
    }
    if (!points.some((point) => point.speed > 0)) {
      context.addIssue({
        code: "custom",
        path: ["points"],
        message: "Speed curve must have at least one positive speed",
      });
    }
  });

export const CameraPathKeyframeSchema = z
  .object({
    timeSeconds: finite.nonnegative(),
    camera: CinematicCameraSchema,
    speedCurve: CameraSpeedCurveSchema.optional(),
  })
  .strict();
export type CameraPathKeyframe = z.infer<typeof CameraPathKeyframeSchema>;
export const CameraPathSchema = z
  .object({
    id: text,
    sceneId: text,
    assetVersionId: text,
    name: text,
    keyframes: z.array(CameraPathKeyframeSchema),
  })
  .strict()
  .refine(
    ({ keyframes }) =>
      keyframes.every((k, i) => i === 0 || k.timeSeconds > keyframes[i - 1]!.timeSeconds),
    "Keyframe times must increase",
  );
export type CameraPath = z.infer<typeof CameraPathSchema>;

export const APERTURE_RANGE = { min: 0.95, max: 32 } as const;
export const SHOT_DURATION_RANGE = { min: 0.5, max: 60 } as const;
export const DEFAULT_STATIC_SHOT_SECONDS = 3;
export const DEFAULT_MOVING_SHOT_SECONDS = 8;
export const MAX_SHOT_KEYFRAMES = 25;
export const DEFAULT_FOCUS_DISTANCE = 3;
export const DEFAULT_APERTURE_F_STOP = 2.8;

/** A prime has one focal length; a zoom lens can change focal length while rolling. */
export const ShotLensSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prime"), focalLengthMm: positive }).strict(),
  z
    .object({ kind: z.literal("zoom"), minFocalLengthMm: positive, maxFocalLengthMm: positive })
    .strict(),
]);
export type ShotLens = z.infer<typeof ShotLensSchema>;

export const lensFocalRange = (lens: ShotLens): { min: number; max: number } =>
  lens.kind === "prime"
    ? { min: lens.focalLengthMm, max: lens.focalLengthMm }
    : { min: lens.minFocalLengthMm, max: lens.maxFocalLengthMm };

/** Camera settings fixed for the whole take. */
export const ShotSetupSchema = z
  .object({
    lens: ShotLensSchema,
    sensorWidthMm: positive,
    sensorHeightMm: positive,
    output: z.object({ aspectRatio: positive, crop: z.literal("center-inside-sensor") }).strict(),
    near: positive,
    far: positive,
  })
  .strict()
  .superRefine((setup, ctx) => {
    if (setup.far <= setup.near)
      ctx.addIssue({
        code: "custom",
        message: "Far clipping plane must be greater than near clipping plane",
      });
    if (setup.lens.kind === "zoom" && setup.lens.maxFocalLengthMm <= setup.lens.minFocalLengthMm)
      ctx.addIssue({
        code: "custom",
        path: ["lens"],
        message: "A zoom lens needs a longer maximum than minimum focal length",
      });
  });
export type ShotSetup = z.infer<typeof ShotSetupSchema>;

/** Camera settings an operator can change while rolling. */
export const ShotKeyframeSchema = z
  .object({
    id: text,
    timeSeconds: finite.nonnegative(),
    pose: CameraPoseSchema,
    focalLengthMm: positive,
    focusDistanceM: positive,
    apertureFStop: finite.min(APERTURE_RANGE.min).max(APERTURE_RANGE.max),
    /** Speed through the segment that starts at this keyframe. */
    speedCurve: CameraSpeedCurveSchema.optional(),
  })
  .strict();
export type ShotKeyframe = z.infer<typeof ShotKeyframeSchema>;

const ShotObjectSchema = z
  .object({
    id: text,
    sceneId: text,
    assetVersionId: text,
    name: text,
    notes: z.string().optional(),
    thumbnailDataUrl: text.optional(),
    createdAt: z.string().datetime({ offset: true }),
    durationSeconds: finite.min(SHOT_DURATION_RANGE.min).max(SHOT_DURATION_RANGE.max),
    setup: ShotSetupSchema,
    keyframes: z.array(ShotKeyframeSchema).min(1).max(MAX_SHOT_KEYFRAMES),
  })
  .strict();
/** Timing and lens rules shared by stored and exported shots. */
export function checkShot(
  shot: Pick<z.infer<typeof ShotObjectSchema>, "durationSeconds" | "setup" | "keyframes">,
  ctx: z.RefinementCtx,
): void {
  const { keyframes } = shot;
  if (keyframes[0]?.timeSeconds !== 0)
    ctx.addIssue({ code: "custom", message: "A shot's first keyframe must be at 0 seconds" });
  keyframes.forEach((keyframe, index) => {
    if (index > 0 && keyframe.timeSeconds <= keyframes[index - 1]!.timeSeconds)
      ctx.addIssue({
        code: "custom",
        path: ["keyframes", index, "timeSeconds"],
        message: "Keyframe times must increase",
      });
  });
  if ((keyframes.at(-1)?.timeSeconds ?? 0) > shot.durationSeconds + 1e-6)
    ctx.addIssue({ code: "custom", message: "Keyframe exceeds shot duration" });
  const range = lensFocalRange(shot.setup.lens);
  keyframes.forEach((keyframe, index) => {
    if (keyframe.focalLengthMm < range.min - 1e-6 || keyframe.focalLengthMm > range.max + 1e-6)
      ctx.addIssue({
        code: "custom",
        path: ["keyframes", index, "focalLengthMm"],
        message: "Keyframe focal length is outside the shot's lens",
      });
  });
  if (new Set(keyframes.map((k) => k.id)).size !== keyframes.length)
    ctx.addIssue({ code: "custom", message: "Keyframe IDs must be unique within a shot" });
}
/** A shot is static with one keyframe and moving with two or more. */
export const ShotSchema = ShotObjectSchema.superRefine(checkShot);
/** A shot without its private image, as shared in exports. */
export const PublicShotSchema = ShotObjectSchema.omit({ thumbnailDataUrl: true }).superRefine(
  checkShot,
);
export type Shot = z.infer<typeof ShotSchema>;

export const isMovingShot = (shot: Shot): boolean => shot.keyframes.length > 1;

/** The full camera a shot's keyframe describes. */
export function shotKeyframeCamera(setup: ShotSetup, keyframe: ShotKeyframe): CinematicCamera {
  return {
    pose: {
      position: [...keyframe.pose.position],
      quaternion: [...keyframe.pose.quaternion],
    },
    focalLengthMm: keyframe.focalLengthMm,
    sensorWidthMm: setup.sensorWidthMm,
    sensorHeightMm: setup.sensorHeightMm,
    output: { ...setup.output },
    near: setup.near,
    far: setup.far,
    focusDistanceM: keyframe.focusDistanceM,
    apertureFStop: keyframe.apertureFStop,
  };
}
/** The camera at the start of a shot: its storyboard frame. */
export const shotStartCamera = (shot: Shot): CinematicCamera =>
  shotKeyframeCamera(shot.setup, shot.keyframes[0]!);

export function shotSetupFromCamera(camera: CinematicCamera, lens?: ShotLens): ShotSetup {
  return {
    lens: lens ?? { kind: "prime", focalLengthMm: camera.focalLengthMm },
    sensorWidthMm: camera.sensorWidthMm,
    sensorHeightMm: camera.sensorHeightMm,
    output: { ...camera.output },
    near: camera.near,
    far: camera.far,
  };
}
export function shotKeyframeFromCamera(
  id: string,
  timeSeconds: number,
  camera: CinematicCamera,
): ShotKeyframe {
  return {
    id,
    timeSeconds,
    pose: {
      position: [...camera.pose.position],
      quaternion: [...camera.pose.quaternion],
    },
    focalLengthMm: camera.focalLengthMm,
    focusDistanceM: camera.focusDistanceM ?? DEFAULT_FOCUS_DISTANCE,
    apertureFStop: camera.apertureFStop ?? DEFAULT_APERTURE_F_STOP,
  };
}

export const ProjectSettingsSchema = z
  .object({ showGrid: z.boolean(), showSafeFrame: z.boolean(), reduceMotion: z.boolean() })
  .strict();
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
const ShotSheetStateSchema = z
  .object({ version: z.literal(1), excludedShotIds: z.array(z.string()) })
  .strict();
export type ShotSheetState = z.infer<typeof ShotSheetStateSchema>;

type LegacySceneBoundWork = {
  scene: SceneDescriptor;
  sceneId: string;
  assetVersionId: string;
  durationSeconds: number;
  shots: SavedShot[];
  path: CameraPath;
};
function checkLegacySceneBinding(
  p: LegacySceneBoundWork,
  ctx: z.RefinementCtx,
  label: string,
): void {
  for (const ref of [p, ...p.shots, p.path]) {
    if (ref.sceneId !== p.scene.id || ref.assetVersionId !== p.scene.asset.versionId)
      ctx.addIssue({
        code: "custom",
        message: `${label}, shots and path must reference the same scene asset version`,
      });
  }
  if (p.path.keyframes.some((k) => k.timeSeconds > p.durationSeconds))
    ctx.addIssue({ code: "custom", message: "Keyframe exceeds scene duration" });
}

type SceneBoundWork = {
  scene: SceneDescriptor;
  sceneId: string;
  assetVersionId: string;
  shots: Shot[];
};
function checkSceneBinding(p: SceneBoundWork, ctx: z.RefinementCtx, label: string): void {
  for (const ref of [p, ...p.shots]) {
    if (ref.sceneId !== p.scene.id || ref.assetVersionId !== p.scene.asset.versionId)
      ctx.addIssue({
        code: "custom",
        message: `${label} and shots must reference the same scene asset version`,
      });
  }
}

/** One captured or generated scene inside a project, with its own shots. */
export const ProjectSceneSchema = z
  .object({
    id: text,
    name: text,
    createdAt: finite,
    updatedAt: finite,
    scene: SceneDescriptorSchema,
    sceneId: text,
    assetVersionId: text,
    /** The live camera rig the user navigates with; not a shot. */
    camera: CinematicCameraSchema,
    shots: z.array(ShotSchema),
  })
  .strict()
  .superRefine((s, ctx) => checkSceneBinding(s, ctx, "Scene"));
export type ProjectScene = z.infer<typeof ProjectSceneSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: text,
    name: text,
    createdAt: finite,
    updatedAt: finite,
    scenes: z.array(ProjectSceneSchema).min(1),
    settings: ProjectSettingsSchema,
    shotSheet: ShotSheetStateSchema.optional(),
    /** Bundled walkthrough project; never counts toward the saved-project limit. */
    tutorial: z.literal(true).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.scenes.map((s) => s.id)).size !== p.scenes.length)
      ctx.addIssue({ code: "custom", message: "Scene IDs must be unique within a project" });
    const shots = p.scenes.flatMap((s) => s.shots);
    if (new Set(shots.map((s) => s.id)).size !== shots.length)
      ctx.addIssue({ code: "custom", message: "Shot IDs must be unique within a project" });
  });
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Editing view of one project scene. It is never persisted: callers read it with
 * `sceneWorkspace` and write it back with `applySceneWorkspace`.
 */
export const SceneWorkspaceSchema = z
  .object({
    id: text,
    name: text,
    projectSceneId: text,
    projectSceneName: text,
    scene: SceneDescriptorSchema,
    sceneId: text,
    assetVersionId: text,
    updatedAt: finite,
    camera: CinematicCameraSchema,
    shots: z.array(ShotSchema),
    settings: ProjectSettingsSchema,
    shotSheet: ShotSheetStateSchema.optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (new Set(w.shots.map((s) => s.id)).size !== w.shots.length)
      ctx.addIssue({ code: "custom", message: "Shot IDs must be unique within a project" });
    checkSceneBinding(w, ctx, "Project");
  });
export type SceneWorkspace = z.infer<typeof SceneWorkspaceSchema>;

export function findProjectScene(project: Project, projectSceneId: string): ProjectScene {
  const scene = project.scenes.find((s) => s.id === projectSceneId);
  if (!scene) throw new Error("This scene is no longer part of the project");
  return scene;
}
export const allProjectShots = (project: Project): Shot[] => project.scenes.flatMap((s) => s.shots);

export function sceneWorkspace(project: Project, projectSceneId: string): SceneWorkspace {
  const s = findProjectScene(project, projectSceneId);
  const ids = new Set(s.shots.map((shot) => shot.id));
  return {
    id: project.id,
    name: project.name,
    projectSceneId: s.id,
    projectSceneName: s.name,
    scene: s.scene,
    sceneId: s.sceneId,
    assetVersionId: s.assetVersionId,
    updatedAt: Math.max(project.updatedAt, s.updatedAt),
    camera: s.camera,
    shots: s.shots,
    settings: project.settings,
    ...(project.shotSheet
      ? {
          shotSheet: {
            version: 1 as const,
            excludedShotIds: project.shotSheet.excludedShotIds.filter((id) => ids.has(id)),
          },
        }
      : {}),
  };
}

/** Writes a workspace back into its project; other scenes and their export choices are kept. */
export function applySceneWorkspace(project: Project, workspace: SceneWorkspace): Project {
  if (workspace.id !== project.id) throw new Error("Workspace belongs to another project");
  const previous = findProjectScene(project, workspace.projectSceneId);
  const previousIds = new Set(previous.shots.map((s) => s.id));
  const updatedAt = Math.max(project.updatedAt, workspace.updatedAt);
  const excluded = [
    ...(project.shotSheet?.excludedShotIds ?? []).filter((id) => !previousIds.has(id)),
    ...(workspace.shotSheet?.excludedShotIds ?? []),
  ];
  return {
    ...project,
    name: workspace.name,
    updatedAt,
    settings: workspace.settings,
    ...(project.shotSheet || workspace.shotSheet
      ? { shotSheet: { version: 1 as const, excludedShotIds: excluded } }
      : {}),
    scenes: project.scenes.map((s) =>
      s.id === workspace.projectSceneId
        ? {
            ...s,
            name: workspace.projectSceneName,
            updatedAt: workspace.updatedAt,
            scene: workspace.scene,
            sceneId: workspace.sceneId,
            assetVersionId: workspace.assetVersionId,
            camera: workspace.camera,
            shots: workspace.shots,
          }
        : s,
    ),
  };
}

// Legacy schemas validate before migrating; only known historical fields are accepted.
const LegacyCamera = z
  .object({
    pose: CameraPoseSchema,
    focalLengthMm: positive,
    sensorWidthMm: positive,
    sensorHeightMm: positive,
    outputAspectRatio: positive.optional(),
    near: positive,
    far: positive,
  })
  .strict();
const LegacyScene = z
  .object({
    id: text,
    name: text,
    splatUrl: text,
    localAsset: z
      .object({
        version: z.literal(1),
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        filename: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (value) =>
              !/[\\/]/.test(value) && [...value].every((character) => character.charCodeAt(0) > 31),
            "Filename must not contain paths or control characters",
          ),
        format: z.literal("spz"),
        byteLength: z.number().int().positive().safe(),
      })
      .strict()
      .optional(),
    attribution: z
      .object({
        text: z.string().trim().min(1).max(1000),
        url: z.string().url().startsWith("https://").optional(),
        license: z.string().trim().min(1).max(100).optional(),
        licenseUrl: z.string().url().startsWith("https://").optional(),
      })
      .strict()
      .optional(),

    splatQuaternion: quaternion.optional(),
    initialCameraPose: CameraPoseSchema.optional(),
    colliderUrl: text.optional(),
    thumbnailUrl: text.optional(),
    metricScaleFactor: positive.optional(),
    groundPlaneOffset: finite.optional(),
    source: z.enum(["bundled", "worldlabs", "imported"]),
  })
  .strict();
const LegacyShot = z
  .object({
    id: text,
    sceneId: text,
    name: text,
    camera: LegacyCamera,
    thumbnailDataUrl: text.optional(),
    notes: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
const LegacyPath = z
  .object({
    id: text,
    name: text,
    keyframes: z.array(
      z
        .object({
          timeSeconds: finite.nonnegative(),
          camera: LegacyCamera,
          speedCurve: CameraSpeedCurveSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
export function migrateCamera(value: unknown): CinematicCamera {
  const c = LegacyCamera.parse(value);
  return CinematicCameraSchema.parse({
    pose: c.pose,
    focalLengthMm: c.focalLengthMm,
    sensorWidthMm: c.sensorWidthMm,
    sensorHeightMm: c.sensorHeightMm,
    near: c.near,
    far: c.far,
    output: {
      aspectRatio: c.outputAspectRatio ?? c.sensorWidthMm / c.sensorHeightMm,
      crop: "center-inside-sensor",
    },
  });
}
export function migrateScene(value: unknown, versionId?: string): SceneDescriptor {
  const s = LegacyScene.parse(value);
  if (
    s.localAsset &&
    (s.source !== "imported" || s.splatUrl !== `oculo-asset:${s.localAsset.id}`)
  )
    throw new Error("Imported projects must reference durable local scene assets");
  if (!s.localAsset && s.splatUrl.startsWith("oculo-asset:"))
    throw new Error("The imported scene asset descriptor is missing");
  const { colliderUrl, thumbnailUrl, metricScaleFactor, groundPlaneOffset } = s;
  return SceneDescriptorSchema.parse({
    id: s.id,
    name: s.name,
    ...(s.localAsset ? { localAsset: s.localAsset } : {}),
    ...(s.attribution ? { attribution: s.attribution } : {}),
    asset: {
      versionId: versionId ?? `legacy-scene:${s.id}`,
      fingerprint: { status: "unknown" },
      format: { name: "unknown", version: null },
      byteSize: null,
      locator: /^https?:\/\//.test(s.splatUrl)
        ? { kind: "remote", url: s.splatUrl }
        : { kind: "unavailable" },
    },
    coordinates: CANONICAL_COORDINATES,
    assetToScene: { ...identityTransform(), rotation: s.splatQuaternion ?? [0, 0, 0, 1] },
    sourceCoordinates: {
      convention: null,
      conversion: "Legacy viewer transform; source convention unknown",
    },
    metricScale: { status: "unknown" },
    provenance: unknownProvenance(),
    ...(s.initialCameraPose ? { initialCameraPose: s.initialCameraPose } : {}),
    source: s.source === "bundled" && /^https?:/.test(s.splatUrl) ? "remote" : s.source,
    legacyMetadata: { colliderUrl, thumbnailUrl, metricScaleFactor, groundPlaneOffset },
  });
}
function migrateShot(value: unknown, ref?: SceneReference): SavedShot {
  const s = LegacyShot.parse(value);
  if (ref && s.sceneId !== ref.sceneId) throw new Error("Legacy shot belongs to another scene");
  return SavedShotSchema.parse({
    ...s,
    assetVersionId: ref?.assetVersionId ?? `legacy-scene:${s.sceneId}`,
    camera: migrateCamera(s.camera),
  });
}
function migratePath(value: unknown, ref?: SceneReference): CameraPath {
  const p = LegacyPath.parse(value);
  return CameraPathSchema.parse({
    ...p,
    ...(ref ?? { sceneId: `unknown-path:${p.id}`, assetVersionId: `legacy-path:${p.id}` }),
    keyframes: p.keyframes.map((k) => ({ ...k, camera: migrateCamera(k.camera) })),
  });
}
// The single-scene project document persisted before multi-scene projects.
const ProjectV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: text,
    name: text,
    scene: SceneDescriptorSchema,
    sceneId: text,
    assetVersionId: text,
    updatedAt: finite,
    durationSeconds: positive,
    camera: CinematicCameraSchema,
    shots: z.array(SavedShotSchema),
    path: CameraPathSchema,
    settings: ProjectSettingsSchema,
    shotSheet: ShotSheetStateSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.shots.map((s) => s.id)).size !== p.shots.length)
      ctx.addIssue({ code: "custom", message: "Shot IDs must be unique within a project" });
    checkLegacySceneBinding(p, ctx, "Project");
  });
type ProjectV2 = z.infer<typeof ProjectV2Schema>;

/** Deterministic, so re-reading an unsaved v2 document keeps stable scene routes. */
export const migratedSceneId = (projectId: string): string => `scene-${projectId}`;

// The multi-scene document persisted before shots owned their own movement.
const ProjectSceneV3Schema = z
  .object({
    id: text,
    name: text,
    createdAt: finite,
    updatedAt: finite,
    scene: SceneDescriptorSchema,
    sceneId: text,
    assetVersionId: text,
    durationSeconds: positive,
    camera: CinematicCameraSchema,
    shots: z.array(SavedShotSchema),
    path: CameraPathSchema,
  })
  .strict()
  .superRefine((s, ctx) => checkLegacySceneBinding(s, ctx, "Scene"));
type ProjectSceneV3 = z.infer<typeof ProjectSceneV3Schema>;
const ProjectV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    id: text,
    name: text,
    createdAt: finite,
    updatedAt: finite,
    scenes: z.array(ProjectSceneV3Schema).min(1),
    settings: ProjectSettingsSchema,
    shotSheet: ShotSheetStateSchema.optional(),
    tutorial: z.literal(true).optional(),
  })
  .strict();
type ProjectV3 = z.infer<typeof ProjectV3Schema>;

function migrateProjectV2(p: ProjectV2): ProjectV3 {
  const { schemaVersion: _version, shotSheet, ...rest } = p;
  void _version;
  return ProjectV3Schema.parse({
    schemaVersion: 3,
    id: rest.id,
    name: rest.name,
    createdAt: rest.updatedAt,
    updatedAt: rest.updatedAt,
    scenes: [
      {
        id: migratedSceneId(rest.id),
        name: rest.scene.name,
        createdAt: rest.updatedAt,
        updatedAt: rest.updatedAt,
        scene: rest.scene,
        sceneId: rest.sceneId,
        assetVersionId: rest.assetVersionId,
        durationSeconds: rest.durationSeconds,
        camera: rest.camera,
        shots: rest.shots,
        path: rest.path,
      },
    ],
    settings: rest.settings,
    ...(shotSheet ? { shotSheet } : {}),
  });
}

/** A pre-v4 still becomes a static shot on a prime at its focal length. */
export function migrateSavedShot(shot: SavedShot): Shot {
  return ShotSchema.parse({
    id: shot.id,
    sceneId: shot.sceneId,
    assetVersionId: shot.assetVersionId,
    name: shot.name,
    ...(shot.notes !== undefined ? { notes: shot.notes } : {}),
    ...(shot.thumbnailDataUrl ? { thumbnailDataUrl: shot.thumbnailDataUrl } : {}),
    createdAt: shot.createdAt,
    durationSeconds: DEFAULT_STATIC_SHOT_SECONDS,
    setup: shotSetupFromCamera(shot.camera),
    keyframes: [shotKeyframeFromCamera(`${shot.id}-k0`, 0, shot.camera)],
  });
}

/** Deterministic, so re-reading an unsaved v3 document keeps the move's shot ID. */
export const migratedMoveShotId = (pathId: string): string => `move-${pathId}`;

function migrateSceneV3(scene: ProjectSceneV3, createdAt: string): ProjectScene {
  const shots = scene.shots.map(migrateSavedShot);
  const keyframes = scene.path.keyframes;
  if (keyframes.length >= 2) {
    const first = keyframes[0]!.camera;
    const focals = keyframes.map((k) => k.camera.focalLengthMm);
    const min = Math.min(...focals);
    const max = Math.max(...focals);
    const lens: ShotLens =
      max > min
        ? { kind: "zoom", minFocalLengthMm: min, maxFocalLengthMm: max }
        : { kind: "prime", focalLengthMm: min };
    const start = keyframes[0]!.timeSeconds;
    const end = keyframes.at(-1)!.timeSeconds;
    const duration = Math.min(
      SHOT_DURATION_RANGE.max,
      Math.max(SHOT_DURATION_RANGE.min, end - start, scene.durationSeconds),
    );
    // Older moves could start after 0 or run past 60 s; keep their proportions.
    const scale = end - start > duration ? duration / (end - start) : 1;
    const id = migratedMoveShotId(scene.path.id);
    shots.push(
      ShotSchema.parse({
        id: shots.some((shot) => shot.id === id) ? `${id}-${scene.id}` : id,
        sceneId: scene.sceneId,
        assetVersionId: scene.assetVersionId,
        name: "Camera move",
        createdAt,
        durationSeconds: duration,
        setup: shotSetupFromCamera(first, lens),
        keyframes: keyframes.map((k, index) => ({
          ...shotKeyframeFromCamera(`${id}-k${index}`, (k.timeSeconds - start) * scale, k.camera),
          ...(k.speedCurve ? { speedCurve: k.speedCurve } : {}),
        })),
      }),
    );
  }
  return {
    id: scene.id,
    name: scene.name,
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt,
    scene: scene.scene,
    sceneId: scene.sceneId,
    assetVersionId: scene.assetVersionId,
    camera: scene.camera,
    shots,
  };
}

function migrateProjectV3(p: ProjectV3): Project {
  const createdAt = new Date(p.updatedAt).toISOString();
  return ProjectSchema.parse({
    ...p,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    scenes: p.scenes.map((scene) => migrateSceneV3(scene, createdAt)),
  });
}

export function parseProject(value: unknown): Project {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const version = z.object({ schemaVersion: z.number() }).parse(raw).schemaVersion;
  if (version === PROJECT_SCHEMA_VERSION) return ProjectSchema.parse(raw);
  if (version === 3) return migrateProjectV3(ProjectV3Schema.parse(raw));
  if (version === 2 && typeof raw === "object" && raw !== null && "assetVersionId" in raw)
    return migrateProjectV3(migrateProjectV2(ProjectV2Schema.parse(raw)));
  if (![0, 1, 2].includes(version))
    throw new Error(`Unsupported project schema version: ${version}`);
  const p = z
    .object({
      schemaVersion: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      id: text,
      name: text,
      scene: LegacyScene,
      updatedAt: finite,
      durationSeconds: positive,
      camera: LegacyCamera,
      shots: z.array(LegacyShot),
      path: LegacyPath,
      settings: ProjectSettingsSchema,
      shotSheet: ShotSheetStateSchema.optional(),
    })
    .strict()
    .parse(raw);
  // Scope unverified legacy versions to a project: old URLs never established byte identity.
  const scene = migrateScene(p.scene, `legacy-project:${p.id}`);
  const ref = sceneReference(scene);
  return migrateProjectV3(
    migrateProjectV2(
      ProjectV2Schema.parse({
        ...p,
        schemaVersion: 2,
        ...ref,
        scene,
        camera: migrateCamera(p.camera),
        shots: p.shots.map((s) => migrateShot(s, ref)),
        path: migratePath(p.path, ref),
      }),
    ),
  );
}
export function stringifyProject(value: Project): string {
  return JSON.stringify(ProjectSchema.parse(value));
}

const entityTypes = z.enum([
  "SceneDescriptor",
  "CameraPose",
  "CinematicCamera",
  "SavedShot",
  "CameraPath",
  "Shot",
]);
export type PersistedValueType = z.infer<typeof entityTypes>;
export type PersistenceEnvelope<T, TType extends PersistedValueType = PersistedValueType> = {
  version: typeof CURRENT_SCHEMA_VERSION;
  type: TType;
  data: T;
};
export type LegacyPersistenceEnvelopeV0<T = unknown> = {
  version: 0;
  type: PersistedValueType;
  payload: T;
};
export function upgradePersistenceEnvelope(input: unknown): PersistenceEnvelope<unknown> {
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const version = z.object({ version: z.number() }).parse(raw).version;
  if (![0, 1, 2].includes(version)) throw new Error(`Unsupported schema version: ${version}`);
  const envelope =
    version === 0
      ? z
          .object({ version: z.literal(0), type: entityTypes, payload: z.unknown() })
          .strict()
          .parse(raw)
      : z.object({ version: z.number(), type: entityTypes, data: z.unknown() }).strict().parse(raw);
  let data = "payload" in envelope ? envelope.payload : envelope.data;
  if (
    version < 2 ||
    (typeof data === "object" &&
      data !== null &&
      ("splatUrl" in data ||
        "outputAspectRatio" in data ||
        ((envelope.type === "SavedShot" || envelope.type === "CameraPath") &&
          !("assetVersionId" in data))))
  ) {
    switch (envelope.type) {
      case "SceneDescriptor":
        data = migrateScene(data);
        break;
      case "CinematicCamera":
        data = migrateCamera(data);
        break;
      case "SavedShot":
        data = migrateShot(data);
        break;
      case "CameraPath":
        data = migratePath(data);
        break;
    }
  }
  return { version: 2, type: envelope.type, data };
}
function parseEntity<T>(input: unknown, type: PersistedValueType, schema: z.ZodType<T>): T {
  const envelope = upgradePersistenceEnvelope(input);
  if (envelope.type !== type)
    throw new Error(`Expected persisted ${type}, received ${envelope.type}`);
  return schema.parse(envelope.data);
}
function stringifyEntity<T>(value: T, type: PersistedValueType, schema: z.ZodType<T>): string {
  return JSON.stringify({ version: 2, type, data: schema.parse(value) });
}
export const parseSceneDescriptor = (v: unknown) =>
  parseEntity(v, "SceneDescriptor", SceneDescriptorSchema);
export const stringifySceneDescriptor = (v: SceneDescriptor) =>
  stringifyEntity(v, "SceneDescriptor", SceneDescriptorSchema);
export const parseCameraPose = (v: unknown) => parseEntity(v, "CameraPose", CameraPoseSchema);
export const stringifyCameraPose = (v: CameraPose) =>
  stringifyEntity(v, "CameraPose", CameraPoseSchema);
export const parseCinematicCamera = (v: unknown) =>
  parseEntity(v, "CinematicCamera", CinematicCameraSchema);
export const stringifyCinematicCamera = (v: CinematicCamera) =>
  stringifyEntity(v, "CinematicCamera", CinematicCameraSchema);
export const parseSavedShot = (v: unknown) => parseEntity(v, "SavedShot", SavedShotSchema);
export const stringifySavedShot = (v: SavedShot) =>
  stringifyEntity(v, "SavedShot", SavedShotSchema);
export const parseShot = (v: unknown) => parseEntity(v, "Shot", ShotSchema);
export const stringifyShot = (v: Shot) => stringifyEntity(v, "Shot", ShotSchema);
export const parseCameraPath = (v: unknown) => parseEntity(v, "CameraPath", CameraPathSchema);
export const stringifyCameraPath = (v: CameraPath) =>
  stringifyEntity(v, "CameraPath", CameraPathSchema);
