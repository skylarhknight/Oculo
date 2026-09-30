import {
  publicSourceLabel,
  ShotSchema,
  shotStartCamera,
  type CinematicCamera,
  type Shot,
} from "@oculo/scene-schema";
import { formatFStop, lensLabel } from "@oculo/camera-core";
import type { SceneWorkspace } from "../../types/project";

export const SHOT_SHEET_LIMITS = Object.freeze({
  shots: 100,
  pages: 40,
  textCharacters: 100_000,
  nameCharacters: 500,
  imageBytes: 2 * 1024 * 1024,
  sourceBytes: 32 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  imagePixels: 4_194_304,
  width: 1440,
  height: 2036,
});

export type ShotSheetErrorCode =
  | "empty"
  | "invalid-selection"
  | "invalid-camera"
  | "invalid-images"
  | "limits"
  | "render"
  | "cancelled";
export interface ShotSheetIssue {
  readonly shotId: string;
  readonly reason: string;
}

export class ShotSheetError extends Error {
  readonly shotIds: readonly string[];
  constructor(
    readonly code: ShotSheetErrorCode,
    message: string,
    readonly issues: readonly ShotSheetIssue[] = [],
  ) {
    super(message);
    this.name = code === "cancelled" ? "AbortError" : "ShotSheetError";
    this.shotIds = [...new Set(issues.map((issue) => issue.shotId))];
  }
}

export interface SheetShot {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly notes: string;
  readonly imageDataUrl: string | undefined;
  readonly camera: Readonly<CinematicCamera>;
  readonly metadata: string;
}

export interface SheetDocument {
  readonly kind: "oculo-shot-sheet";
  readonly projectId: string;
  readonly title: string;
  readonly location: string;
  readonly generatedAt: string;
  readonly shots: readonly SheetShot[];
  readonly imageIssues: readonly ShotSheetIssue[];
  readonly attribution?: string;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function decimal(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function sheetAspectLabel(value: number): string {
  for (const [label, ratio] of [
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["9:16", 9 / 16],
  ] as const) {
    if (Math.abs(value - ratio) < 0.001) return label;
  }
  return `${decimal(value)}:1`;
}

function range(values: readonly number[], format: (value: number) => string): string {
  const first = values[0]!;
  const last = values.at(-1)!;
  return Math.abs(first - last) < 1e-6 ? format(first) : `${format(first)} → ${format(last)}`;
}

/** Lens, gate and timing, then what the operator pulls during the take. */
export function shotMetadata(shot: Shot): string {
  const { setup, keyframes } = shot;
  const timing =
    keyframes.length > 1
      ? `Moving, ${keyframes.length} keyframes, ${decimal(shot.durationSeconds)} s`
      : `Static, ${decimal(shot.durationSeconds)} s`;
  return [
    lensLabel(setup.lens),
    ...(setup.lens.kind === "zoom"
      ? [
          range(
            keyframes.map((k) => k.focalLengthMm),
            (mm) => `${decimal(mm)} mm`,
          ),
        ]
      : []),
    `Sensor ${decimal(setup.sensorWidthMm)} × ${decimal(setup.sensorHeightMm)} mm`,
    sheetAspectLabel(setup.output.aspectRatio),
    timing,
    `Focus ${range(
      keyframes.map((k) => k.focusDistanceM),
      (m) => `${decimal(m)} m`,
    )}`,
    range(
      keyframes.map((k) => k.apertureFStop),
      formatFStop,
    ),
  ].join(" · ");
}

/** Takes only saved project data. It never reads the renderer or current editor camera. */
export function createShotSheet(
  project: SceneWorkspace,
  options: { generatedAt?: Date } = {},
): SheetDocument {
  const selection = (
    project as SceneWorkspace & { shotSheet?: { version: number; excludedShotIds: string[] } }
  ).shotSheet;
  const allIds = new Set(project.shots.map((shot) => shot.id));
  if (
    allIds.size !== project.shots.length ||
    (selection &&
      (selection.version !== 1 ||
        !Array.isArray(selection.excludedShotIds) ||
        selection.excludedShotIds.some((id) => !allIds.has(id))))
  ) {
    throw new ShotSheetError(
      "invalid-selection",
      "The shot selection is out of date. Review the included shots.",
    );
  }
  const excluded = new Set(selection?.excludedShotIds ?? []);
  const selected = project.shots.filter((shot) => !excluded.has(shot.id));
  if (!selected.length)
    throw new ShotSheetError("empty", "Include at least one saved shot to create a sheet.");
  if (selected.length > SHOT_SHEET_LIMITS.shots) {
    throw new ShotSheetError(
      "limits",
      `A sheet supports up to ${SHOT_SHEET_LIMITS.shots} shots. Select fewer shots.`,
    );
  }
  const generated = options.generatedAt ?? new Date();
  if (!Number.isFinite(generated.getTime()))
    throw new ShotSheetError("render", "The generation date is invalid.");
  const title = project.name.trim() || "Untitled project";
  const location = project.scene.name.trim() || "Untitled location";
  const credit = project.scene.attribution;
  const provenance = project.scene.provenance;
  const scale = project.scene.metricScale;
  const attribution = [
    `Origin: ${provenance.kind}${provenance.kind === "generated" ? " (not a verified real location)" : ""}`,
    publicSourceLabel(provenance.sourceApp),
    publicSourceLabel(provenance.sourceName),
    scale.status === "known"
      ? `Scale: ${scale.metersPerSceneUnit} m per scene unit`
      : "Physical scale unknown",
    publicSourceLabel(provenance.attribution),
    ...[credit?.text, credit?.url, credit?.license, credit?.licenseUrl].map((value) =>
      publicSourceLabel(value ?? null),
    ),
    "Reference frames composed in Oculo.",
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ");
  let textCharacters = title.length + location.length + (attribution?.length ?? 0);
  let sourceBytes = 0;
  const imageIssues: ShotSheetIssue[] = [];
  if ([title, location].some((name) => name.length > SHOT_SHEET_LIMITS.nameCharacters)) {
    throw new ShotSheetError(
      "limits",
      "Project and location names must be 500 characters or fewer.",
    );
  }
  const shots = selected.map((shot, index): SheetShot => {
    const parsed = ShotSchema.safeParse(shot);
    if (!parsed.success)
      throw new ShotSheetError("invalid-camera", "A saved shot has invalid camera settings.", [
        { shotId: shot.id, reason: "Invalid shot settings; open this shot and update it." },
      ]);
    const camera = shotStartCamera(parsed.data);
    const name = shot.name.trim() || `Shot ${index + 1}`;
    const notes = shot.notes ?? "";
    if (name.length > SHOT_SHEET_LIMITS.nameCharacters)
      throw new ShotSheetError("limits", "Shot names must be 500 characters or fewer.", [
        { shotId: shot.id, reason: "Shorten this shot name." },
      ]);
    textCharacters += name.length + notes.length;
    const imageDataUrl = shot.thumbnailDataUrl;
    if (!imageDataUrl)
      imageIssues.push({
        shotId: shot.id,
        reason: "Saved image is missing. Open the scene to render it, or exclude this shot.",
      });
    else {
      sourceBytes += imageDataUrl.length * 2;
      if (imageDataUrl.length > (SHOT_SHEET_LIMITS.imageBytes * 4) / 3 + 100) {
        imageIssues.push({
          shotId: shot.id,
          reason:
            "Saved image exceeds the 2 MiB image limit. Update its first keyframe or exclude this shot.",
        });
      }
    }
    return {
      id: shot.id,
      number: index + 1,
      name,
      notes,
      imageDataUrl,
      camera,
      metadata: shotMetadata(parsed.data),
    };
  });
  if (
    textCharacters > SHOT_SHEET_LIMITS.textCharacters ||
    sourceBytes > SHOT_SHEET_LIMITS.sourceBytes
  ) {
    throw new ShotSheetError(
      "limits",
      "This sheet exceeds the 100,000-character or 32 MiB source-image limit. Select fewer shots.",
    );
  }
  return freeze({
    kind: "oculo-shot-sheet",
    projectId: project.id,
    title,
    location,
    generatedAt: generated.toISOString(),
    shots,
    imageIssues,
    ...(attribution ? { attribution } : {}),
  });
}
