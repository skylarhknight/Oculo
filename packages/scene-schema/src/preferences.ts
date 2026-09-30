import { z } from "zod";

const positive = z.number().finite().positive();

/** Device-wide app preferences. Project-specific settings stay on the project. */
export const AppPreferencesSchema = z
  .object({
    version: z.literal(1),
    camera: z
      .object({
        focalLengthMm: positive,
        sensorWidthMm: positive,
        sensorHeightMm: positive,
        aspectRatio: positive,
      })
      .strict(),
    reduceMotion: z.boolean(),
    haptics: z.boolean(),
    gallerySort: z.enum(["recent", "name", "shots"]),
    shotsView: z.enum(["storyboard", "list"]),
    /** Draw saved shots and the camera move in the scene viewport. */
    showShotMarkers: z.boolean(),
    /** Set once the tutorial has been offered, so deleting it is respected. */
    tutorialSeeded: z.boolean(),
    /** On-screen thumb sticks over the scene; added later, so older records default on. */
    showJoysticks: z.boolean().default(true),
    /** How fast the sticks move the camera through the scene. */
    walkSpeed: z.enum(["slow", "normal", "fast"]).default("normal"),
    /** Light or dark app chrome, or follow the system; added later, so it defaults to system. */
    appearance: z.enum(["system", "light", "dark"]).default("system"),
  })
  .strict();
export type AppPreferences = z.infer<typeof AppPreferencesSchema>;

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  version: 1,
  camera: { focalLengthMm: 35, sensorWidthMm: 36, sensorHeightMm: 24, aspectRatio: 16 / 9 },
  reduceMotion: false,
  haptics: true,
  gallerySort: "recent",
  shotsView: "storyboard",
  showShotMarkers: true,
  tutorialSeeded: false,
  showJoysticks: true,
  walkSpeed: "normal",
  appearance: "system",
};

/** Reads stored preferences, keeping defaults for fields a newer version would add. */
export function parseAppPreferences(value: unknown): AppPreferences {
  const version = z.object({ version: z.number() }).safeParse(value);
  if (!version.success) return structuredClone(DEFAULT_APP_PREFERENCES);
  if (version.data.version !== 1)
    throw new Error(`Unsupported preferences version: ${version.data.version}`);
  return AppPreferencesSchema.parse(value);
}

export const MAX_CAMERA_PRESETS = 24;

/** A saved lens and sensor combination the user can reapply to any shot. */
export const CameraPresetSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    name: z.string().trim().min(1).max(40),
    focalLengthMm: positive,
    sensorWidthMm: positive,
    sensorHeightMm: positive,
    aspectRatio: positive,
    createdAt: z.number().finite(),
  })
  .strict();
export type CameraPreset = z.infer<typeof CameraPresetSchema>;

export function parseCameraPreset(value: unknown): CameraPreset {
  const version = z.object({ version: z.number() }).parse(value).version;
  if (version !== 1) throw new Error(`Unsupported camera preset version: ${version}`);
  return CameraPresetSchema.parse(value);
}
