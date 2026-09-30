import { publicSourceLabel, type SceneDescriptor } from "@oculo/scene-schema";

export type VideoAttribution = SceneDescriptor["attribution"];
export const VIDEO_MODIFICATION_NOTE =
  "Changes: Camera framing, lens settings, and animated motion rendered in Oculo.";

/** Plain text survives MP4 metadata and stays readable in the preview. */
export function videoAttributionText(attribution: VideoAttribution): string | undefined {
  if (!attribution) return undefined;
  return [
    publicSourceLabel(attribution.text),
    publicSourceLabel(attribution.url ?? null)
      ? `Source: ${publicSourceLabel(attribution.url ?? null)}`
      : undefined,
    publicSourceLabel(attribution.license ?? null)
      ? `License: ${publicSourceLabel(attribution.license ?? null)}`
      : undefined,
    publicSourceLabel(attribution.licenseUrl ?? null)
      ? `License URL: ${publicSourceLabel(attribution.licenseUrl ?? null)}`
      : undefined,
    VIDEO_MODIFICATION_NOTE,
  ]
    .filter(Boolean)
    .join("\n");
}
