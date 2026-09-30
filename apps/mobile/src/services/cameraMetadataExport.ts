import { stringifyShotPlan } from "@oculo/scene-schema";
import type { SceneWorkspace } from "../types/project";
import type { ShareArtifact } from "./SharingService";

/** Keeps only characters every share target accepts in a filename. */
export function safeFileStem(value: string, fallback = "Oculo"): string {
  const stem = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} _().-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return stem || fallback;
}

/**
 * Portable camera data for one scene: every shot's pose, lens, and notes plus the move.
 * Uses the versioned OculoShotPlan format, which strips local paths and access URLs.
 */
export function cameraMetadataArtifact(workspace: SceneWorkspace): ShareArtifact {
  const json = stringifyShotPlan(workspace);
  const name = `${safeFileStem(`${workspace.name} - ${workspace.projectSceneName}`)} camera data.json`;
  return {
    name,
    mimeType: "application/json",
    blob: new Blob([json], { type: "application/json" }),
  };
}
