import type { SceneDescriptor } from "@oculo/scene-schema";
import type { WebGLRenderer } from "three";

export type Vector3Tuple = readonly [x: number, y: number, z: number];
export type QuaternionTuple = readonly [x: number, y: number, z: number, w: number];

export interface CameraState {
  readonly position: Vector3Tuple;
  readonly quaternion: QuaternionTuple;
  readonly verticalFovDegrees: number;
  /** Output width / height, independent of the display viewport. */
  readonly aspectRatio: number;
  readonly near: number;
  readonly far: number;
}

export interface PerformanceSample {
  readonly sceneId?: string;
  readonly assetQualityVariant?: string;
  readonly assetSizeBytes?: number;
  readonly deviceUserAgent: string;
  readonly loadDurationMs?: number;
  readonly timeToFirstFrameMs?: number;
  readonly timestampMs: number;
  readonly frameDurationMs: number;
  readonly framesPerSecond: number;
  readonly rollingAverageFps: number;
  readonly frameTimeP95Ms?: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
  readonly geometries: number;
  readonly textures: number;
}

export type SplatUrlResolver = (descriptor: SceneDescriptor) => string | URL;

export type CameraStateListener = (state: CameraState) => void;
export type PerformanceSampleListener = (sample: PerformanceSample) => void;

export function performanceSampleFromRenderer(
  renderer: WebGLRenderer,
  timestampMs: number,
  frameDurationMs: number,
  context: {
    sceneId?: string;
    assetQualityVariant?: string;
    assetSizeBytes?: number;
    loadDurationMs?: number;
    timeToFirstFrameMs?: number;
    frameDurationsMs?: readonly number[];
    deviceUserAgent?: string;
  } = {},
): PerformanceSample {
  const { memory, render } = renderer.info;
  const frameDurations = context.frameDurationsMs?.filter((duration) => duration > 0) ?? [];
  const averageFrameMs =
    frameDurations.length > 0
      ? frameDurations.reduce((total, duration) => total + duration, 0) / frameDurations.length
      : frameDurationMs;
  const sortedFrameDurations = [...frameDurations].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedFrameDurations.length * 0.95) - 1);
  return {
    ...(context.sceneId === undefined ? {} : { sceneId: context.sceneId }),
    ...(context.assetQualityVariant === undefined
      ? {}
      : { assetQualityVariant: context.assetQualityVariant }),
    ...(context.assetSizeBytes === undefined ? {} : { assetSizeBytes: context.assetSizeBytes }),
    deviceUserAgent: context.deviceUserAgent ?? globalThis.navigator?.userAgent ?? "unknown",
    ...(context.loadDurationMs === undefined ? {} : { loadDurationMs: context.loadDurationMs }),
    ...(context.timeToFirstFrameMs === undefined
      ? {}
      : { timeToFirstFrameMs: context.timeToFirstFrameMs }),
    timestampMs,
    frameDurationMs,
    framesPerSecond: frameDurationMs > 0 ? 1000 / frameDurationMs : 0,
    rollingAverageFps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
    ...(sortedFrameDurations.length === 0
      ? {}
      : { frameTimeP95Ms: sortedFrameDurations[p95Index]! }),
    drawCalls: render.calls,
    triangles: render.triangles,
    points: render.points,
    lines: render.lines,
    geometries: memory.geometries,
    textures: memory.textures,
  };
}

export type { SceneDescriptor };
